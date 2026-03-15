/**
 * 检索 query 生成器 — Phase 5.1
 *
 * 读取 current-focus.json 活跃节点 → LLM 意图筛选 → LLM 生成英文学术检索 query → 跨节点去重
 *
 * Phase 5.1.1 改进：
 * - 新增意图筛选层（filterSearchableNodes）：LLM 一次调用判断哪些节点适合学术检索
 * - 改进 query prompt：强调从工作笔记中提取底层技术概念，而非翻译标题
 *
 * 输出：去重后的 query 列表（每个 query 带来源节点标注）
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { loadRunEmbeddedPiAgent, collectText, stripCodeFences } from "../llm/loader.js";
import type { FocusSnapshot, FocusNode } from "../memory/export-snapshot.js";

// ─── Types ───

export interface GeneratedQuery {
  text: string;
  sourceNodeId: string;
  sourceDescription: string;
}

export interface FilteredNode {
  nodeId: string;
  suitable: boolean;
  reason: string;
}

export interface QueryResult {
  generatedAt: string;
  totalNodes: number;
  /** 通过意图筛选的节点数 */
  searchableNodes: number;
  /** 被筛掉的节点 */
  filteredOutNodes: FilteredNode[];
  processedNodes: number;
  queriesBeforeDedup: number;
  queries: GeneratedQuery[];
}

