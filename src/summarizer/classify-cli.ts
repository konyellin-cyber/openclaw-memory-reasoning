/**
 * CLI 入口 — 手动触发入库归类
 *
 * 用法：
 *   npx tsx src/summarizer/classify-cli.ts           # 全量归类
 *   npx tsx src/summarizer/classify-cli.ts --dry-run  # 预览（不写入）
 */

import { classifyCards } from "./classifier.js";
import { getStats } from "../knowledge/graph.js";
import { parseArgs } from "node:util";

const DATA_DIR = process.env.DATA_DIR ?? `${process.env.HOME}/.openclaw/personal-rec`;

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
  },
});

const logger = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

async function main() {
  // 显示入库前状态
  const beforeStats = await getStats(DATA_DIR);
  logger.info(`[classify-cli] Before: ${JSON.stringify(beforeStats)}`);

  if (values["dry-run"]) {
    logger.info("[classify-cli] Dry run — no changes will be made");
    return;
  }

  const result = await classifyCards(DATA_DIR, undefined, { logger });
  logger.info(`[classify-cli] Result: ${JSON.stringify(result, null, 2)}`);

  // 显示入库后状态
  const afterStats = await getStats(DATA_DIR);
  logger.info(`[classify-cli] After: ${JSON.stringify(afterStats)}`);
}

main().catch((err) => {
  console.error("[classify-cli] Fatal:", err);
  process.exit(1);
});
