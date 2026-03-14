/**
 * 增量索引器
 *
 * 检测 memory/*.md 文件的新增/修改/删除，仅处理变化部分：
 *   - 新文件 → 解析全部段落 → 生成 ContentCard → 追加到 root
 *   - 修改文件 → 重新解析 → 对比已有卡片 → 增量更新
 *   - 删除文件 → 从 graph 移除对应卡片
 *
 * 同步状态存储在 memory-index/sync-state.json
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseMemoryFile, parseMemoryDirectory, type MemoryEntity } from "./parser.js";
import {
  loadGraph,
  saveGraph,
  saveCard,
  loadCard,
  addItemToNode,
  hasItem,
  listCardIds,
  type SemanticGraph,
  type ContentCard,
} from "../knowledge/graph.js";

// ─── Types ───

export interface SyncState {
  /** 上次同步时间 (ISO) */
  lastSyncAt: string;
  /** 每个文件的 mtime (ms) 和已索引的卡片 ID 列表 */
  files: Record<string, FileState>;
}

interface FileState {
  mtimeMs: number;
  cardIds: string[];
}

export interface SyncOptions {
  memoryDir?: string;   // 默认: ~/.openclaw/workspace/memory
  outputDir?: string;   // 默认: ~/.openclaw/memory-index
  since?: string;       // 只同步此日期之后修改的文件 (YYYY-MM-DD)
  dryRun?: boolean;     // 预览变更不写入
  verbose?: boolean;
}

export interface SyncResult {
  newFiles: number;
  modifiedFiles: number;
  deletedFiles: number;
  newCards: number;
  updatedCards: number;
  removedCards: number;
  errors: string[];
}

// ─── Paths ───

function getSyncStatePath(outputDir: string): string {
  return join(outputDir, "sync-state.json");
}

// ─── Sync State ───

async function loadSyncState(outputDir: string): Promise<SyncState> {
  const statePath = getSyncStatePath(outputDir);
  if (!existsSync(statePath)) {
    return { lastSyncAt: "", files: {} };
  }
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw) as SyncState;
  } catch {
    return { lastSyncAt: "", files: {} };
  }
}

async function saveSyncState(outputDir: string, state: SyncState): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  state.lastSyncAt = new Date().toISOString();
  await writeFile(getSyncStatePath(outputDir), JSON.stringify(state, null, 2), "utf-8");
}

// ─── File Discovery ───

/**
 * 递归收集 memory/ 下所有 .md 文件及其 mtime
 */
function collectMemoryFiles(
  memoryDir: string,
  sinceDate?: Date,
): Map<string, { fullPath: string; mtimeMs: number }> {
  const files = new Map<string, { fullPath: string; mtimeMs: number }>();

  function traverse(dir: string, relativePath: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          traverse(fullPath, join(relativePath, entry));
        } else if (entry.endsWith(".md")) {
          const relPath = join(relativePath, entry);
          // 如果指定了 since，跳过早于该日期修改的文件
          if (sinceDate && stat.mtimeMs < sinceDate.getTime()) {
            continue;
          }
          files.set(relPath, { fullPath, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // skip inaccessible files
      }
    }
  }

  traverse(memoryDir, "");
  return files;
}

// ─── Card Conversion (from index-builder.ts) ───

function entityToCard(entity: MemoryEntity): ContentCard {
  return {
    id: entity.id,
    type: "memory",
    title: entity.title,
    oneLiner: entity.content.slice(0, 200).replace(/\n/g, " ").trim() +
      (entity.content.length > 200 ? "..." : ""),
    source: `memory/${entity.sourceFile}`,
    date: entity.date ?? new Date().toISOString().split("T")[0],
    url: `memory://${entity.sourceFile}#L${entity.sourceLine}`,
    sourceFile: entity.sourceFile,
    people: entity.people.length > 0 ? entity.people : undefined,
  };
}

// ─── Core Logic ───

/**
 * 增量同步记忆索引
 */
