/**
 * 论文更新管道 — 手动触发完整 fetch → summarize → classify → trigger 流程
 *
 * 使用方式: cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/run-pipeline.js
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT = dirname(dirname(dirname(__dirname)));

async function main() {
const { fetchAndParseFeed } = await import(PROJECT + "/dist/feeds/parser.js");
const { saveFeedItems, loadFeedItems, getDataDir } = await import(PROJECT + "/dist/feeds/storage.js");
const { generateSummaryCards } = await import(PROJECT + "/dist/summarizer/generator.js");
const { classifyCards } = await import(PROJECT + "/dist/summarizer/classifier.js");
const { triggerReorgIfNeeded } = await import(PROJECT + "/dist/knowledge/trigger.js");

const FEEDS = [
  "https://rss.arxiv.org/rss/cs.IR",
  "https://rss.arxiv.org/rss/cs.AI",
  "https://rss.arxiv.org/rss/cs.LG",
  "https://rss.arxiv.org/rss/cs.SI",
  "https://rss.arxiv.org/rss/cs.CL",
  "https://rss.arxiv.org/rss/cs.CV",
];
const FETCH_DAYS = 3;

// LLM 配置：显式指定 alibaba provider，避免默认走 anthropic
const LLM_PROVIDER = "alibaba";
const LLM_MODEL = "qwen3-coder-plus";

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

const startTime = Date.now();

// ── Step 1: Fetch ──
console.log("\n━━━ Step 1: Fetch ━━━");
let totalFetched = 0;
for (const url of FEEDS) {
  const cat = url.split("/").pop()!;
  try {
    const items = await fetchAndParseFeed(url, FETCH_DAYS);
    await saveFeedItems(dataDir, items, url);
    console.log(`  ${cat}: ${items.length} 篇`);
    totalFetched += items.length;
  } catch (e: any) {
    console.error(`  ${cat}: ERROR — ${e.message}`);
  }
}
console.log(`  总拉取: ${totalFetched} 篇\n`);

// ── Step 2: Summarize ──
console.log("━━━ Step 2: 生成摘要卡 ━━━");
const items = await loadFeedItems(dataDir, FETCH_DAYS + 4);
console.log(`  待处理: ${items.length} 篇`);

const genResult = await generateSummaryCards(dataDir, items, {
  logger: logger as any,
  provider: LLM_PROVIDER,
  model: LLM_MODEL,
  agentDir,
  config: openclawConfig,
});
console.log(`  ✅ 生成: ${genResult.generated}, 跳过: ${genResult.skipped}, 失败: ${genResult.failed}\n`);

// ── Step 3: Classify ──
if (genResult.generated > 0) {
  console.log("━━━ Step 3: 归类入库 ━━━");
  const classResult = await classifyCards(dataDir, undefined, {
    logger: logger as any,
    provider: LLM_PROVIDER,
    model: LLM_MODEL,
    agentDir,
    config: openclawConfig,
  });
  console.log(`  ✅ 归类: ${classResult.classified}, 跳过: ${classResult.skipped}\n`);

  // ── Step 4: Trigger ──
  if (classResult.classified > 0) {
    console.log("━━━ Step 4: 自动重整检查 ━━━");
    try {
      await triggerReorgIfNeeded(dataDir, {
        logger: logger as any,
        provider: LLM_PROVIDER,
        model: LLM_MODEL,
        agentDir,
        config: openclawConfig,
      });
    } catch (e: any) {
      console.error(`  ⚠️ trigger 错误 (非阻塞): ${e.message}`);
    }
  } else {
    console.log("━━━ Step 4: 跳过（无新归类）━━━\n");
  }
} else {
  console.log("━━━ Step 3-4: 跳过（无新摘要卡）━━━\n");
}

// ── Summary ──
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
const cardsDir = join(dataDir, "knowledge", "cards");
const cardCount = readdirSync(cardsDir).filter(f => f.endsWith(".json")).length;

console.log("━━━ 完成 ━━━");
console.log(`  耗时: ${elapsed}s`);
console.log(`  拉取: ${totalFetched} 篇`);
console.log(`  新摘要卡: ${genResult.generated} 张`);
console.log(`  摘要卡总数: ${cardCount} 张`);
}

main().catch(e => { console.error(e); process.exit(1); });
