/**
 * 强制归类脚本 — 对所有未归类的摘要卡进行归类
 *
 * 使用方式: cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/force-classify.js
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT = dirname(dirname(dirname(__filename)));

async function main() {
const { classifyCards } = await import(PROJECT + "/dist/summarizer/classifier.js");
const { getDataDir } = await import(PROJECT + "/dist/feeds/storage.js");

const stateDir = process.env.HOME + "/.openclaw";
const dataDir = getDataDir(stateDir);
const agentDir = join(stateDir, "agents", "main", "agent");

let openclawConfig: Record<string, unknown> = {};
try {
  openclawConfig = JSON.parse(readFileSync(join(stateDir, "openclaw.json"), "utf-8"));
} catch { /* non-critical */ }

const logger = {
  info: (msg: string) => console.log(`[INFO] ${msg}`),
  warn: (msg: string) => console.warn(`[WARN] ${msg}`),
  error: (msg: string) => console.error(`[ERROR] ${msg}`),
  debug: (_msg: string) => {},
};

console.log("\n━━━ 强制归类所有未归类摘要卡 ━━━\n");

const classResult = await classifyCards(dataDir, undefined, {
  logger: logger as any,
  provider: "alibaba",
  model: "qwen3-coder-plus",
  agentDir,
  config: openclawConfig,
});

console.log(`\n✅ 归类: ${classResult.classified}, 跳过: ${classResult.skipped}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
