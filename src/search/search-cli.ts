/**
 * 主动搜索 CLI 入口 — Phase 5.3
 *
 * Usage:
 *   npx tsx src/search/search-cli.ts                    # 完整管道
 *   npx tsx src/search/search-cli.ts --dry-run           # 到去重为止，不入库
 *   npx tsx src/search/search-cli.ts --query-only        # 只生成 query
 *   npx tsx src/search/search-cli.ts --limit 5           # 限制 query 数
 *   npx tsx src/search/search-cli.ts --node-limit 3      # 限制活跃节点数
 *   npx tsx src/search/search-cli.ts --provider alibaba  # 指定 LLM provider
 */

import { runProactiveSearch, type PipelineResult } from "./pipeline.js";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean" },
    "query-only": { type: "boolean" },
    limit: { type: "string" },
    "node-limit": { type: "string" },
    "per-query": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "api-key": { type: "string" },
    verbose: { type: "boolean", short: "v" },
  },
});

// ─── Config loading (same as other CLIs) ───
const agentDir = `${process.env.HOME}/.openclaw/agents/main/agent`;

let config: Record<string, unknown> | undefined;
try {
  const configPath = `${process.env.HOME}/.openclaw/openclaw.json`;
  if (existsSync(configPath)) {
    config = JSON.parse(await readFile(configPath, "utf-8"));
  }
} catch { /* ignore */ }

console.log(`\n🔍 主动搜索管道\n`);

try {
  const provider = values.provider ?? process.env.PERSONAL_REC_PROVIDER ?? "alibaba";
  const model = values.model ?? process.env.PERSONAL_REC_MODEL ?? "qwen3-coder-plus";

  const result = await runProactiveSearch({
    dryRun: values["dry-run"],
    queryOnly: values["query-only"],
    searchLimit: values.limit ? parseInt(values.limit, 10) : undefined,
    nodeLimit: values["node-limit"] ? parseInt(values["node-limit"], 10) : undefined,
    perQueryLimit: values["per-query"] ? parseInt(values["per-query"], 10) : undefined,
    provider,
    model,
    agentDir,
    config,
    apiKey: values["api-key"],
  });

  printResult(result);
} catch (err) {
  console.error(`\n❌ Error: ${(err as Error).message}`);
  process.exit(1);
}

function printResult(result: PipelineResult): void {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`📊 管道执行结果`);
  console.log(`${"═".repeat(50)}\n`);

  // Query 统计
  console.log(`🔍 Query 生成:`);
  console.log(`   活跃节点: ${result.queryResult.totalNodes}`);
  console.log(`   适合学术检索: ${result.queryResult.searchableNodes}`);
  console.log(`   处理节点: ${result.queryResult.processedNodes}`);
  console.log(`   生成 query: ${result.queryResult.queries.length} (去重前: ${result.queryResult.queriesBeforeDedup})`);

  if (result.queryResult.filteredOutNodes.length > 0) {
    console.log(`   🚫 跳过方向: ${result.queryResult.filteredOutNodes.map((f) => f.nodeId).join(", ")}`);
  }
  if (result.queryResult.queries.length > 0) {
    console.log(`   Query 列表:`);
    for (const q of result.queryResult.queries) {
      console.log(`     - "${q.text}" ← [${q.sourceNodeId}]`);
    }
  }

  // 搜索统计
  if (result.searchStats.totalQueries > 0) {
    console.log(`\n🔎 搜索:`);
    console.log(`   执行 query: ${result.searchStats.totalQueries}`);
    console.log(`   找到论文: ${result.searchStats.totalPapersFound}`);
    console.log(`   有结果: ${result.searchStats.queriesWithResults}, 无结果: ${result.searchStats.queriesEmpty}`);
  }

  // 去重统计
  if (result.dedupStats.totalSearched > 0) {
    console.log(`\n🧹 去重:`);
    console.log(`   总搜索: ${result.dedupStats.totalSearched}`);
    console.log(`   批次内重复: ${result.dedupStats.batchDuplicates}`);
    console.log(`   已入库重复: ${result.dedupStats.existingDuplicates}`);
    console.log(`   新论文: ${result.dedupStats.newCount}`);
  }

  // 入库统计
  if (result.ingestStats) {
    console.log(`\n📥 入库:`);
    console.log(`   摘要卡生成: ${result.ingestStats.cardsGenerated} (跳过: ${result.ingestStats.cardsSkipped}, 失败: ${result.ingestStats.cardsFailed})`);
    console.log(`   归类: ${result.ingestStats.classified} (跳过: ${result.ingestStats.classifySkipped}, 失败: ${result.ingestStats.classifyFailed})`);
  }

  // 耗时
  console.log(`\n⏱️  总耗时: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.log();
}
