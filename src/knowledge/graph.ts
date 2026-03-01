/**
 * 语义网 CRUD — 管理 knowledge/graph.json 和 cards/ 目录
 *
 * 数据结构：
 *   ~/.openclaw/personal-rec/knowledge/
 *   ├── graph.json          # 语义网（节点 + 边）
 *   ├── cards/              # 摘要卡 JSON 文件
 *   │   ├── 2602.12345.json
 *   │   └── ...
 *   └── signals.json        # 入库时的微感知信号
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// ─── Types ───

export interface GraphNode {
  id: string;
  description: string;
  parent: string | null;
  papers: string[]; // paper IDs (arXiv IDs like "2602.12345")
  edges: GraphEdge[];
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

export interface SummaryCard {
  id: string;           // arXiv ID
  title: string;
  tags: string[];       // 2-3 个关键标签
  oneLiner: string;     // 一句话概括
  qualitySignal: string;
  source: string;       // e.g. "arxiv:cs.IR"
  date: string;         // 发表日期
  url: string;
  generatedAt: string;  // 摘要卡生成时间
}

export interface ClassificationSignal {
  paperId: string;
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
        description: "所有论文的根节点（冷启动状态）",
        parent: null,
        papers: [],
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

export function addPaperToNode(graph: SemanticGraph, nodeId: string, paperId: string): boolean {
  const node = getNode(graph, nodeId);
  if (!node) return false;
  if (node.papers.includes(paperId)) return false; // already exists
  node.papers.push(paperId);
  return true;
}

export function hasPaper(graph: SemanticGraph, paperId: string): boolean {
  return graph.nodes.some((n) => n.papers.includes(paperId));
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

/** 批量迁移论文：从 fromNode 移到 toNode */
export function movePapers(
  graph: SemanticGraph,
  paperIds: string[],
  fromId: string,
  toId: string,
): { moved: number; notFound: number } {
  const from = getNode(graph, fromId);
  const to = getNode(graph, toId);
  if (!from || !to) return { moved: 0, notFound: paperIds.length };

  let moved = 0;
  let notFound = 0;
  for (const pid of paperIds) {
    const idx = from.papers.indexOf(pid);
    if (idx >= 0) {
      from.papers.splice(idx, 1);
      if (!to.papers.includes(pid)) {
        to.papers.push(pid);
      }
      moved++;
    } else {
      notFound++;
    }
  }
  return { moved, notFound };
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

/** 批量加载指定节点下所有论文的摘要卡 */
export async function loadNodeCards(
  dataDir: string,
  graph: SemanticGraph,
  nodeId: string,
): Promise<SummaryCard[]> {
  const node = getNode(graph, nodeId);
  if (!node) return [];
  const cards: SummaryCard[] = [];
  for (const pid of node.papers) {
    const card = await loadCard(dataDir, pid);
    if (card) cards.push(card);
  }
  return cards;
}

// ─── Summary Card CRUD ───

export async function saveCard(dataDir: string, card: SummaryCard): Promise<void> {
  await ensureKnowledgeDir(dataDir);
  const cardPath = getCardPath(dataDir, card.id);
  await writeFile(cardPath, JSON.stringify(card, null, 2), "utf-8");
}

export async function loadCard(dataDir: string, paperId: string): Promise<SummaryCard | null> {
  const cardPath = getCardPath(dataDir, paperId);
  if (!existsSync(cardPath)) return null;
  try {
    const raw = await readFile(cardPath, "utf-8");
    return JSON.parse(raw) as SummaryCard;
  } catch {
    return null;
  }
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
  totalPapers: number;
  cardCount: number;
  signalCount: number;
}

export async function getStats(dataDir: string): Promise<KnowledgeStats> {
  const graph = await loadGraph(dataDir);
  const cardIds = await listCardIds(dataDir);
  const signals = await loadSignals(dataDir);

  const totalPapers = graph.nodes.reduce((sum, n) => sum + n.papers.length, 0);

  return {
    nodeCount: graph.nodes.length,
    totalPapers,
    cardCount: cardIds.length,
    signalCount: signals.signals.length,
  };
}
