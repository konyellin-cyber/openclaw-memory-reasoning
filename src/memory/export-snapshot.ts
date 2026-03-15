/**
 * 关注方向图谱提取器
 *
 * 从内部记忆的语义图中提取"当前活跃方向"快照，
 * 输出 current-focus.json 供 Phase 5 检索 query 生成器读取。
 *
 * 活跃标准：
 * 1. 节点下卡片数 > minItems（默认 3）
 * 2. 最近 N 天有新增卡片（默认 14 天）
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { loadGraph, loadCard, type SemanticGraph, type ContentCard } from "../knowledge/graph.js";

// ─── Types ───

export interface FocusNode {
  id: string;
  description: string;
  itemCount: number;
  recentItemCount: number;       // 最近 N 天的卡片数
  latestDate: string | null;     // 最新卡片的日期
  topPeople: string[];           // 该节点下最常出现的人物
  sampleTitles: string[];        // 最近几张卡片的标题
}

export interface FocusSnapshot {
  generatedAt: string;
  memoryIndexDir: string;
  totalNodes: number;
  totalItems: number;
  activeNodes: FocusNode[];
  inactiveNodes: Array<{ id: string; description: string; itemCount: number; reason: string }>;
}

export interface SnapshotOptions {
  indexDir?: string;
  minItems?: number;           // 最小卡片数阈值（默认 3）
  recentDays?: number;         // "最近"的天数定义（默认 14）
  sampleCount?: number;        // 每个节点取几个样本标题（默认 5）
}

// ─── Core ───

export async function exportFocusSnapshot(options: SnapshotOptions = {}): Promise<FocusSnapshot> {
  const indexDir = options.indexDir ?? join(homedir(), ".openclaw", "memory-index");
  const minItems = options.minItems ?? 3;
  const recentDays = options.recentDays ?? 14;
  const sampleCount = options.sampleCount ?? 5;

  const graph = await loadGraph(indexDir);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - recentDays);
  const cutoffStr = cutoffDate.toISOString().split("T")[0]; // YYYY-MM-DD

  const totalItems = graph.nodes.reduce((sum, n) => sum + n.items.length, 0);
  const activeNodes: FocusNode[] = [];
  const inactiveNodes: Array<{ id: string; description: string; itemCount: number; reason: string }> = [];

  // 遍历非 root 节点
  for (const node of graph.nodes) {
    if (node.id === "root") continue;

    const cards: ContentCard[] = [];
    for (const itemId of node.items) {
      const card = await loadCard(indexDir, itemId);
      if (card) cards.push(card);
    }

    if (cards.length < minItems) {
      inactiveNodes.push({
        id: node.id,
        description: node.description,
        itemCount: cards.length,
        reason: `卡片数 ${cards.length} < ${minItems}`,
      });
      continue;
    }

    // 计算最近 N 天的卡片数
    const recentCards = cards.filter((c) => c.date >= cutoffStr);

    // 统计 people 频率
    const peopleFreq = new Map<string, number>();
    for (const c of cards) {
      for (const p of c.people ?? []) {
        peopleFreq.set(p, (peopleFreq.get(p) ?? 0) + 1);
      }
    }
    const topPeople = Array.from(peopleFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([person]) => person);

    // 最新卡片日期
    const sortedByDate = cards.sort((a, b) => b.date.localeCompare(a.date));
    const latestDate = sortedByDate[0]?.date ?? null;

    // 样本标题（最新的几张）
    const sampleTitles = sortedByDate.slice(0, sampleCount).map((c) => c.title);

    // 判断是否活跃：有最近 N 天的卡片
    if (recentCards.length === 0) {
      inactiveNodes.push({
        id: node.id,
        description: node.description,
        itemCount: cards.length,
        reason: `最近 ${recentDays} 天无新增卡片（最新: ${latestDate}）`,
      });
      continue;
    }

    activeNodes.push({
      id: node.id,
      description: node.description,
      itemCount: cards.length,
      recentItemCount: recentCards.length,
      latestDate,
      topPeople,
      sampleTitles,
    });
  }

  // 按最近活跃度排序
  activeNodes.sort((a, b) => (b.recentItemCount ?? 0) - (a.recentItemCount ?? 0));

  const snapshot: FocusSnapshot = {
    generatedAt: new Date().toISOString(),
    memoryIndexDir: indexDir,
    totalNodes: graph.nodes.length,
    totalItems,
    activeNodes,
    inactiveNodes,
  };

  // 保存到文件
  const snapshotDir = join(indexDir, "snapshot");
  await mkdir(snapshotDir, { recursive: true });
  const snapshotPath = join(snapshotDir, "current-focus.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");

  return snapshot;
}

// ─── CLI ───
// 注意：不使用顶层 await，因为 jiti 同步加载不支持
// CLI 入口已迁移到单独的 CLI 文件
