/**
 * CLI 入口 — 手动触发内部记忆摘要卡 LLM 增强
 *
 * 用法：
 *   npx tsx src/memory/summarizer-cli.ts --limit 10
 *   npx tsx src/memory/summarizer-cli.ts --dry-run        # 预览，不调用 LLM
 *   npx tsx src/memory/summarizer-cli.ts                   # 全量增强所有未处理的卡片
 *
 * 注意：此脚本需要能 resolve openclaw 包（Gateway 运行时或独立安装）。
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { homedir } from "node:os";
import { enhanceMemoryCards } from "./summarizer.js";

const INDEX_DIR = process.env.MEMORY_INDEX_DIR ?? join(homedir(), ".openclaw", "memory-index");
const MEMORY_DIR = process.env.MEMORY_DIR ?? join(homedir(), ".openclaw", "workspace", "memory");
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG ?? join(homedir(), ".openclaw", "openclaw.json");

const { values } = parseArgs({
  options: {
    limit: { type: "string", short: "l" },
    provider: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    "dry-run": { type: "boolean" },
  },
});

const limit = values.limit ? parseInt(values.limit, 10) : undefined;
const provider = values.provider ?? process.env.PERSONAL_REC_PROVIDER ?? "alibaba";
const model = values.model ?? process.env.PERSONAL_REC_MODEL ?? "qwen3-coder-plus";
const dryRun = values["dry-run"] ?? false;

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
  logger.info(`[memory-summarizer-cli] 索引目录: ${INDEX_DIR}`);
  logger.info(`[memory-summarizer-cli] 记忆目录: ${MEMORY_DIR}`);
  if (dryRun) {
    logger.info(`[memory-summarizer-cli] 🔍 Dry-run 模式（不调用 LLM）`);
  }
  if (limit) {
    logger.info(`[memory-summarizer-cli] 限制: 最多处理 ${limit} 张卡片`);
  }

  const config = loadConfig();
  const agentDir = join(homedir(), ".openclaw", "agents", "main", "agent");

  const result = await enhanceMemoryCards(INDEX_DIR, MEMORY_DIR, {
    logger,
    limit,
    provider,
    model,
    config,
    agentDir,
    dryRun,
  });

  logger.info(`[memory-summarizer-cli] 结果: ${JSON.stringify(result, null, 2)}`);
}

main().catch((err) => {
  console.error("[memory-summarizer-cli] Fatal:", err);
  process.exit(1);
});
