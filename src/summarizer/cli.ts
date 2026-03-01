/**
 * CLI 入口 — 手动触发摘要卡生成
 *
 * 用法：
 *   npx tsx src/summarizer/cli.ts --limit 10 --provider alibaba --model qwen3.5-plus
 *   npx tsx src/summarizer/cli.ts --days 7
 *   npx tsx src/summarizer/cli.ts                       # 全量（所有未生成的）
 *
 * 注意：此脚本需要在 OpenClaw Gateway 进程中运行（或能 resolve openclaw 包）。
 * 独立运行时会报错 — 这是预期行为。
 * 推荐方式：deploy 后通过 Plugin service 触发。
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadFeedItems } from "../feeds/storage.js";
import { generateSummaryCards } from "./generator.js";

const DATA_DIR = process.env.DATA_DIR ?? `${process.env.HOME}/.openclaw/personal-rec`;
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG ?? `${process.env.HOME}/.openclaw/openclaw.json`;

const { values } = parseArgs({
  options: {
    limit: { type: "string", short: "l" },
    days: { type: "string", short: "d" },
    provider: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
  },
});

const limit = values.limit ? parseInt(values.limit, 10) : undefined;
const days = values.days ? parseInt(values.days, 10) : 30;
const provider = values.provider ?? process.env.PERSONAL_REC_PROVIDER ?? "alibaba";
const model = values.model ?? process.env.PERSONAL_REC_MODEL ?? "qwen3-coder-plus";

function loadConfig(): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf-8"));
  } catch {
    return undefined;
  }
}

const logger = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

async function main() {
  logger.info(`[cli] Loading feed items (${days} days)...`);
  const items = await loadFeedItems(DATA_DIR, days);
  logger.info(`[cli] Found ${items.length} papers`);

  if (items.length === 0) {
    logger.info("[cli] No papers to process");
    return;
  }

  const config = loadConfig();
  const agentDir = `${process.env.HOME}/.openclaw/agents/main/agent`;

  const result = await generateSummaryCards(DATA_DIR, items, {
    logger,
    limit,
    provider,
    model,
    config,
    agentDir,
  });
  logger.info(`[cli] Result: ${JSON.stringify(result, null, 2)}`);
}

main().catch((err) => {
  console.error("[cli] Fatal:", err);
  process.exit(1);
});
