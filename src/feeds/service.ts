import { fetchAndParseFeed, type FeedItem } from "./parser.js";
import { saveFeedItems, getDataDir } from "./storage.js";

interface ServiceOpts {
  feeds: string[];
  intervalHours: number;
  fetchDays: number;
  logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export function createFeedService(opts: ServiceOpts) {
  let timer: ReturnType<typeof setInterval> | null = null;

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

    return totalItems;
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
