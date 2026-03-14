/**
 * 主动搜索管道 — Phase 5.3
 *
 * 端到端编排：
 * 1. loadFocusSnapshot() — 加载快照
 * 2. generateQueries() — LLM 生成 query
 * 3. 遍历 query，逐个调用 searchPapers()（串行，遵守速率限制）
 * 4. deduplicateResults() — 去重
 * 5. toFeedItems() — 转换格式
 * 6. generateSummaryCards() — 复用现有摘要卡生成
 * 7. classifyCards() — 复用现有归类
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { generateQueries, type QueryResult, type QueryGeneratorOpts } from "../query/generator.js";
import { searchPapers, type SearchResult, type SearchOpts } from "./semantic-scholar.js";
import { deduplicateResults, deriveCardId } from "./deduplicator.js";
import { generateSummaryCards } from "../summarizer/generator.js";
import { classifyCards } from "../summarizer/classifier.js";
import type { FeedItem } from "../feeds/parser.js";

// ─── Types ───

export interface PipelineLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface PipelineOpts {
  /** 数据根目录（默认 ~/.openclaw/personal-rec） */
  dataDir?: string;
  /** 快照路径 */
  snapshotPath?: string;
  /** 最大搜索 query 数 */
  searchLimit?: number;
  /** 每个 query 返回的论文数（默认 10） */
  perQueryLimit?: number;
  /** LLM 相关 */
  provider?: string;
  model?: string;
  agentDir?: string;
  config?: Record<string, unknown>;
  /** Semantic Scholar API Key */
  apiKey?: string;
  /** 只生成 query，不执行搜索 */
  queryOnly?: boolean;
  /** 只到去重步骤，不调用摘要卡生成和归类 */
  dryRun?: boolean;
  /** 只处理前 N 个活跃节点 */
  nodeLimit?: number;
  /** 日志 */
  logger?: PipelineLogger;
}

export interface PipelineResult {
  /** query 生成结果 */
  queryResult: QueryResult;
  /** 搜索阶段统计 */
  searchStats: {
    totalQueries: number;
    totalPapersFound: number;
    queriesWithResults: number;
    queriesEmpty: number;
  };
  /** 去重统计 */
  dedupStats: {
    totalSearched: number;
    batchDuplicates: number;
    existingDuplicates: number;
    newCount: number;
  };
  /** 入库统计（dryRun 时为 null） */
  ingestStats: {
    cardsGenerated: number;
    cardsSkipped: number;
    cardsFailed: number;
    classified: number;
    classifySkipped: number;
    classifyFailed: number;
  } | null;
  /** 总耗时 */
  totalDurationMs: number;
}

// ─── Core ───

