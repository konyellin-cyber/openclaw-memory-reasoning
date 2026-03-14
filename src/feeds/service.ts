import { fetchAndParseFeed, type FeedItem } from "./parser.js";
import { saveFeedItems, loadFeedItems, getDataDir } from "./storage.js";
import { generateSummaryCards } from "../summarizer/generator.js";
import { classifyCards } from "../summarizer/classifier.js";
import { triggerReorgIfNeeded } from "../knowledge/trigger.js";
import { runProactiveSearch } from "../search/pipeline.js";

interface ServiceLogger {
  info: (msg: string) => void;
  warn?: (msg: string) => void;
  error: (msg: string) => void;
}

interface ServiceOpts {
  feeds: string[];
  intervalHours: number;
  fetchDays: number;
  logger: ServiceLogger;
  /** LLM provider for summary card generation */
  provider?: string;
  /** LLM model for summary card generation */
  model?: string;
  /** OpenClaw agent dir (for auth-profiles resolution) */
  agentDir?: string;
  /** OpenClaw config (for custom provider apiKey) */
  config?: Record<string, unknown>;
  /** 是否启用主动搜索（默认 true） */
  enableProactiveSearch?: boolean;
  /** 每轮最多搜索的 query 数（默认 30） */
  searchLimit?: number;
  /** 每个 query 返回的论文数（默认 10） */
  searchPerQuery?: number;
}

