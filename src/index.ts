import { readFileSync } from "node:fs";
import { createFeedService } from "./feeds/service.js";
import { setStateDir } from "./tools/search-feed.js";
import { loadRunEmbeddedPiAgent } from "./llm/loader.js";

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

const DEFAULT_FEEDS = [
  "https://rss.arxiv.org/rss/cs.IR",
  "https://rss.arxiv.org/rss/cs.AI",
  "https://rss.arxiv.org/rss/cs.LG",
  "https://rss.arxiv.org/rss/cs.SI",  // Social & Information Networks
  "https://rss.arxiv.org/rss/cs.CL",  // Computation and Language (NLP)
  "https://rss.arxiv.org/rss/cs.CV",  // Computer Vision
];
const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_FETCH_DAYS = 3;

// LLM 配置：环境变量 > 硬编码默认值
const DEFAULT_SUMMARY_PROVIDER = process.env.PERSONAL_REC_PROVIDER ?? "alibaba";
const DEFAULT_SUMMARY_MODEL = process.env.PERSONAL_REC_MODEL ?? "qwen3-coder-plus";

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

    // 读取 openclaw 全局 config（用于 custom provider apiKey 解析）
    let openclawConfig: Record<string, unknown> | undefined;
    try {
      const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;
      openclawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // non-critical
    }

    const agentDir = `${process.env.HOME}/.openclaw/agents/main/agent`;

    const feedService = createFeedService({
      feeds,
      intervalHours,
      fetchDays,
      logger: api.logger,
      provider: DEFAULT_SUMMARY_PROVIDER,
      model: DEFAULT_SUMMARY_MODEL,
      agentDir,
      config: openclawConfig,
    });

    // Wrap service to capture stateDir + verify LLM availability
    api.registerService({
      ...feedService,
      async start(ctx: { stateDir: string; config: unknown; logger: { info: (m: string) => void; error: (m: string) => void } }) {
        setStateDir(ctx.stateDir);

        // Step 0 验证: runEmbeddedPiAgent 是否可加载
        try {
          const fn = await loadRunEmbeddedPiAgent();
          api.logger.info(`[personal-rec] ✅ runEmbeddedPiAgent loaded (typeof=${typeof fn})`);
        } catch (err) {
          api.logger.warn(`[personal-rec] ⚠️ runEmbeddedPiAgent not available: ${(err as Error).message}`);
        }

        return feedService.start(ctx);
      },
    });

    // navigate_knowledge 已迁移到 semantic-navigator Skill (Phase R.5)
    // 不再注册为 Plugin tool，导航功能通过 Skill 提供
    api.logger.info(
      `[personal-rec] ℹ️ navigate_knowledge tool 已废弃，请使用 semantic-navigator Skill (--source papers|memory)`,
    );

    // search_feed 降级为内部工具，不再对外注册（Phase 2 Step 5）
    // search_feed 代码保留，仅供冷启动兜底时内部调用

    api.logger.info(
      `[personal-rec] registered — ${feeds.length} feed(s), interval ${intervalHours}h`,
    );
  },
};

export default plugin;