export async function incrementalSync(options: SyncOptions = {}): Promise<SyncResult> {
  const memoryDir = options.memoryDir ?? join(homedir(), ".openclaw", "workspace", "memory");
  const outputDir = options.outputDir ?? join(homedir(), ".openclaw", "memory-index");
  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose ?? false;

  const result: SyncResult = {
    newFiles: 0,
    modifiedFiles: 0,
    deletedFiles: 0,
    newCards: 0,
    updatedCards: 0,
    removedCards: 0,
    errors: [],
  };

  // 解析 --since 参数
  let sinceDate: Date | undefined;
  if (options.since) {
    sinceDate = new Date(options.since);
    if (isNaN(sinceDate.getTime())) {
      result.errors.push(`无效的 --since 日期: ${options.since}`);
      return result;
    }
  }

  if (verbose) {
    console.log(`📂 记忆目录: ${memoryDir}`);
    console.log(`📁 索引目录: ${outputDir}`);
    if (sinceDate) console.log(`📅 仅同步 ${options.since} 之后的变更`);
    if (dryRun) console.log(`🔍 Dry-run 模式 (不写入)`);
  }

  // 加载同步状态和图谱
  const syncState = await loadSyncState(outputDir);
  const graph = await loadGraph(outputDir);

  if (verbose) {
    console.log(`📊 上次同步: ${syncState.lastSyncAt || "从未同步"}`);
    console.log(`📊 已索引文件: ${Object.keys(syncState.files).length}`);
  }

  // 收集当前 memory/ 下的文件
  // 注意: 删除检测需要全量文件列表, 增量更新使用 since 过滤后的列表
  const allFiles = collectMemoryFiles(memoryDir);
  const filteredFiles = sinceDate ? collectMemoryFiles(memoryDir, sinceDate) : allFiles;

  if (verbose) {
    console.log(`📂 当前文件: ${allFiles.size} 个 .md 文件`);
    if (sinceDate) {
      console.log(`📂 待检查文件: ${filteredFiles.size} 个 (since ${options.since})`);
    }
  }

  // ─── 检测删除的文件（基于全量列表）───
  for (const [relPath, fileState] of Object.entries(syncState.files)) {
    if (!allFiles.has(relPath)) {
      if (verbose) console.log(`  🗑️  删除: ${relPath} (${fileState.cardIds.length} 张卡片)`);
      result.deletedFiles++;

      // 从 graph 中移除对应卡片
      for (const cardId of fileState.cardIds) {
        if (!dryRun) {
          removeCardFromGraph(graph, cardId);
          // 物理删除卡片文件（可选，保留也无害）
          try {
            const cardPath = join(outputDir, "knowledge", "cards", `${cardId}.json`);
            if (existsSync(cardPath)) {
              await unlink(cardPath);
            }
          } catch {
            // 忽略删除失败
          }
        }
        result.removedCards++;
      }

      if (!dryRun) {
        delete syncState.files[relPath];
      }
    }
  }

  // ─── 检测新增/修改的文件（基于过滤后的列表）───
  for (const [relPath, fileInfo] of filteredFiles) {
    const prevState = syncState.files[relPath];
    const isNew = !prevState;
    const isModified = prevState && prevState.mtimeMs < fileInfo.mtimeMs;

    if (!isNew && !isModified) {
      continue; // 文件未变化
    }

    if (isNew) {
      result.newFiles++;
      if (verbose) console.log(`  ✨ 新增: ${relPath}`);
    } else {
      result.modifiedFiles++;
      if (verbose) console.log(`  📝 修改: ${relPath}`);
    }

    // 解析文件
    let entities: MemoryEntity[];
    try {
      entities = parseMemoryFile(fileInfo.fullPath, relPath);
    } catch (err) {
      const msg = `解析失败 ${relPath}: ${(err as Error).message}`;
      result.errors.push(msg);
      if (verbose) console.log(`  ❌ ${msg}`);
      continue;
    }

    // 如果是修改的文件，先移除旧卡片
    if (isModified && prevState) {
      for (const oldCardId of prevState.cardIds) {
        if (!dryRun) {
          removeCardFromGraph(graph, oldCardId);
          try {
            const cardPath = join(outputDir, "knowledge", "cards", `${oldCardId}.json`);
            if (existsSync(cardPath)) {
              await unlink(cardPath);
            }
          } catch {
            // ignore
          }
        }
        result.removedCards++;
      }
    }

    // 生成新卡片
    const newCardIds: string[] = [];
    for (const entity of entities) {
      const card = entityToCard(entity);

      if (!dryRun) {
        await saveCard(outputDir, card);
        addItemToNode(graph, "root", card.id);
      }

      newCardIds.push(card.id);

      if (isModified) {
        result.updatedCards++;
      } else {
        result.newCards++;
      }
    }

    if (!dryRun) {
      syncState.files[relPath] = {
        mtimeMs: fileInfo.mtimeMs,
        cardIds: newCardIds,
      };
    }
  }

  // ─── 保存 ───
  if (!dryRun) {
    await saveGraph(outputDir, graph);
    await saveSyncState(outputDir, syncState);
  }

  // ─── 输出摘要 ───
  if (verbose) {
    console.log(`\n📊 同步结果:`);
    console.log(`   新增文件: ${result.newFiles}`);
    console.log(`   修改文件: ${result.modifiedFiles}`);
    console.log(`   删除文件: ${result.deletedFiles}`);
    console.log(`   新增卡片: ${result.newCards}`);
    console.log(`   更新卡片: ${result.updatedCards}`);
    console.log(`   移除卡片: ${result.removedCards}`);
    if (result.errors.length > 0) {
      console.log(`   ❌ 错误: ${result.errors.length}`);
      for (const e of result.errors) {
        console.log(`      - ${e}`);
      }
    }
    if (dryRun) {
      console.log(`   (dry-run 模式，未写入任何变更)`);
    }

    // 输出最终统计
    if (!dryRun) {
      const totalItems = graph.nodes.reduce((sum, n) => sum + n.items.length, 0);
      console.log(`\n📈 索引状态:`);
      console.log(`   总卡片数: ${totalItems}`);
      console.log(`   已索引文件: ${Object.keys(syncState.files).length}`);
    }
  }

  return result;
}

// ─── Helpers ───

/**
 * 从所有节点中移除指定卡片 ID
 */
function removeCardFromGraph(graph: SemanticGraph, cardId: string): void {
  for (const node of graph.nodes) {
    const idx = node.items.indexOf(cardId);
    if (idx >= 0) {
      node.items.splice(idx, 1);
      return;
    }
  }
}