export function createFeedService(opts: ServiceOpts) {
  let timer: ReturnType<typeof setInterval> | null = null;

  const fullLogger = {
    info: opts.logger.info,
    warn: opts.logger.warn ?? opts.logger.info,
    error: opts.logger.error,
  };

  async function fetchAll(stateDir: string) {
    const dataDir = getDataDir(stateDir);
    let totalItems = 0;

    for (const feedUrl of opts.feeds) {
      try {
        const items = await fetchAndParseFeed(feedUrl, opts.fetchDays);
        await saveFeedItems(dataDir, items, feedUrl);
        totalItems += items.length;
        opts.logger.info(
          `[personal-rec] fetched ${items.length} items from ${feedUrl}`,
        );
      } catch (err) {
        opts.logger.error(
          `[personal-rec] failed to fetch ${feedUrl}: ${err}`,
        );
      }
    }

    // Step 6: 拉取后自动生成摘要卡 + 入库归类
    if (totalItems > 0) {
      await postFetchPipeline(dataDir);
    }

    return totalItems;
  }

  /**
   * 拉取后流水线：摘要卡生成 → 入库归类 → 触发检查
   * 非阻塞：任何失败只 log 不中断 service
   */
  async function postFetchPipeline(dataDir: string) {
    try {
      // 加载最近的论文
      const items = await loadFeedItems(dataDir, opts.fetchDays);
      if (items.length === 0) return;

      // 生成摘要卡（已有的会自动 skip）
      const genResult = await generateSummaryCards(dataDir, items, {
        logger: fullLogger,
        provider: opts.provider,
        model: opts.model,
        agentDir: opts.agentDir,
        config: opts.config,
      });
      fullLogger.info(
        `[personal-rec] pipeline: generated ${genResult.generated} cards (${genResult.skipped} skipped, ${genResult.failed} failed)`,
      );

      // 入库归类（已入库的会自动 skip，Phase 2 会用 LLM 选节点）
      if (genResult.generated > 0) {
        const classResult = await classifyCards(dataDir, undefined, {
          logger: fullLogger,
          provider: opts.provider,
          model: opts.model,
          agentDir: opts.agentDir,
          config: opts.config,
        });
        fullLogger.info(
          `[personal-rec] pipeline: classified ${classResult.classified} papers (${classResult.skipped} skipped)`,
        );

        // Phase 3: 归类后检查是否需要自动重整
        if (classResult.classified > 0) {
          try {
            fullLogger.info("[personal-rec] pipeline: checking reorg trigger conditions...");
            await triggerReorgIfNeeded(dataDir, {
              logger: fullLogger,
              provider: opts.provider,
              model: opts.model,
              agentDir: opts.agentDir,
              config: opts.config,
            });
          } catch (triggerErr) {
            fullLogger.error(`[personal-rec] pipeline: trigger check error: ${triggerErr}`);
          }
        }
      }

      // Phase 5: 主动搜索（内部驱动外部检索）
      if (opts.enableProactiveSearch !== false) {
        try {
          await runProactiveSearchWithThrottle(dataDir);
        } catch (searchErr) {
          fullLogger.error(`[personal-rec] pipeline: proactive search error: ${searchErr}`);
        }
      }
    } catch (err) {
      fullLogger.error(`[personal-rec] pipeline error: ${err}`);
    }
  }

  /**
   * 主动搜索（带节流 + 超时保护）
   * - 对比 current-focus.json 的 generatedAt 与上次搜索时间，快照未更新则跳过
   * - 整体 5 分钟超时
   */
  async function runProactiveSearchWithThrottle(dataDir: string): Promise<void> {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const { existsSync } = await import("node:fs");

    const indexDir = join(homedir(), ".openclaw", "memory-index");
    const snapshotPath = join(indexDir, "snapshot", "current-focus.json");
    const searchStatePath = join(indexDir, "search-state.json");

    // 检查快照是否存在
    if (!existsSync(snapshotPath)) {
      fullLogger.info("[personal-rec] proactive search: no snapshot found, skipping");
      return;
    }

    // 节流：对比快照时间与上次搜索时间
    try {
      const snapshotRaw = await readFile(snapshotPath, "utf-8");
      const snapshot = JSON.parse(snapshotRaw) as { generatedAt?: string };
      const snapshotTime = snapshot.generatedAt ?? "";

      if (existsSync(searchStatePath)) {
        const stateRaw = await readFile(searchStatePath, "utf-8");
        const state = JSON.parse(stateRaw) as { lastSearchAt?: string; snapshotTime?: string };

        if (state.snapshotTime === snapshotTime) {
          fullLogger.info("[personal-rec] proactive search: snapshot unchanged, throttled");
          return;
        }
      }

      // 执行搜索（5 分钟超时）
      fullLogger.info("[personal-rec] proactive search: starting...");

      const timeoutMs = 5 * 60 * 1000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("proactive search timeout (5min)")), timeoutMs),
      );

      const searchPromise = runProactiveSearch({
        dataDir,
        snapshotPath,
        searchLimit: opts.searchLimit ?? 30,
        perQueryLimit: opts.searchPerQuery ?? 10,
        provider: opts.provider,
        model: opts.model,
        agentDir: opts.agentDir,
        config: opts.config,
        logger: fullLogger,
      });

      const result = await Promise.race([searchPromise, timeoutPromise]);

      fullLogger.info(
        `[personal-rec] proactive search done: ${result.dedupStats.newCount} new papers in ${(result.totalDurationMs / 1000).toFixed(1)}s`,
      );

      // 更新搜索状态
      const searchState = {
        lastSearchAt: new Date().toISOString(),
        snapshotTime,
        lastResult: {
          queries: result.queryResult.queries.length,
          newPapers: result.dedupStats.newCount,
          durationMs: result.totalDurationMs,
        },
      };
      await writeFile(searchStatePath, JSON.stringify(searchState, null, 2), "utf-8");
    } catch (err) {
      fullLogger.error(`[personal-rec] proactive search failed: ${err}`);
    }
  }

  return {
    id: "personal-rec-feed-fetcher",

    async start(ctx: { stateDir: string }) {
      opts.logger.info("[personal-rec] feed service starting...");

      // Fetch immediately on start
      await fetchAll(ctx.stateDir);

      // Then fetch periodically
      const intervalMs = opts.intervalHours * 60 * 60 * 1000;
      timer = setInterval(() => {
        void fetchAll(ctx.stateDir);
      }, intervalMs);
      timer.unref?.();

      opts.logger.info(
        `[personal-rec] feed service started — next fetch in ${opts.intervalHours}h`,
      );
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      opts.logger.info("[personal-rec] feed service stopped");
    },
  };
}
