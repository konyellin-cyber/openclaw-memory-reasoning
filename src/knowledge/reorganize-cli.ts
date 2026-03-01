#!/usr/bin/env npx tsx
/**
 * 重整器 CLI — 手动触发节点分裂
 *
 * Usage:
 *   npx tsx src/knowledge/reorganize-cli.ts [--node root] [--dry-run] [--provider alibaba] [--model qwen3-coder-plus]
 */

import { reorganize } from "./reorganizer.js";

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return defaultVal;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const nodeId = getArg("node", "root");
const dryRun = hasFlag("dry-run");
const provider = getArg("provider", process.env.PERSONAL_REC_PROVIDER ?? "alibaba");
const model = getArg("model", process.env.PERSONAL_REC_MODEL ?? "qwen3-coder-plus");

const dataDir = `${process.env.HOME}/.openclaw/personal-rec`;
const agentDir = `${process.env.HOME}/.openclaw/agents/main/agent`;

// 读取 openclaw config
let config: Record<string, unknown> | undefined;
try {
  const { readFileSync } = await import("node:fs");
  config = JSON.parse(readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf-8"));
} catch {
  // non-critical
}

const logger = {
  info: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(`⚠️ ${msg}`),
  error: (msg: string) => console.error(`❌ ${msg}`),
};

console.log(`\n🔄 Reorganizing node "${nodeId}" (dryRun=${dryRun}, provider=${provider}, model=${model})\n`);

const result = await reorganize(dataDir, {
  logger,
  nodeId,
  dryRun,
  provider,
  model,
  agentDir,
  config,
});

if (result.success) {
  console.log("\n✅ Reorganization complete!");
  if (result.meta) {
    console.log(`   Input: ${result.meta.inputCards} cards`);
    console.log(`   New nodes: ${result.meta.newNodeCount}`);
    console.log(`   New edges: ${result.meta.newEdgeCount}`);
    console.log(`   Papers moved: ${result.meta.movedPapers}`);
    console.log(`   Remaining in root: ${result.meta.remainingPapers}`);
    console.log(`   Split rate: ${((result.meta.movedPapers / result.meta.inputCards) * 100).toFixed(1)}%`);
    console.log(`   Stage 1 (define nodes): ${result.meta.stage1Ms}ms`);
    console.log(`   Stage 2 (classify, ${result.meta.batchCount} batches): ${result.meta.stage2Ms}ms`);
    console.log(`   Total: ${result.meta.durationMs}ms`);
  }
  if (result.diff) {
    // 只输出节点摘要，不输出完整 paperId 列表（太长）
    console.log("\n📋 Diff summary:");
    for (const nn of result.diff.newNodes) {
      console.log(`  [${nn.id}] ${nn.description} — ${nn.papers.length} papers`);
    }
    for (const ne of result.diff.newEdges) {
      console.log(`  edge: ${ne.from} → ${ne.to}: ${ne.relation}`);
    }
    console.log(`  remaining in "${result.diff.sourceNode}": ${result.diff.remainingPapers.length} papers`);
  }
} else {
  console.error(`\n❌ Reorganization failed: ${result.error}`);
  process.exit(1);
}
