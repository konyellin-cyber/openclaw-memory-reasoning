/**
 * 内部记忆索引构建器
 *
 * 从 memory/*.md 解析实体 → 生成 ContentCard → 构建 graph.json
 *
 * 初始策略: 全部归入 root 节点 (冷启动)
 */

import { parseMemoryDirectory, type MemoryEntity } from "./parser.js";
import {
  saveGraph,
  saveCard,
  type ContentCard,
  type SemanticGraph,
} from "../knowledge/graph.js";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

interface BuildOptions {
  memoryDir?: string;      // 默认: ~/.openclaw/memory
  outputDir?: string;      // 默认: ~/.openclaw/memory-index
  verbose?: boolean;       // 是否输出详细信息
}

export interface BuildStats {
  totalEntities: number;
  cardsCreated: number;
  graphNodes: number;
  nodeDistribution: Record<string, number>; // nodeId → count
}

/**
 * 根据源文件路径决定卡片归入哪个 seed 节点
 */
function resolveSeedNodeId(sourceFile: string): string {
  const lower = sourceFile.toLowerCase();
  if (lower.startsWith("decisions")) return "decisions";
  if (lower.startsWith("insights")) return "insights";
  if (lower.startsWith("projects")) return "projects";
  if (lower.startsWith("facts")) return "facts";
  if (lower.startsWith("conversations")) return "conversations";
  if (lower.startsWith("archive")) return "archive";
  // 日志文件: YYYY-MM-DD.md (在根目录下)
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(sourceFile)) return "daily-log";
  return "archive"; // fallback
}

/**
 * 构建内部记忆索引
 */
export async function buildMemoryIndex(options: BuildOptions = {}): Promise<BuildStats> {
  const memoryDir = options.memoryDir ?? join(homedir(), ".openclaw", "workspace", "memory");
  const outputDir = options.outputDir ?? join(homedir(), ".openclaw", "memory-index");
  const verbose = options.verbose ?? false;

  if (verbose) {
    console.log(`📂 解析记忆目录: ${memoryDir}`);
  }

  // 解析记忆实体
  const entities = parseMemoryDirectory(memoryDir);

  if (verbose) {
    console.log(`✅ 解析完成: ${entities.length} 个实体`);
  }

  // 创建输出目录
  await mkdir(outputDir, { recursive: true });

  // 初始化 graph (seed 节点: 基于源文件路径自动创建子节点)
  const now = new Date().toISOString();

  const seedNodes = [
    { id: "decisions", description: "核心决策记录" },
    { id: "insights", description: "个人洞察与方法论" },
    { id: "daily-log", description: "日常工作日志" },
    { id: "projects", description: "工作项目信息" },
    { id: "facts", description: "人物档案与事实信息" },
    { id: "conversations", description: "对话与交流记录" },
    { id: "archive", description: "其他未归类内容" },
  ];

  const graph: SemanticGraph = {
    version: 2,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "root",
        description: "内部记忆的根节点",
        parent: null,
        items: [],
        edges: seedNodes.map((s) => ({
          target: s.id,
          relation: `包含${s.description}`,
        })),
      },
      ...seedNodes.map((s) => ({
        id: s.id,
        description: s.description,
        parent: "root",
        items: [] as string[],
        edges: [],
      })),
    ],
  };

  if (verbose) {
    console.log(`🏗️  初始化图谱: ${graph.nodes.length} 个节点（1 root + ${seedNodes.length} seed）`);
  }

  // 批量生成 ContentCard 并归入对应 seed 节点
  const cardIds: string[] = [];
  const nodeDistribution: Record<string, number> = {};

  for (const entity of entities) {
    const card = entityToCard(entity);
    await saveCard(outputDir, card);
    cardIds.push(card.id);

    // 根据源文件路径归入对应的 seed 节点
    const seedId = resolveSeedNodeId(entity.sourceFile);
    const seedNode = graph.nodes.find((n) => n.id === seedId);
    if (seedNode) {
      seedNode.items.push(card.id);
    }
    nodeDistribution[seedId] = (nodeDistribution[seedId] ?? 0) + 1;

    // 同时加入 root.items（保持 root 包含全部）
    graph.nodes[0].items.push(card.id);

    if (verbose && cardIds.length % 100 === 0) {
      console.log(`   已处理 ${cardIds.length}/${entities.length} 个实体...`);
    }
  }

  // 保存 graph
  await saveGraph(outputDir, graph);

  const stats: BuildStats = {
    totalEntities: entities.length,
    cardsCreated: cardIds.length,
    graphNodes: graph.nodes.length,
    nodeDistribution,
  };

  if (verbose) {
    console.log(`💾 保存完成:`);
    console.log(`   - graph.json: ${outputDir}/graph.json`);
    console.log(`   - cards/: ${stats.cardsCreated} 张卡片`);
    console.log(`   - 节点数: ${stats.graphNodes}（1 root + ${seedNodes.length} seed）`);
    console.log(`   - root.items: ${graph.nodes[0].items.length}`);
    for (const seed of seedNodes) {
      const node = graph.nodes.find((n) => n.id === seed.id);
      if (node) {
        console.log(`   - ${seed.id}: ${node.items.length} 张卡片`);
      }
    }
  }

  return stats;
}

/**
 * 将 MemoryEntity 转换为精简版 ContentCard
 */
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
