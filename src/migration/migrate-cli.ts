#!/usr/bin/env node

/**
 * CLI 入口：Graph v1 → v2 迁移
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { migrateGraphV1ToV2 } from "./graph-v1-to-v2.js";

async function main() {
  // 默认使用 ~/.openclaw/personal-rec
  const stateDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  const dataDir = join(stateDir, "personal-rec");
  console.log(`[migration] Data dir: ${dataDir}`);

  const result = await migrateGraphV1ToV2(dataDir);

  console.log("\n=== Migration Summary ===");
  console.log(`Success: ${result.success}`);
  console.log(`Migrated cards: ${result.migratedCardCount}`);
  console.log(`Migrated nodes: ${result.migratedNodeCount}`);
  console.log(`Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const err of result.errors) {
      console.log(`  - ${err}`);
    }
  }

  if (!result.success) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
