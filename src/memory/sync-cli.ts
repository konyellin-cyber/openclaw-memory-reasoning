/**
 * 记忆索引同步 CLI
 *
 * 用法:
 *   npx tsx src/memory/sync-cli.ts              # 增量同步
 *   npx tsx src/memory/sync-cli.ts --since 7d   # 只同步最近7天
 *   npx tsx src/memory/sync-cli.ts --since 2026-03-01  # 只同步指定日期之后
 *   npx tsx src/memory/sync-cli.ts --full       # 全量重建
 *   npx tsx src/memory/sync-cli.ts --dry-run    # 预览变更不写入
 *   npx tsx src/memory/sync-cli.ts --verbose    # 详细输出
 */

import { program } from "commander";
import { incrementalSync } from "./incremental-indexer.js";
import { buildMemoryIndex } from "./index-builder.js";

program
  .name("memory-sync")
  .description("同步记忆索引（增量或全量）")
  .option("--since <date>", "只同步此日期之后的变更（支持 YYYY-MM-DD 或 Nd 格式如 7d）")
  .option("--full", "全量重建索引（忽略增量状态）", false)
  .option("--dry-run", "预览变更不写入", false)
  .option("--verbose", "详细输出", false)
  .option("--memory-dir <dir>", "记忆目录路径")
  .option("--output-dir <dir>", "索引输出目录路径");

program.parse();

const opts = program.opts();

async function main() {
  const startTime = Date.now();

  if (opts.full) {
    // 全量重建
    console.log("🔄 全量重建记忆索引...\n");
    const stats = await buildMemoryIndex({
      memoryDir: opts.memoryDir,
      outputDir: opts.outputDir,
      verbose: true,
    });
    console.log(`\n✅ 全量重建完成:`);
    console.log(`   总实体: ${stats.totalEntities}`);
    console.log(`   卡片: ${stats.cardsCreated}`);
    console.log(`   节点: ${stats.graphNodes}`);
  } else {
    // 增量同步
    console.log("🔄 增量同步记忆索引...\n");

    // 解析 --since 参数
    let since: string | undefined;
    if (opts.since) {
      since = parseSinceArg(opts.since);
      if (!since) {
        console.error(`❌ 无效的 --since 参数: ${opts.since}`);
        console.error(`   支持格式: YYYY-MM-DD 或 Nd (如 7d 表示最近7天)`);
        process.exit(1);
      }
    }

    const result = await incrementalSync({
      memoryDir: opts.memoryDir,
      outputDir: opts.outputDir,
      since,
      dryRun: opts.dryRun,
      verbose: opts.verbose ?? true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // 简洁的最终摘要
    const hasChanges = result.newCards > 0 || result.updatedCards > 0 || result.removedCards > 0;
    if (hasChanges) {
      console.log(`\n✅ 同步完成 (${elapsed}s)`);
      if (result.newCards > 0) console.log(`   + ${result.newCards} 新卡片`);
      if (result.updatedCards > 0) console.log(`   ~ ${result.updatedCards} 更新卡片`);
      if (result.removedCards > 0) console.log(`   - ${result.removedCards} 移除卡片`);
    } else {
      console.log(`\n✅ 无变更 (${elapsed}s) — 索引已是最新`);
    }

    if (result.errors.length > 0) {
      console.log(`\n⚠️  ${result.errors.length} 个错误:`);
      for (const e of result.errors) {
        console.log(`   - ${e}`);
      }
    }
  }
}

/**
 * 解析 --since 参数
 * 支持: "2026-03-01" 或 "7d" (最近N天)
 */
function parseSinceArg(arg: string): string | undefined {
  // 尝试 Nd 格式
  const daysMatch = arg.match(/^(\d+)d$/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split("T")[0];
  }

  // 尝试 YYYY-MM-DD 格式
  const dateMatch = arg.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return arg;
  }

  return undefined;
}

main().catch((err) => {
  console.error("❌ 同步失败:", err);
  process.exit(1);
});
