/**
 * 检查论文库当前状态
 *
 * 使用方式: cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/check-status.js
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT = dirname(dirname(dirname(__dirname)));

async function main() {
  const { getDataDir } = await import(PROJECT + "/dist/feeds/storage.js");

  const stateDir = process.env.HOME + "/.openclaw";
  const dataDir = getDataDir(stateDir);

  console.log("=== 论文库状态 ===\n");

  // Feeds
  const feedsDir = join(dataDir, "feeds");
  const feedFiles = readdirSync(feedsDir).filter(f => f.endsWith(".json")).sort().reverse();
  let totalPapers = 0;
  console.log("📥 Feed 文件:");
  for (const f of feedFiles.slice(0, 5)) {
    const data = JSON.parse(readFileSync(join(feedsDir, f), "utf-8"));
    const count = Array.isArray(data) ? data.length : 0;
    totalPapers += count;
    console.log(`  ${f}: ${count} 篇`);
  }
  if (feedFiles.length > 5) {
    for (const f of feedFiles.slice(5)) {
      const data = JSON.parse(readFileSync(join(feedsDir, f), "utf-8"));
      totalPapers += Array.isArray(data) ? data.length : 0;
    }
    console.log(`  ... 还有 ${feedFiles.length - 5} 个文件`);
  }
  console.log(`  总计: ${feedFiles.length} 个文件, ${totalPapers} 篇论文`);

  // Cards
  const cardsDir = join(dataDir, "knowledge", "cards");
  const cards = readdirSync(cardsDir).filter(f => f.endsWith(".json"));
  console.log(`\n📋 摘要卡: ${cards.length} 张`);

  // Graph
  const graphPath = join(dataDir, "knowledge", "graph.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
  const nodes = graph.nodes || [];
  // 注意：使用 items 字段，不是 papers（papers 是旧字段名）
  const totalClassified = nodes.reduce((s: number, n: any) => s + (n.items?.length || 0), 0);
  console.log(`\n🌳 语义网: ${nodes.length} 个节点, ${totalClassified} 篇已归类`);
  for (const n of nodes.sort((a: any, b: any) => (b.items?.length || 0) - (a.items?.length || 0))) {
    const reorg = n.lastReorgAt ? `已重整 ${n.lastReorgAt.slice(0, 10)}` : "未重整";
    const warn = (n.items?.length || 0) >= 20 && !n.lastReorgAt ? " ⚠️" : "";
    console.log(`  ${n.id}: ${n.items?.length || 0} 篇 (${reorg})${warn}`);
  }

  // Signals
  const signalsPath = join(dataDir, "knowledge", "signals.json");
  try {
    const sigData = JSON.parse(readFileSync(signalsPath, "utf-8"));
    const signals = sigData.signals || sigData;
    if (Array.isArray(signals)) {
      signals.sort((a: any, b: any) => (b.timestamp || "").localeCompare(a.timestamp || ""));
      console.log(`\n📊 归类信号: ${signals.length} 条`);
      console.log("  最近 5 条:");
      for (const s of signals.slice(0, 5)) {
        // 注意：使用 itemId 字段，不是 paperId
        console.log(`    ${(s.timestamp || "?").slice(0, 16)}  ${s.itemId || "?"} → ${s.assignedNode || "?"}  [${s.confidence || "?"}]`);
      }
    }
  } catch { console.log("\n📊 归类信号: 无"); }

  console.log("\n=== Done ===");
}

main().catch(e => { console.error(e); process.exit(1); });
