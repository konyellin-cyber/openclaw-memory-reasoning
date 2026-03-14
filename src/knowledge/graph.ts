/**
 * 语义网 CRUD — 管理 knowledge/graph.json 和 cards/ 目录
 *
 * 数据结构：
 *   ~/.openclaw/personal-rec/knowledge/  (外部记忆)
 *   ├── graph.json          # 语义网（节点 + 边）
 *   ├── cards/              # 内容卡片 JSON 文件（论文/记忆）
 *   │   ├── 2602.12345.json
 *   │   └── ...
 *   └── signals.json        # 入库时的微感知信号
 *
 *   ~/.openclaw/memory-index/  (内部记忆，Phase R.2 创建)
 *   ├── graph.json
 *   ├── cards/
 *   └── signals.json
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ─── Types ───

export interface GraphNode {
  id: string;
  description: string;
  parent: string | null;
  items: string[]; // ContentCard IDs (e.g., "2602.12345" for papers, or custom IDs for memory)
  edges: GraphEdge[];
  lastReorgAt?: string; // ISO date — 上次重整时间（由 reorganizer apply 后写入）
  // Legacy property for backward compatibility (alias to items)
  papers?: string[];
}

export interface GraphEdge {
  target: string; // node ID
  relation: string;
}

export interface SemanticGraph {
  version: number;
  createdAt: string;
  updatedAt: string;
  nodes: GraphNode[];
}

export interface ContentCard {
  id: string;           // arXiv ID for papers, or custom ID for memory
  type: "paper" | "memory";
  title: string;
  oneLiner: string;     // 一句话概括
  source: string;       // e.g. "arxiv:cs.IR" for papers, "memory/decisions.md" for memory
  date: string;         // 发表日期或记忆日期
  // ── 可选字段（兼容旧数据和论文系统） ──
  tags?: string[];      // 论文系统仍使用；memory 不再生成
  qualitySignal?: string; // 论文系统仍使用；memory 不再生成
  url?: string;         // 论文链接或记忆文件链接
  generatedAt?: string; // 摘要卡生成时间
  sourceFile?: string;  // 源文件路径（仅 memory）
  people?: string[];    // 相关人物（企微 ID），parser 从人物词典匹配提取
}

// Legacy type alias for backward compatibility
export type SummaryCard = ContentCard;

export interface ClassificationSignal {
  itemId: string;       // ContentCard ID
  assignedNode: string;
  confidence: "high" | "medium" | "low";
  perception: string | null; // 微感知信号（如 "这篇和节点X的方向不太匹配"）
  timestamp: string;
}

export interface SignalsStore {
  signals: ClassificationSignal[];
}

// ─── Paths ───

const KNOWLEDGE_DIR = "knowledge";
const GRAPH_FILE = "graph.json";
const CARDS_DIR = "cards";
const SIGNALS_FILE = "signals.json";

export function getKnowledgeDir(dataDir: string): string {
  return join(dataDir, KNOWLEDGE_DIR);
}

function getGraphPath(dataDir: string): string {
  return join(getKnowledgeDir(dataDir), GRAPH_FILE);
}

function getCardsDir(dataDir: string): string {
  return join(getKnowledgeDir(dataDir), CARDS_DIR);
}

function getSignalsPath(dataDir: string): string {
  return join(getKnowledgeDir(dataDir), SIGNALS_FILE);
}

function getCardPath(dataDir: string, paperId: string): string {
  // arXiv IDs contain dots (e.g. "2602.12345"), safe for filenames
  return join(getCardsDir(dataDir), `${paperId}.json`);
}

// ─── Graph CRUD ───

const CURRENT_VERSION = 1;

function createEmptyGraph(): SemanticGraph {
  const now = new Date().toISOString();
  return {
    version: CURRENT_VERSION,
    createdAt: now,
    updatedAt: now,
    nodes: [
      {
        id: "root",
        description: "所有项目的根节点（冷启动状态）",
        parent: null,
        items: [],
        edges: [],
      },
    ],
  };
}

export async function ensureKnowledgeDir(dataDir: string): Promise<void> {
  await mkdir(getKnowledgeDir(dataDir), { recursive: true });
  await mkdir(getCardsDir(dataDir), { recursive: true });
}

export async function loadGraph(dataDir: string): Promise<SemanticGraph> {
  const graphPath = getGraphPath(dataDir);
  if (!existsSync(graphPath)) {
    return createEmptyGraph();
  }
  try {
    const raw = await readFile(graphPath, "utf-8");
    return JSON.parse(raw) as SemanticGraph;
  } catch {
    return createEmptyGraph();
  }
}

export async function saveGraph(dataDir: string, graph: SemanticGraph): Promise<void> {
  await ensureKnowledgeDir(dataDir);
  graph.updatedAt = new Date().toISOString();
  await writeFile(getGraphPath(dataDir), JSON.stringify(graph, null, 2), "utf-8");
}

export function getNode(graph: SemanticGraph, nodeId: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === nodeId);
}

export function addItemToNode(graph: SemanticGraph, nodeId: string, itemId: string): boolean {
  const node = getNode(graph, nodeId);
  if (!node) return false;
  if (node.items.includes(itemId)) return false; // already exists
  node.items.push(itemId);
  return true;
}

export function hasItem(graph: SemanticGraph, itemId: string): boolean {
  return graph.nodes.some((n) => n.items.includes(itemId));
}

// Legacy aliases for backward compatibility
export function addPaperToNode(graph: SemanticGraph, nodeId: string, paperId: string): boolean {
  return addItemToNode(graph, nodeId, paperId);
}

export function hasPaper(graph: SemanticGraph, paperId: string): boolean {
  return hasItem(graph, paperId);
}

// ─── Phase 2: 多节点操作 ───

/** 添加新节点到语义网 */
export function addNode(graph: SemanticGraph, node: GraphNode): boolean {
  if (graph.nodes.some((n) => n.id === node.id)) return false; // 已存在
  graph.nodes.push(node);
  return true;
}

