#!/usr/bin/env node

/**
 * 内部记忆索引构建 CLI
 *
 * 用法:
 *   npx tsx src/memory/build-cli.ts [--verbose]
 */

import { buildMemoryIndex } from "./index-builder.js";

const verbose = process.argv.includes("--verbose");

console.log("🚀 开始构建内部记忆索引...\n");

buildMemoryIndex({ verbose })
  .then((stats) => {
    console.log(`\n✅ 索引构建完成!`);
    console.log(`   总实体: ${stats.totalEntities}`);
    console.log(`   已生成卡片: ${stats.cardsCreated}`);
    console.log(`   节点数: ${stats.graphNodes}`);
    console.log(`\n💡 使用 semantic-navigator 导航记忆:`);
    console.log(`   npx tsx src/skills/semantic-navigator/navigate.ts --source memory --action overview`);
  })
  .catch((error) => {
    console.error(`\n❌ 错误: ${error.message}`);
    process.exit(1);
  });