export async function runProactiveSearch(opts: PipelineOpts = {}): Promise<PipelineResult> {
  const startTime = Date.now();
  const logger = opts.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const dataDir = opts.dataDir ?? join(homedir(), ".openclaw", "personal-rec");
  const perQueryLimit = opts.perQueryLimit ?? 10;

  // ── Stage 1: 生成 Query ──
  logger.info(`[proactive-search] Stage 1: Generating search queries...`);

  const queryOpts: QueryGeneratorOpts = {
    snapshotPath: opts.snapshotPath,
    limit: opts.nodeLimit,
    provider: opts.provider,
    model: opts.model,
    agentDir: opts.agentDir,
    config: opts.config,
    logger,
  };

  const queryResult = await generateQueries(queryOpts);
  logger.info(`[proactive-search] Stage 1 done: ${queryResult.queries.length} queries generated`);

  if (opts.queryOnly) {
    return {
      queryResult,
      searchStats: { totalQueries: 0, totalPapersFound: 0, queriesWithResults: 0, queriesEmpty: 0 },
      dedupStats: { totalSearched: 0, batchDuplicates: 0, existingDuplicates: 0, newCount: 0 },
      ingestStats: null,
      totalDurationMs: Date.now() - startTime,
    };
  }

  // ── Stage 2: 搜索论文 ──
  logger.info(`[proactive-search] Stage 2: Searching Semantic Scholar...`);

  const queries = opts.searchLimit
    ? queryResult.queries.slice(0, opts.searchLimit)
    : queryResult.queries;

  const allResults: SearchResult[] = [];
  let queriesWithResults = 0;
  let queriesEmpty = 0;

  const searchOpts: SearchOpts = {
    limit: perQueryLimit,
    apiKey: opts.apiKey,
    logger,
  };

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    logger.info(`[proactive-search] [${i + 1}/${queries.length}] Searching: "${q.text}"`);

    const results = await searchPapers(q.text, searchOpts);
    allResults.push(...results);

    if (results.length > 0) {
      queriesWithResults++;
    } else {
      queriesEmpty++;
    }
  }

  const searchStats = {
    totalQueries: queries.length,
    totalPapersFound: allResults.length,
    queriesWithResults,
    queriesEmpty,
  };
  logger.info(`[proactive-search] Stage 2 done: ${allResults.length} papers found from ${queries.length} queries`);

  // ── Stage 3: 去重 ──
  logger.info(`[proactive-search] Stage 3: Deduplicating...`);

  const dedupResult = await deduplicateResults(allResults, dataDir);
  const dedupStats = dedupResult.stats;

  logger.info(
    `[proactive-search] Stage 3 done: ${dedupStats.newCount} new papers ` +
    `(${dedupStats.batchDuplicates} batch dups, ${dedupStats.existingDuplicates} existing dups)`,
  );

  if (opts.dryRun || dedupResult.newPapers.length === 0) {
    if (opts.dryRun) {
      logger.info(`[proactive-search] Dry run — skipping ingestion`);
    } else {
      logger.info(`[proactive-search] No new papers to ingest`);
    }
    return {
      queryResult,
      searchStats,
      dedupStats,
      ingestStats: null,
      totalDurationMs: Date.now() - startTime,
    };
  }

  // ── Stage 4: 转 FeedItem → 摘要卡生成 ──
  logger.info(`[proactive-search] Stage 4: Generating summary cards for ${dedupResult.newPapers.length} papers...`);

  const feedItems = dedupResult.newPapers.map(toFeedItem);

  const genResult = await generateSummaryCards(dataDir, feedItems, {
    logger,
    provider: opts.provider,
    model: opts.model,
    agentDir: opts.agentDir,
    config: opts.config,
  });

  logger.info(
    `[proactive-search] Stage 4 done: ${genResult.generated} cards generated ` +
    `(${genResult.skipped} skipped, ${genResult.failed} failed)`,
  );

  // ── Stage 5: 归类入库 ──
  logger.info(`[proactive-search] Stage 5: Classifying cards...`);

  const newCardIds = feedItems.map((item) => item.id);
  const classResult = await classifyCards(dataDir, newCardIds, {
    logger,
    provider: opts.provider,
    model: opts.model,
    agentDir: opts.agentDir,
    config: opts.config,
  });

  logger.info(
    `[proactive-search] Stage 5 done: ${classResult.classified} classified ` +
    `(${classResult.skipped} skipped, ${classResult.failed} failed)`,
  );

  const totalDurationMs = Date.now() - startTime;
  logger.info(`[proactive-search] Pipeline complete in ${(totalDurationMs / 1000).toFixed(1)}s`);

  return {
    queryResult,
    searchStats,
    dedupStats,
    ingestStats: {
      cardsGenerated: genResult.generated,
      cardsSkipped: genResult.skipped,
      cardsFailed: genResult.failed,
      classified: classResult.classified,
      classifySkipped: classResult.skipped,
      classifyFailed: classResult.failed,
    },
    totalDurationMs,
  };
}

// ─── FeedItem conversion ───

/**
 * SearchResult → FeedItem 转换
 */
function toFeedItem(result: SearchResult): FeedItem {
  return {
    id: deriveCardId(result),
    title: result.title,
    authors: result.authors,
    abstract: result.abstract || "[abstract not available]",
    date: result.year > 0 ? `${result.year}-01-01` : new Date().toISOString().slice(0, 10),
    source: "semantic-scholar",
    url: result.url,
  };
}
