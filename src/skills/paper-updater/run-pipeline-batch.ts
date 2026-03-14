/**
 * 论文更新管道（分批模式）— 每次处理固定数量，避免长时间运行被系统终止
 *
 * 利用 generateSummaryCards 内置的 cardExists 幂等跳过机制：
 * 已生成过摘要卡的论文会自动跳过，所以多次运行自动实现"断点续跑"。
 *
 * 用法:
 *   cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/run-pipeline-batch.js [--batch N] [--skip-fetch] [--skip-classify]
 *
 * 参数:
 *   --batch N        每批处理的论文数（默认 80）
 *   --skip-fetch     跳过 fetch 步骤（已有 feed 数据时加速）
 *   --skip-classify  跳过归类步骤（只生成摘要卡）
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT = dirname(dirname(dirname(__filename)));

function parseArgs() {
  const args = process.argv.slice(2);
  let batchSize = 80;
  let skipFetch = false;
  let skipClassify = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch" && args[i + 1]) {
      batchSize = parseInt(args[i + 1], 10);
      if (isNaN(batchSize) || batchSize < 1) batchSize = 80;
      i++;
    }
    if (args[i] === "--skip-fetch") skipFetch = true;
    if (args[i] === "--skip-classify") skipClassify = true;
  }

  return { batchSize, skipFetch, skipClassify };
}

async function main() {
  const { batchSize, skipFetch, skipClassify } = parseArgs();

  const { fetchAndParseFeed } = await import(PROJECT + "/dist/feeds/parser.js");
  const { saveFeedItems, loadFeedItems, getDataDir } = await import(PROJECT + "/dist/feeds/storage.js");
  const { generateSummaryCards } = await import(PROJECT + "/dist/summarizer/generator.js");
  const { classifyCards } = await import(PROJECT + "/dist/summarizer/classifier.js");
  const { cardExists } = await import(PROJECT + "/dist/knowledge/graph.js");

  const FEEDS = [
    "https://rss.arxiv.org/rss/cs.IR",
    "https://rss.arxiv.org/rss/cs.AI",
    "https://rss.arxiv.org/rss/cs.LG",
    "https://rss.arxiv.org/rss/cs.SI",
    "https://rss.arxiv.org/rss/cs.CL",
    "https://rss.arxiv.org/rss/cs.CV",
  ];
  const FETCH_DAYS = 3;

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

  // ── Step 1: Fetch（可跳过）──
  let totalFetched = 0;
  if (skipFetch) {
    console.log("\n━━━ Step 1: Fetch [跳过] ━━━\n");
  } else {
    console.log("\n━━━ Step 1: Fetch ━━━");
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
  }

  // ── Step 2: 分批生成摘要卡 ──
  console.log("━━━ Step 2: 生成摘要卡（分批模式）━━━");
  const allItems = await loadFeedItems(dataDir, FETCH_DAYS + 4);

  // 预先过滤出尚未生成摘要卡的论文，只处理这批
  const pending: typeof allItems = [];
  for (const item of allItems) {
    if (!(await cardExists(dataDir, item.id))) {
      pending.push(item);
    }
  }

  console.log(`  总论文数: ${allItems.length}`);
  console.log(`  已有摘要卡: ${allItems.length - pending.length}`);
  console.log(`  待处理: ${pending.length}`);
  console.log(`  本批上限: ${batchSize}`);

  const batchItems = pending.slice(0, batchSize);
  console.log(`  本批实际: ${batchItems.length} 篇\n`);

  let genResult = { generated: 0, skipped: 0, failed: 0, total: 0 };

  if (batchItems.length > 0) {
    genResult = await generateSummaryCards(dataDir, batchItems, {
      logger: logger as any,
      provider: LLM_PROVIDER,
      model: LLM_MODEL,
      agentDir,
      config: openclawConfig,
    });
    console.log(`  ✅ 生成: ${genResult.generated}, 跳过: ${genResult.skipped}, 失败: ${genResult.failed}`);
  } else {
    console.log("  ✅ 所有论文已有摘要卡，无需处理");
  }

  const remainingAfter = pending.length - batchItems.length + (genResult.failed || 0);
  if (remainingAfter > 0) {
    const batchesLeft = Math.ceil(remainingAfter / batchSize);
    console.log(`\n  📌 剩余 ${remainingAfter} 篇待处理，还需约 ${batchesLeft} 批`);
  } else {
    console.log(`\n  🎉 所有论文摘要卡已完成！`);
  }
  console.log();

  // ── Step 3: Classify ──
  if (genResult.generated > 0 && !skipClassify) {
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
        const { triggerReorgIfNeeded } = await import(PROJECT + "/dist/knowledge/trigger.js");
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
  } else if (skipClassify) {
    console.log("━━━ Step 3-4: 归类 [跳过] ━━━\n");
  } else {
    console.log("━━━ Step 3-4: 跳过（无新摘要卡）━━━\n");
  }

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const cardsDir = join(dataDir, "knowledge", "cards");
  const cardCount = readdirSync(cardsDir).filter(f => f.endsWith(".json")).length;

  console.log("━━━ 完成 ━━━");
  console.log(`  耗时: ${elapsed}s`);
  console.log(`  本批生成: ${genResult.generated} 张摘要卡`);
  console.log(`  摘要卡总数: ${cardCount} 张`);
  if (remainingAfter > 0) {
    console.log(`  剩余待处理: ${remainingAfter} 篇`);
    console.log(`\n💡 再次运行此脚本即可继续处理下一批`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
