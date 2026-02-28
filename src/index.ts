import { createFeedService } from "./feeds/service.js";
import { createSearchFeedTool, setStateDir } from "./tools/search-feed.js";

interface PluginApi {
  id: string;
  pluginConfig?: Record<string, unknown>;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerTool: (tool: unknown, opts?: { name?: string }) => void;
  registerService: (service: {
    id: string;
    start: (ctx: {
      config: unknown;
      stateDir: string;
      logger: { info: (m: string) => void; error: (m: string) => void };
    }) => void | Promise<void>;
    stop?: (ctx: unknown) => void | Promise<void>;
  }) => void;
}

interface PluginConfig {
  feeds?: string[];
  fetchIntervalHours?: number;
  fetchDays?: number;
}

const DEFAULT_FEEDS = ["https://rss.arxiv.org/rss/cs.IR"];
const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_FETCH_DAYS = 3;

const plugin = {
  id: "personal-rec",
  name: "Personal Recommendation",
  description:
    "LLM-powered personal feed recommendation — searches recent papers during conversations when relevant.",

  register(api: PluginApi) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const feeds = config.feeds ?? DEFAULT_FEEDS;
    const intervalHours = config.fetchIntervalHours ?? DEFAULT_INTERVAL_HOURS;
    const fetchDays = config.fetchDays ?? DEFAULT_FETCH_DAYS;

    const feedService = createFeedService({ feeds, intervalHours, fetchDays, logger: api.logger });

    // Wrap service to capture stateDir for tool use
    api.registerService({
      ...feedService,
      async start(ctx: { stateDir: string; config: unknown; logger: { info: (m: string) => void; error: (m: string) => void } }) {
        setStateDir(ctx.stateDir);
        return feedService.start(ctx);
      },
    });

    api.registerTool(createSearchFeedTool(), { name: "search_feed" });

    api.logger.info(
      `[personal-rec] registered — ${feeds.length} feed(s), interval ${intervalHours}h`,
    );
  },
};

export default plugin;