/** 删除节点（不会迁移其下的论文，调用方需提前处理） */
export function removeNode(graph: SemanticGraph, nodeId: string): boolean {
  const idx = graph.nodes.findIndex((n) => n.id === nodeId);
  if (idx < 0) return false;
  graph.nodes.splice(idx, 1);
  // 清理其他节点指向此节点的边
  for (const n of graph.nodes) {
    n.edges = n.edges.filter((e) => e.target !== nodeId);
    if (n.parent === nodeId) n.parent = null;
  }
  return true;
}

/** 添加有向边 */
export function addEdge(graph: SemanticGraph, fromId: string, edge: GraphEdge): boolean {
  const node = getNode(graph, fromId);
  if (!node) return false;
  if (node.edges.some((e) => e.target === edge.target)) return false; // 已有
  node.edges.push(edge);
  return true;
}

/** 删除有向边 */
export function removeEdge(graph: SemanticGraph, fromId: string, targetId: string): boolean {
  const node = getNode(graph, fromId);
  if (!node) return false;
  const idx = node.edges.findIndex((e) => e.target === targetId);
  if (idx < 0) return false;
  node.edges.splice(idx, 1);
  return true;
}

/** 批量迁移项目：从 fromNode 移到 toNode */
export function moveItems(
  graph: SemanticGraph,
  itemIds: string[],
  fromId: string,
  toId: string,
): { moved: number; notFound: number } {
  const from = getNode(graph, fromId);
  const to = getNode(graph, toId);
  if (!from || !to) return { moved: 0, notFound: itemIds.length };

  let moved = 0;
  let notFound = 0;
  for (const iid of itemIds) {
    const idx = from.items.indexOf(iid);
    if (idx >= 0) {
      from.items.splice(idx, 1);
      if (!to.items.includes(iid)) {
        to.items.push(iid);
      }
      moved++;
    } else {
      notFound++;
    }
  }
  return { moved, notFound };
}

// Legacy alias for backward compatibility
export function movePapers(
  graph: SemanticGraph,
  paperIds: string[],
  fromId: string,
  toId: string,
): { moved: number; notFound: number } {
  return moveItems(graph, paperIds, fromId, toId);
}

/** 获取子节点（parent === nodeId 的所有节点） */
export function getChildren(graph: SemanticGraph, nodeId: string): GraphNode[] {
  return graph.nodes.filter((n) => n.parent === nodeId);
}