export interface QueryGeneratorOpts {
  snapshotPath?: string;
  limit?: number;           // 只处理前 N 个活跃节点
  minItems?: number;        // 跳过 itemCount < N 的节点（默认 3）
  outputDir?: string;       // query 持久化目录
  skipFilter?: boolean;     // 跳过意图筛选（调试用）
  provider?: string;
  model?: string;
  agentDir?: string;
  config?: Record<string, unknown>;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ─── Prompts ───

// ── 意图筛选 Prompt ──

const FILTER_SYSTEM_PROMPT = `You are a search intent classifier. Given a list of a user's focus areas (from personal work notes), determine which ones are suitable for academic paper search on Semantic Scholar.

SUITABLE for academic search:
- Technical research directions (algorithms, architectures, models)
- Specific domain problems that have academic literature (recommendation systems, NLP, etc.)
- Technical methodologies and frameworks with research papers

NOT suitable for academic search:
- Team management, collaboration processes, HR activities
- Internal decision records, meeting notes, personnel info
- Project management, task tracking, documentation workflows
- Tool configuration, deployment operations, dev environment setup
- Daily conversation logs, personal facts/contacts

Output ONLY a JSON array (no markdown fence, no explanation):
[{"nodeId": "xxx", "suitable": true, "reason": "brief reason"}, ...]

You MUST include ALL nodes in the output. Do not skip any.`;

function buildFilterPrompt(nodes: FocusNode[]): string {
  const nodeList = nodes.map((n) => {
    const titles = n.sampleTitles.slice(0, 3).join("; ");
    return `- [${n.id}] ${n.description} | samples: ${titles}`;
  }).join("\n");

  return `Classify each focus area — is it suitable for searching academic papers on Semantic Scholar?

Focus areas:
${nodeList}

Output JSON array only (no markdown fence, no explanation, do not use any tools):
[{"nodeId": "...", "suitable": true/false, "reason": "..."}]`;
}

// ── Query 生成 Prompt ──

const QUERY_SYSTEM_PROMPT = `You are an academic search query assistant. You will receive a user's work notes about a technical area. Your job is to extract the UNDERLYING technical concepts and generate precise academic search queries.

CRITICAL: The input is work notes (project logs, meeting notes, experiment records), NOT academic abstracts. You must:
1. Look THROUGH the surface-level work descriptions to find the core technical concepts
2. Translate domain-specific jargon into academic terminology
3. Focus on searchable research topics, not the work activities themselves

Output ONLY a JSON object (no markdown fence, no explanation):
{"queries": ["query1", "query2", "query3"]}

Rules:
- Each query should be 2-5 English words, suitable for Semantic Scholar search
- Focus on specific technical concepts and methods, not broad topics
- Do NOT include: author names, generic terms like "survey"/"review", project names, internal tool names
- Queries should be diverse (cover different technical angles)
- Think: "What academic papers would help this person advance their technical work?"`;

function buildQueryPrompt(node: FocusNode): string {
  const titles = node.sampleTitles.slice(0, 5).join("\n  - ");
  return `Extract technical concepts and generate academic search queries from these work notes:

Technical area: ${node.id} — ${node.description}
Recent work note titles:
  - ${titles}

Remember: These are WORK NOTES, not paper titles. Extract the underlying technical concepts that would have academic papers. For example:
- "TIGER vs OneRec comparison" → "generative retrieval recommendation" or "tokenized ID sequential recommendation"
- "subscription feed image ranking tuning" → "multi-objective optimization ranking" or "image recommendation click-through prediction"
- "cold start sub-pool adaptation" → "cold start recommendation" or "user interest exploration"

Output JSON only (no markdown fence, no explanation, do not use any tools):
{"queries": ["query1", "query2"]}`;
}

// ─── Core ───

/**
 * 加载快照文件
 */
export async function loadSnapshot(snapshotPath?: string): Promise<FocusSnapshot> {
  const path = snapshotPath ?? join(homedir(), ".openclaw", "memory-index", "snapshot", "current-focus.json");
  if (!existsSync(path)) {
    throw new Error(`Snapshot not found: ${path}. Run export-snapshot first.`);
  }
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as FocusSnapshot;
}

/**
 * 创建临时 LLM session 并执行调用
 */
async function callLLM(
  runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>,
  prompt: string,
  systemPrompt: string,
  opts: { provider?: string; model?: string; agentDir?: string; config?: Record<string, unknown> },
  label: string,
): Promise<string> {
  const runId = randomUUID();
  const sessionId = `${label}-${runId.slice(0, 8)}`;

  const tmpDir = join(homedir(), ".openclaw", "memory-index", ".tmp-query-gen");
  await mkdir(tmpDir, { recursive: true });
  const workDir = join(tmpDir, sessionId);
  await mkdir(workDir, { recursive: true });
  const sessionFile = join(workDir, `${sessionId}.json`);

  const sessionHeader = {
    type: "session",
    version: 2,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: workDir,
  };
  const { writeFile: wf } = await import("node:fs/promises");
  await wf(sessionFile, `${JSON.stringify(sessionHeader)}\n`, "utf-8");

  try {
    const result = await runFn({
      sessionId,
      sessionFile,
      workspaceDir: workDir,
      prompt,
      extraSystemPrompt: systemPrompt,
      timeoutMs: 30_000,
      runId,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.config ? { config: opts.config } : {}),
    });

    const text = collectText(result.payloads);
    if (!text) throw new Error("LLM returned empty response");
    return stripCodeFences(text);
  } finally {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ─── Intent Filter ───

/**
 * LLM 一次调用，判断哪些活跃节点适合学术论文检索
 */
export async function filterSearchableNodes(
  runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>,
  nodes: FocusNode[],
  opts: QueryGeneratorOpts,
): Promise<{ searchable: FocusNode[]; filteredOut: FilteredNode[] }> {
  const logger = opts.logger ?? { info: console.log, warn: console.warn, error: console.error };

  const text = await callLLM(
    runFn,
    buildFilterPrompt(nodes),
    FILTER_SYSTEM_PROMPT,
    opts,
    "intent-filter",
  );

  // 解析 JSON 数组
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    logger.warn(`[intent-filter] Failed to parse filter result, falling back to all nodes. Raw: ${text.slice(0, 200)}`);
    return { searchable: nodes, filteredOut: [] };
  }

  let filterResults: FilteredNode[];
  try {
    filterResults = JSON.parse(arrayMatch[0]) as FilteredNode[];
  } catch {
    logger.warn(`[intent-filter] JSON parse failed, falling back to all nodes`);
    return { searchable: nodes, filteredOut: [] };
  }

  // 构建 suitable 集合
  const suitableSet = new Set<string>();
  const filteredOut: FilteredNode[] = [];

  for (const r of filterResults) {
    if (r.suitable) {
      suitableSet.add(r.nodeId);
    } else {
      filteredOut.push(r);
    }
  }

  // 未被 LLM 提及的节点默认保留（安全 fallback）
  const searchable = nodes.filter((n) => {
    const mentioned = filterResults.some((r) => r.nodeId === n.id);
    return !mentioned || suitableSet.has(n.id);
  });

  logger.info(`[intent-filter] ${searchable.length}/${nodes.length} nodes suitable for academic search`);
  for (const f of filteredOut) {
    logger.info(`[intent-filter]   ✗ [${f.nodeId}] ${f.reason}`);
  }

  return { searchable, filteredOut };
}

/**
 * 为所有活跃节点生成检索 query（含意图筛选）
 */
export async function generateQueries(opts: QueryGeneratorOpts = {}): Promise<QueryResult> {
  const logger = opts.logger ?? { info: console.log, warn: console.warn, error: console.error };
  const minItems = opts.minItems ?? 3;

  // 1. 加载快照
  const snapshot = await loadSnapshot(opts.snapshotPath);
  logger.info(`[query-gen] Loaded snapshot: ${snapshot.activeNodes.length} active nodes`);

  // 2. 基础筛选（卡片数阈值）
  let candidateNodes = snapshot.activeNodes.filter((n) => n.itemCount >= minItems);
  logger.info(`[query-gen] ${candidateNodes.length} nodes pass minItems=${minItems} filter`);

  // 3. 加载 LLM
  let runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>;
  try {
    runFn = await loadRunEmbeddedPiAgent();
  } catch (err) {
    throw new Error(`[query-gen] Cannot load LLM: ${(err as Error).message}`);
  }

  // 4. 意图筛选：LLM 判断哪些节点适合学术检索
  let filteredOutNodes: FilteredNode[] = [];
  if (!opts.skipFilter) {
    logger.info(`[query-gen] Stage 0: Intent filtering...`);
    const filterResult = await filterSearchableNodes(runFn, candidateNodes, opts);
    candidateNodes = filterResult.searchable;
    filteredOutNodes = filterResult.filteredOut;
  }

  // 5. limit 截断
  if (opts.limit) {
    candidateNodes = candidateNodes.slice(0, opts.limit);
  }
  logger.info(`[query-gen] Processing ${candidateNodes.length} searchable nodes`);

  // 6. 逐节点 LLM 生成 query
  const allQueries: GeneratedQuery[] = [];
  let processedNodes = 0;

  for (const node of candidateNodes) {
    try {
      const queries = await generateQueriesForNode(runFn, node, opts);
      for (const q of queries) {
        allQueries.push({
          text: q,
          sourceNodeId: node.id,
          sourceDescription: node.description,
        });
      }
      processedNodes++;
      logger.info(`[query-gen] [${processedNodes}/${candidateNodes.length}] ${node.id} → ${queries.length} queries: ${queries.join(", ")}`);
    } catch (err) {
      logger.warn(`[query-gen] [${processedNodes + 1}/${candidateNodes.length}] ${node.id} failed: ${(err as Error).message}`);
      processedNodes++;
    }
  }

  const queriesBeforeDedup = allQueries.length;
  logger.info(`[query-gen] Generated ${queriesBeforeDedup} queries before dedup`);

  // 7. 跨节点去重
  const deduped = deduplicateQueries(allQueries);
  logger.info(`[query-gen] After dedup: ${deduped.length} queries (removed ${queriesBeforeDedup - deduped.length})`);

  const result: QueryResult = {
    generatedAt: new Date().toISOString(),
    totalNodes: snapshot.activeNodes.length,
    searchableNodes: candidateNodes.length,
    filteredOutNodes,
    processedNodes,
    queriesBeforeDedup,
    queries: deduped,
  };

  // 8. 持久化
  const outputDir = opts.outputDir ?? join(homedir(), ".openclaw", "memory-index", "queries");
  await mkdir(outputDir, { recursive: true });
  const outputPath = join(outputDir, "latest.json");
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf-8");
  logger.info(`[query-gen] Saved to ${outputPath}`);

  return result;
}

// ─── Per-node LLM call ───

async function generateQueriesForNode(
  runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>,
  node: FocusNode,
  opts: QueryGeneratorOpts,
): Promise<string[]> {
  const text = await callLLM(
    runFn,
    buildQueryPrompt(node),
    QUERY_SYSTEM_PROMPT,
    opts,
    `query-gen-${node.id}`,
  );

  const jsonMatch = text.match(/\{[\s\S]*?"queries"[\s\S]*?\}/);
  if (!jsonMatch) {
    throw new Error(`No valid JSON: ${text.slice(0, 150)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as { queries?: string[] };
  const queries = (parsed.queries ?? [])
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .map((q) => q.trim())
    .slice(0, 3);

  return queries;
}

// ─── Deduplication ───

/**
 * 跨节点 query 去重：
 * 1. 归一化（lowercase + trim）
 * 2. 精确去重（完全相同合并）
 * 3. 子串包含检测（A 是 B 的子串 → 保留更长的 B）
 */
export function deduplicateQueries(queries: GeneratedQuery[]): GeneratedQuery[] {
  if (queries.length === 0) return [];

  // 归一化
  const normalized = queries.map((q) => ({
    ...q,
    _norm: q.text.toLowerCase().trim(),
  }));

  // 精确去重（保留第一个出现的）
  const seen = new Map<string, (typeof normalized)[0]>();
  for (const q of normalized) {
    if (!seen.has(q._norm)) {
      seen.set(q._norm, q);
    }
  }

  // 子串包含检测
  const unique = Array.from(seen.values());
  const toRemove = new Set<number>();

  for (let i = 0; i < unique.length; i++) {
    if (toRemove.has(i)) continue;
    for (let j = 0; j < unique.length; j++) {
      if (i === j || toRemove.has(j)) continue;
      // 如果 i 是 j 的子串且 i 更短，移除 i
      if (unique[j]._norm.includes(unique[i]._norm) && unique[i]._norm.length < unique[j]._norm.length) {
        toRemove.add(i);
        break;
      }
    }
  }

  return unique
    .filter((_, idx) => !toRemove.has(idx))
    .map(({ _norm, ...rest }) => rest);
}

// ─── CLI ───
// 注意：不使用顶层 await，因为 jiti 同步加载不支持
// CLI 入口已迁移到 src/query/generator-cli.ts
