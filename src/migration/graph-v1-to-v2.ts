/**
 * Graph v1 → v2 数据迁移脚本
 *
 * 变更：
 * - SummaryCard → ContentCard，新增 type 字段（"paper"）
 * - GraphNode.papers → items
 * - ClassificationSignal.paperId → itemId
 * - graph.version: 1 → 2
 *
 * 迁移是幂等的：如果已经是 v2，直接跳过。
 */

import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  loadGraph,
  saveGraph,
  loadCard,
  saveCard,
  type SemanticGraph,
  type GraphNode,
  type SummaryCard,
  type ContentCard,
} from "../knowledge/graph.js";

const CURRENT_VERSION = 2;

export interface MigrationResult {
  success: boolean;
  migratedCardCount: number;
  migratedNodeCount: number;
  errors: string[];
}

/**
 * 执行迁移
 */
export async function migrateGraphV1ToV2(dataDir: string): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    migratedCardCount: 0,
    migratedNodeCount: 0,
    errors: [],
  };

  try {
    // 1. 加载现有 graph
    const graph = await loadGraph(dataDir);

    // 检查是否已经是 v2
    if (graph.version >= CURRENT_VERSION) {
      console.log(`[migration] Graph is already v${graph.version}, skipping migration.`);
      result.success = true;
      return result;
    }

    console.log(`[migration] Migrating graph from v${graph.version} to v${CURRENT_VERSION}...`);

    // 2. 迁移节点：papers → items
    for (const node of graph.nodes) {
      if (node.papers) {
        node.items = [...node.papers];
        delete (node as any).papers; // 删除旧字段（可选，为了清洁可以保留向后兼容）
        result.migratedNodeCount++;
      }
    }

    // 3. 升级版本号
    graph.version = CURRENT_VERSION;

    // 4. 保存 graph
    await saveGraph(dataDir, graph);
    console.log(`[migration] Graph migrated: ${result.migratedNodeCount} nodes updated.`);

    // 5. 迁移卡片：SummaryCard → ContentCard
    const cardsDir = join(dataDir, "knowledge", "cards");
    if (!existsSync(cardsDir)) {
      console.log(`[migration] Cards directory not found, skipping card migration.`);
      result.success = true;
      return result;
    }

    const files = await readdir(cardsDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    console.log(`[migration] Found ${jsonFiles.length} cards to migrate...`);

    for (const file of jsonFiles) {
      const cardId = file.replace(".json", "");
      const cardPath = join(cardsDir, file);

      try {
        const raw = await readFile(cardPath, "utf-8");
        const card = JSON.parse(raw) as SummaryCard;

        // 检查是否已经有 type 字段（已经迁移过）
        if ((card as any).type) {
          continue;
        }

        // 转换为 ContentCard
        const contentCard: ContentCard = {
          id: card.id,
          type: "paper",
          title: card.title,
          tags: card.tags,
          oneLiner: card.oneLiner,
          qualitySignal: card.qualitySignal,
          source: card.source,
          date: card.date,
          url: card.url,
          generatedAt: card.generatedAt,
        };

        // 保存转换后的卡片
        await saveCard(dataDir, contentCard);
        result.migratedCardCount++;

        if (result.migratedCardCount % 100 === 0) {
          console.log(`[migration] Migrated ${result.migratedCardCount}/${jsonFiles.length} cards...`);
        }
      } catch (err) {
        const errorMsg = `Failed to migrate card ${file}: ${(err as Error).message}`;
        result.errors.push(errorMsg);
        console.error(`[migration] ${errorMsg}`);
      }
    }

    console.log(`[migration] Migration complete: ${result.migratedCardCount} cards migrated.`);

    // 6. 迁移 ClassificationSignal（如果存在）
    const signalsPath = join(dataDir, "knowledge", "signals.json");
    if (existsSync(signalsPath)) {
      console.log(`[migration] Migrating ClassificationSignal...`);
      try {
        const raw = await readFile(signalsPath, "utf-8");
        const store = JSON.parse(raw) as { signals: any[] };

        let migratedSignalCount = 0;
        for (const signal of store.signals) {
          if (signal.paperId && !signal.itemId) {
            signal.itemId = signal.paperId;
            delete (signal as any).paperId;
            migratedSignalCount++;
          }
        }

        await writeFile(signalsPath, JSON.stringify(store, null, 2), "utf-8");
        console.log(`[migration] Migrated ${migratedSignalCount} signals.`);
      } catch (err) {
        const errorMsg = `Failed to migrate signals: ${(err as Error).message}`;
        result.errors.push(errorMsg);
        console.error(`[migration] ${errorMsg}`);
      }
    }

    result.success = true;
    console.log(`[migration] ✅ All migrations completed successfully!`);
  } catch (err) {
    const errorMsg = `Migration failed: ${(err as Error).message}`;
    result.errors.push(errorMsg);
    console.error(`[migration] ${errorMsg}`);
    result.success = false;
  }

  return result;
}