/** 获取邻居节点（通过 edge 连接的），返回 [节点, 边关系] */
export function getNeighbors(
  graph: SemanticGraph,
  nodeId: string,
): Array<{ node: GraphNode; relation: string }> {
  const source = getNode(graph, nodeId);
  if (!source) return [];
  const result: Array<{ node: GraphNode; relation: string }> = [];
  for (const edge of source.edges) {
    const target = getNode(graph, edge.target);
    if (target) {
      result.push({ node: target, relation: edge.relation });
    }
  }
  return result;
}

/** 获取所有顶层节点（parent === null 或 parent === "root"） */
export function getTopLevelNodes(graph: SemanticGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.parent === null || n.parent === "root");
}

/** 批量加载指定节点下所有项目的卡片 */
export async function loadNodeCards(
  dataDir: string,
  graph: SemanticGraph,
  nodeId: string,
): Promise<ContentCard[]> {
  const node = getNode(graph, nodeId);
  if (!node) return [];
  const cards: ContentCard[] = [];
  for (const iid of node.items) {
    const card = await loadCard(dataDir, iid);
    if (card) cards.push(card);
  }
  return cards;
}

/** 获取节点下的项目 ID 列表 */
export function getNodeItemIds(graph: SemanticGraph, nodeId: string): string[] {
  const node = getNode(graph, nodeId);
  return node ? [...node.items] : [];
}

// Legacy alias for backward compatibility
export function getNodePaperIds(graph: SemanticGraph, nodeId: string): string[] {
  return getNodeItemIds(graph, nodeId);
}

// ─── Content Card CRUD ───

export async function saveCard(dataDir: string, card: ContentCard): Promise<void> {
  await ensureKnowledgeDir(dataDir);
  const cardPath = getCardPath(dataDir, card.id);
  await writeFile(cardPath, JSON.stringify(card, null, 2), "utf-8");
}

export async function loadCard(dataDir: string, itemId: string): Promise<ContentCard | null> {
  const cardPath = getCardPath(dataDir, itemId);
  if (!existsSync(cardPath)) return null;
  try {
    const raw = await readFile(cardPath, "utf-8");
    return JSON.parse(raw) as ContentCard;
  } catch (error) {
    return null;
  }
}

// Legacy aliases for backward compatibility
export async function loadCardLegacy(dataDir: string, paperId: string): Promise<SummaryCard | null> {
  return loadCard(dataDir, paperId);
}

export async function cardExists(dataDir: string, paperId: string): Promise<boolean> {
  return existsSync(getCardPath(dataDir, paperId));
}

export async function listCardIds(dataDir: string): Promise<string[]> {
  const cardsDir = getCardsDir(dataDir);
  if (!existsSync(cardsDir)) return [];
  const files = await readdir(cardsDir);
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
}

// ─── Signals CRUD ───

export async function loadSignals(dataDir: string): Promise<SignalsStore> {
  const signalsPath = getSignalsPath(dataDir);
  if (!existsSync(signalsPath)) return { signals: [] };
  try {
    const raw = await readFile(signalsPath, "utf-8");
    return JSON.parse(raw) as SignalsStore;
  } catch {
    return { signals: [] };
  }
}

export async function appendSignal(dataDir: string, signal: ClassificationSignal): Promise<void> {
  await ensureKnowledgeDir(dataDir);
  const store = await loadSignals(dataDir);
  store.signals.push(signal);
  await writeFile(getSignalsPath(dataDir), JSON.stringify(store, null, 2), "utf-8");
}

// ─── Stats ───

export interface KnowledgeStats {
  nodeCount: number;
  totalItems: number;
  cardCount: number;
  signalCount: number;
  itemsByType: {
    paper: number;
    memory: number;
  };
}

export async function getStats(dataDir: string): Promise<KnowledgeStats> {
  const graph = await loadGraph(dataDir);
  const cardIds = await listCardIds(dataDir);
  const signals = await loadSignals(dataDir);

  const totalItems = graph.nodes.reduce((sum, n) => sum + n.items.length, 0);

  // Count items by type
  const itemsByType = { paper: 0, memory: 0 };
  for (const itemId of cardIds) {
    const card = await loadCard(dataDir, itemId);
    if (card) {
      itemsByType[card.type]++;
    }
  }

  return {
    nodeCount: graph.nodes.length,
    totalItems,
    cardCount: cardIds.length,
    signalCount: signals.signals.length,
    itemsByType,
  };
}
