import { fetchAndParseFeed, type FeedItem } from "./parser.js";
import { saveFeedItems, loadFeedItems, getDataDir } from "./storage.js";
import { generateSummaryCards } from "../summarizer/generator.js";
import { classifyCards } from "../summarizer/classifier.js";

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
   * 拉取后流水线：摘要卡生成 → 入库归类
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
      }
    } catch (err) {
      fullLogger.error(`[personal-rec] pipeline error: ${err}`);
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
