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
    const feedStats: Array<{ url: string; fetched: number; error?: string }> = [];

    opts.logger.info(`[personal-rec] 📥 RSS fetch started — ${opts.feeds.length} feeds, looking back ${opts.fetchDays} days`);

    for (const feedUrl of opts.feeds) {
      try {
        const items = await fetchAndParseFeed(feedUrl, opts.fetchDays);
        await saveFeedItems(dataDir, items, feedUrl);
        totalItems += items.length;
        feedStats.push({ url: feedUrl, fetched: items.length });
        opts.logger.info(
          `[personal-rec] ✅ fetched ${items.length} items from ${feedUrl}`,
        );
      } catch (err) {
        feedStats.push({ url: feedUrl, fetched: 0, error: String(err) });
        opts.logger.error(
          `[personal-rec] ❌ failed to fetch ${feedUrl}: ${err}`,
        );
      }
    }

    opts.logger.info(
      `[personal-rec] 📊 RSS fetch summary: ${totalItems} total items from ${feedStats.filter(s => !s.error).length}/${opts.feeds.length} feeds`,
    );

    // Step 6: 拉取后自动生成摘要卡 + 入库归类
    if (totalItems > 0) {
      await postFetchPipeline(dataDir);
    } else {
      opts.logger.info(`[personal-rec] ⏭️ no new items, skipping pipeline`);
    }

    return totalItems;
  }

  /**
   * 拉取后流水线：摘要卡生成 → 入库归类 → 触发检查
   * 非阻塞：任何失败只 log 不中断 service
   */
  async function postFetchPipeline(dataDir: string) {
    const pipelineStart = Date.now();
    fullLogger.info(`[personal-rec] 🚀 Pipeline started — processing ${dataDir}`);

    try {
      // 加载最近的论文
      const items = await loadFeedItems(dataDir, opts.fetchDays);
      if (items.length === 0) {
        fullLogger.info(`[personal-rec] ⏭️ no items to process, pipeline finished`);
        return;
      }
      fullLogger.info(`[personal-rec] 📄 Loaded ${items.length} items for pipeline`);

      // 生成摘要卡（已有的会自动 skip）
      const genStart = Date.now();
      fullLogger.info(`[personal-rec] 🤖 Stage 1: Generating summary cards...`);
      const genResult = await generateSummaryCards(dataDir, items, {
        logger: fullLogger,
        provider: opts.provider,
        model: opts.model,
        agentDir: opts.agentDir,
        config: opts.config,
      });
      fullLogger.info(
        `[personal-rec] ✅ Stage 1 done in ${((Date.now() - genStart) / 1000).toFixed(1)}s: ${genResult.generated} generated, ${genResult.skipped} skipped (already exist), ${genResult.failed} failed`,
      );

      if (genResult.failed > 0) {
        fullLogger.warn(`[personal-rec] ⚠️ ${genResult.failed} cards failed to generate (check LLM logs)`);
      }

      // 入库归类（已入库的会自动 skip，Phase 2 会用 LLM 选节点）
      if (genResult.generated > 0) {
        const classStart = Date.now();
        fullLogger.info(`[personal-rec] 🗂️ Stage 2: Classifying papers into knowledge graph...`);
        const classResult = await classifyCards(dataDir, undefined, {
          logger: fullLogger,
          provider: opts.provider,
          model: opts.model,
          agentDir: opts.agentDir,
          config: opts.config,
        });
        fullLogger.info(
          `[personal-rec] ✅ Stage 2 done in ${((Date.now() - classStart) / 1000).toFixed(1)}s: ${classResult.classified} papers classified, ${classResult.skipped} skipped (already in graph)`,
        );

        // Phase 3: 归类后检查是否需要自动重整
        if (classResult.classified > 0) {
          try {
            const reorgStart = Date.now();
            fullLogger.info("[personal-rec] 🔄 Stage 3: Checking reorg trigger conditions...");
            await triggerReorgIfNeeded(dataDir, {
              logger: fullLogger,
              provider: opts.provider,
              model: opts.model,
              agentDir: opts.agentDir,
              config: opts.config,
            });
            fullLogger.info(`[personal-rec] ✅ Stage 3 done in ${((Date.now() - reorgStart) / 1000).toFixed(1)}s`);
          } catch (triggerErr) {
            fullLogger.error(`[personal-rec] ❌ Stage 3 failed: ${triggerErr}`);
          }
        }
      } else {
        fullLogger.info(`[personal-rec] ⏭️ Stage 2 skipped: no new cards to classify`);
      }

      // Phase 5: 主动搜索（内部驱动外部检索）
      if (opts.enableProactiveSearch !== false) {
        try {
          await runProactiveSearchWithThrottle(dataDir);
        } catch (searchErr) {
          fullLogger.error(`[personal-rec] ❌ Proactive search failed: ${searchErr}`);
        }
      }

      const totalDuration = ((Date.now() - pipelineStart) / 1000).toFixed(1);
      fullLogger.info(`[personal-rec] 🎉 Pipeline finished in ${totalDuration}s`);
    } catch (err) {
      fullLogger.error(`[personal-rec] ❌ Pipeline error: ${err}`);
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
      fullLogger.info("[personal-rec] 🔍 Phase 5: Proactive search — skipped (no snapshot found)");
      return;
    }

    // 节流：对比快照时间与上次搜索时间
    try {
      const snapshotRaw = await readFile(snapshotPath, "utf-8");
      const snapshot = JSON.parse(snapshotRaw) as { generatedAt?: string; activeNodes?: unknown[] };
      const snapshotTime = snapshot.generatedAt ?? "";

      fullLogger.info(
        `[personal-rec] 🔍 Phase 5: Proactive search — snapshot generated at ${snapshotTime} (${(snapshot.activeNodes as unknown[])?.length ?? 0} active nodes)`,
      );

      if (existsSync(searchStatePath)) {
        const stateRaw = await readFile(searchStatePath, "utf-8");
        const state = JSON.parse(stateRaw) as { lastSearchAt?: string; snapshotTime?: string };

        if (state.snapshotTime === snapshotTime) {
          fullLogger.info(
            `[personal-rec] 🔍 Phase 5: Proactive search — throttled (snapshot unchanged since last search at ${state.lastSearchAt})`,
          );
          return;
        }
      }

      // 执行搜索（5 分钟超时）
      const searchStart = Date.now();
      fullLogger.info("[personal-rec] 🔍 Phase 5: Proactive search — starting...");

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

      const searchDuration = ((Date.now() - searchStart) / 1000).toFixed(1);
      fullLogger.info(
        `[personal-rec] ✅ Phase 5 done in ${searchDuration}s: ${result.queryResult.queries.length} queries → ${result.dedupStats.newCount} new papers (after dedup)`,
      );

      // 更新搜索状态
      const searchState = {
        lastSearchAt: new Date().toISOString(),
        snapshotTime,
        lastResult: {
          queries: result.queryResult.queries.length,
          searchableNodes: result.queryResult.searchableNodes,
          filteredOutNodes: result.queryResult.filteredOutNodes.length,
          totalPapersSearched: result.dedupStats.totalSearched,
          duplicatesRemoved: result.dedupStats.batchDuplicates + result.dedupStats.existingDuplicates,
          newPapers: result.dedupStats.newCount,
          durationMs: result.totalDurationMs,
        },
      };
      await writeFile(searchStatePath, JSON.stringify(searchState, null, 2), "utf-8");
      fullLogger.info(
        `[personal-rec] 🔍 Phase 5: Search state saved → ${searchStatePath.replace(process.env.HOME ?? "", "~")}`,
      );
    } catch (err) {
      fullLogger.error(`[personal-rec] ❌ Phase 5 failed: ${err}`);
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
