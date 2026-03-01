/**
 * 语义网重整器 — LLM 驱动的节点分裂/合并/建边
 *
 * 两阶段策略：
 * - Stage 1: 只发 tags 频率 + 代表性论文标题 → LLM 定义 5-10 个子节点 + 边
 * - Stage 2: 分批发论文摘要（每批 ~50 篇）→ LLM 逐篇归类到子节点
 *
 * 优势：
 * - Stage 1 prompt 很短（~5KB），不会超 context
 * - Stage 2 每批独立，支持并发，单批失败可重试
 * - Paper ID 永远使用真实 arXiv ID，无序号混淆
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { loadRunEmbeddedPiAgent, collectText, stripCodeFences } from "../llm/loader.js";
import {
  loadGraph,
  saveGraph,
  getNode,
  addNode,
  addEdge,
  movePapers,
  loadNodeCards,
  type SemanticGraph,
  type GraphNode,
  type SummaryCard,
} from "./graph.js";

// ─── Types ───

export interface ReorgNewNode {
  id: string;
  description: string;
  keyTags: string[];   // 该节点的标志性 tags
  papers: string[];    // Stage 2 填充
}

export interface ReorgNewEdge {
  from: string;
  to: string;
  relation: string;
}

export interface ReorgDiff {
  sourceNode: string;
  newNodes: ReorgNewNode[];
  newEdges: ReorgNewEdge[];
  remainingPapers: string[];
}

export interface ReorgResult {
  success: boolean;
  diff: ReorgDiff | null;
  applied: boolean;
  error?: string;
  meta?: {
    durationMs: number;
    inputCards: number;
    newNodeCount: number;
    newEdgeCount: number;
    movedPapers: number;
    remainingPapers: number;
    stage1Ms: number;
    stage2Ms: number;
    batchCount: number;
  };
}

export interface ReorgLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ReorgOpts {
  logger: ReorgLogger;
  nodeId?: string;
  dryRun?: boolean;
  provider?: string;
  model?: string;
  agentDir?: string;
  config?: Record<string, unknown>;
  batchSize?: number;       // Stage 2 每批论文数，默认 50
  concurrency?: number;     // Stage 2 并发批数，默认 1（串行更稳定）
}

// ─── Prompts ───

const STAGE1_SYSTEM = `你是知识图谱组织专家。根据论文 tag 统计和代表性标题，定义子节点和边。

输出 JSON（不要 markdown fence，不要额外解释）：

{
  "shouldSplit": true/false,
  "reason": "分裂/不分裂的理由",
  "newNodes": [
    {
      "id": "kebab-case-id",
      "description": "该节点涵盖的主题方向（中文，1-2句话，包含关键术语）",
      "keyTags": ["tag1", "tag2", "tag3"]
    }
  ],
  "newEdges": [
    {
      "from": "node-id-1",
      "to": "node-id-2",
      "relation": "关系描述（中文）"
    }
  ]
}

规则：
- id 使用 kebab-case 英文，简短有意义
- 节点数量 5-10 个，覆盖所有主要方向，不要过于细碎也不要过于笼统
- keyTags 列出 3-5 个该方向的标志性 tag，用于后续归类
- 如果论文数 <10 或主题高度统一，shouldSplit=false
- newEdges 描述节点间的语义关系`;

function buildStage1Prompt(
  sourceNodeId: string,
  sourceDescription: string,
  totalPapers: number,
  tagStats: Array<{ tag: string; count: number }>,
  sampleTitles: Array<{ id: string; title: string; tags: string[] }>,
): string {
  const tagList = tagStats
    .map((t) => `  ${t.tag}: ${t.count}`)
    .join("\n");

  const titleList = sampleTitles
    .map((t) => `  - [${t.id}] ${t.title} (tags: ${t.tags.join(", ")})`)
    .join("\n");

  return `节点「${sourceNodeId}」（${sourceDescription}）下共有 ${totalPapers} 篇论文。

以下是 tag 出现频率统计（出现 ≥2 次的 tag）：
${tagList}

以下是 ${sampleTitles.length} 篇代表性论文（每个 tag 方向抽取 1-2 篇）：
${titleList}

请根据以上信息，定义子节点来组织这些论文。
注意：节点应覆盖大部分论文方向，不只是最热门的 tag。
请直接输出JSON。`;
}

const STAGE2_SYSTEM = `你是论文归类助手。给定节点定义和一批论文，为每篇论文选择最匹配的节点。

输出 JSON（不要 markdown fence，不要额外解释）：

{
  "assignments": [
    { "paperId": "2602.xxxxx", "nodeId": "node-id", "secondary": null },
    { "paperId": "2602.yyyyy", "nodeId": "node-id-1", "secondary": "node-id-2" }
  ]
}

规则：
- paperId 必须使用论文的真实 ID（如 "2602.12345"），不要使用序号
- nodeId: 最匹配的节点 ID
- secondary: 如果论文跨两个方向，填第二个节点 ID；否则 null
- 必须为批次中的每一篇论文都输出归类结果，不要遗漏
- 如果某篇论文和所有节点都不太匹配，nodeId 设为 "root"`;

function buildStage2Prompt(
  nodes: Array<{ id: string; description: string; keyTags: string[] }>,
  batch: SummaryCard[],
): string {
  const nodeList = nodes
    .map((n) => `  - [${n.id}] ${n.description} (keyTags: ${n.keyTags.join(", ")})`)
    .join("\n");

  const paperList = batch
    .map((c) =>
      `  - id=${c.id} | ${c.title}\n    Tags: ${c.tags.join(", ")}\n    Summary: ${c.oneLiner}`,
    )
    .join("\n\n");

  return `可选节点：
${nodeList}
  - [root] 不匹配任何节点的兜底

请为以下 ${batch.length} 篇论文选择归属节点：

${paperList}

请直接输出JSON（必须为每篇论文输出归类结果，使用论文真实 ID 如 "2602.xxxxx"）。`;
}

// ─── Core ───

export async function reorganize(
  dataDir: string,
  opts: ReorgOpts,
): Promise<ReorgResult> {
  const {
    logger, nodeId = "root", dryRun = false,
    provider, model, agentDir, config,
    batchSize = 50, concurrency = 1,
  } = opts;

  logger.info(`[reorganizer] Starting reorganization of node "${nodeId}" (dryRun=${dryRun})`);

  const graph = await loadGraph(dataDir);
  const node = getNode(graph, nodeId);
  if (!node) {
    return { success: false, diff: null, applied: false, error: `Node "${nodeId}" not found` };
  }

  const cards = await loadNodeCards(dataDir, graph, nodeId);
  if (cards.length === 0) {
    return { success: false, diff: null, applied: false, error: `Node "${nodeId}" has no cards` };
  }

  logger.info(`[reorganizer] Node "${nodeId}" has ${node.papers.length} papers, ${cards.length} with cards`);

  const llmOpts = { provider, model, agentDir, config, dataDir };
  const overallStart = Date.now();

  // ── Stage 1: 定义节点 ──
  logger.info("[reorganizer] Stage 1: Defining sub-nodes from tag statistics...");
  const stage1Start = Date.now();

  const { tagStats, sampleTitles } = computeTagStats(cards);
  logger.info(`[reorganizer] Tag stats: ${tagStats.length} unique tags (≥2), ${sampleTitles.length} sample titles`);

  let stage1Result: Stage1Result;
  try {
    stage1Result = await callStage1(node, cards.length, tagStats, sampleTitles, llmOpts);
  } catch (err) {
    return { success: false, diff: null, applied: false, error: `Stage 1 failed: ${(err as Error).message}` };
  }
  const stage1Ms = Date.now() - stage1Start;

  if (!stage1Result.shouldSplit) {
    logger.info(`[reorganizer] Stage 1: No split needed — ${stage1Result.reason}`);
    return {
      success: true,
      diff: { sourceNode: nodeId, newNodes: [], newEdges: [], remainingPapers: node.papers },
      applied: false,
      meta: {
        durationMs: Date.now() - overallStart,
        inputCards: cards.length,
        newNodeCount: 0, newEdgeCount: 0, movedPapers: 0, remainingPapers: cards.length,
        stage1Ms, stage2Ms: 0, batchCount: 0,
      },
    };
  }

  logger.info(`[reorganizer] Stage 1 done (${stage1Ms}ms): ${stage1Result.nodes.length} nodes, ${stage1Result.edges.length} edges`);
  for (const n of stage1Result.nodes) {
    logger.info(`  → [${n.id}] ${n.description} (keyTags: ${n.keyTags.join(", ")})`);
  }
  for (const e of stage1Result.edges) {
    logger.info(`  → edge: ${e.from} --"${e.relation}"--> ${e.to}`);
  }

  // ── Stage 2: 批量归类 ──
  logger.info(`[reorganizer] Stage 2: Classifying ${cards.length} papers in batches of ${batchSize}...`);
  const stage2Start = Date.now();

  const batches: SummaryCard[][] = [];
  for (let i = 0; i < cards.length; i += batchSize) {
    batches.push(cards.slice(i, i + batchSize));
  }

  const nodeDefinitions = stage1Result.nodes.map((n) => ({
    id: n.id,
    description: n.description,
    keyTags: n.keyTags,
  }));

  // 收集所有归类结果
  const allAssignments: Map<string, { primary: string; secondary: string | null }> = new Map();
  let batchesDone = 0;

  // 按 concurrency 控制并发
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const promises = chunk.map(async (batch, ci) => {
      const batchIdx = i + ci;
      logger.info(`[reorganizer] Stage 2 batch ${batchIdx + 1}/${batches.length} (${batch.length} papers)...`);
      try {
        const assignments = await callStage2(nodeDefinitions, batch, llmOpts);
        for (const a of assignments) {
          allAssignments.set(a.paperId, { primary: a.nodeId, secondary: a.secondary });
        }
        batchesDone++;
        logger.info(`[reorganizer] Stage 2 batch ${batchIdx + 1} done: ${assignments.length} assignments`);
      } catch (err) {
        logger.warn(`[reorganizer] Stage 2 batch ${batchIdx + 1} failed: ${(err as Error).message}`);
        // 失败的论文留在 root
      }
    });
    await Promise.all(promises);
  }
  const stage2Ms = Date.now() - stage2Start;

  logger.info(`[reorganizer] Stage 2 done (${stage2Ms}ms): ${allAssignments.size}/${cards.length} papers classified`);

  // ── 组装 Diff ──
  const newNodesMap = new Map<string, ReorgNewNode>();
  for (const nd of stage1Result.nodes) {
    newNodesMap.set(nd.id, { id: nd.id, description: nd.description, keyTags: nd.keyTags, papers: [] });
  }

  const remainingPapers: string[] = [];
  for (const card of cards) {
    const assignment = allAssignments.get(card.id);
    if (!assignment || assignment.primary === "root") {
      remainingPapers.push(card.id);
      continue;
    }
    const primaryNode = newNodesMap.get(assignment.primary);
    if (primaryNode) {
      primaryNode.papers.push(card.id);
    } else {
      remainingPapers.push(card.id);
    }
    if (assignment.secondary && assignment.secondary !== "root") {
      const secNode = newNodesMap.get(assignment.secondary);
      if (secNode && !secNode.papers.includes(card.id)) {
        secNode.papers.push(card.id);
      }
    }
  }

  // 过滤掉空节点（少于 3 篇的合并回 root）
  const validNodes: ReorgNewNode[] = [];
  for (const nn of newNodesMap.values()) {
    if (nn.papers.length >= 3) {
      validNodes.push(nn);
    } else {
      remainingPapers.push(...nn.papers);
      logger.warn(`[reorganizer] Node "${nn.id}" has only ${nn.papers.length} papers, merging back to root`);
    }
  }

  // 过滤掉引用了已移除节点的边
  const validNodeIds = new Set(validNodes.map((n) => n.id));
  const validEdges = stage1Result.edges.filter(
    (e) => validNodeIds.has(e.from) && validNodeIds.has(e.to),
  );

  const diff: ReorgDiff = {
    sourceNode: nodeId,
    newNodes: validNodes,
    newEdges: validEdges,
    remainingPapers: [...new Set(remainingPapers)], // 去重
  };

  const movedPapers = validNodes.reduce((s, n) => s + n.papers.length, 0);
  const durationMs = Date.now() - overallStart;

  logger.info(`\n[reorganizer] Final diff: ${validNodes.length} nodes, ${validEdges.length} edges, ${movedPapers} moved, ${diff.remainingPapers.length} remaining`);
  for (const nn of validNodes) {
    logger.info(`  → [${nn.id}] ${nn.description} (${nn.papers.length} papers)`);
  }

  if (dryRun) {
    logger.info("[reorganizer] Dry run — not applying changes");
    return {
      success: true, diff, applied: false,
      meta: {
        durationMs, inputCards: cards.length,
        newNodeCount: validNodes.length, newEdgeCount: validEdges.length,
        movedPapers, remainingPapers: diff.remainingPapers.length,
        stage1Ms, stage2Ms, batchCount: batches.length,
      },
    };
  }

  // ── Apply ──
  applyDiff(graph, diff, nodeId);
  await saveGraph(dataDir, graph);
  logger.info(`[reorganizer] Applied: ${validNodes.length} nodes, ${validEdges.length} edges, ${movedPapers} papers moved`);

  return {
    success: true, diff, applied: true,
    meta: {
      durationMs, inputCards: cards.length,
      newNodeCount: validNodes.length, newEdgeCount: validEdges.length,
      movedPapers, remainingPapers: diff.remainingPapers.length,
      stage1Ms, stage2Ms, batchCount: batches.length,
    },
  };
}

// ─── Tag Statistics ───

interface TagStatsResult {
  tagStats: Array<{ tag: string; count: number }>;
  sampleTitles: Array<{ id: string; title: string; tags: string[] }>;
}

function computeTagStats(cards: SummaryCard[]): TagStatsResult {
  // 统计 tag 频率
  const counter = new Map<string, number>();
  for (const c of cards) {
    for (const t of c.tags) {
      counter.set(t, (counter.get(t) ?? 0) + 1);
    }
  }

  // 只保留出现 ≥2 次的 tag，按频率降序
  const tagStats = [...counter.entries()]
    .filter(([, cnt]) => cnt >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  // 为每个 top tag 抽取 1-2 篇代表性论文（不重复）
  const usedIds = new Set<string>();
  const sampleTitles: Array<{ id: string; title: string; tags: string[] }> = [];
  const maxSamples = Math.min(60, cards.length); // 限制总量

  for (const { tag } of tagStats) {
    if (sampleTitles.length >= maxSamples) break;
    const matching = cards.filter((c) => c.tags.includes(tag) && !usedIds.has(c.id));
    for (const m of matching.slice(0, 2)) {
      if (sampleTitles.length >= maxSamples) break;
      usedIds.add(m.id);
      sampleTitles.push({ id: m.id, title: m.title, tags: m.tags });
    }
  }

  return { tagStats, sampleTitles };
}

// ─── Stage 1: Define Nodes ───

interface Stage1Result {
  shouldSplit: boolean;
  reason: string;
  nodes: Array<{ id: string; description: string; keyTags: string[] }>;
  edges: ReorgNewEdge[];
}

async function callStage1(
  node: GraphNode,
  totalPapers: number,
  tagStats: Array<{ tag: string; count: number }>,
  sampleTitles: Array<{ id: string; title: string; tags: string[] }>,
  opts: { provider?: string; model?: string; agentDir?: string; config?: Record<string, unknown>; dataDir: string },
): Promise<Stage1Result> {
  const runFn = await loadRunEmbeddedPiAgent();
  const tmpDir = join(opts.dataDir, ".tmp-sessions");
  await mkdir(tmpDir, { recursive: true });

  const runId = randomUUID();
  const sessionId = `reorg-s1-${node.id}-${runId.slice(0, 8)}`;
  const workDir = join(tmpDir, sessionId);
  await mkdir(workDir, { recursive: true });
  const sessionFile = join(workDir, `${sessionId}.json`);

  await writeFile(sessionFile, `${JSON.stringify({
    type: "session", version: 2, id: sessionId,
    timestamp: new Date().toISOString(), cwd: workDir,
  })}\n`, "utf-8");

  try {
    const result = await runFn({
      sessionId, sessionFile, workspaceDir: workDir,
      prompt: buildStage1Prompt(node.id, node.description, totalPapers, tagStats, sampleTitles),
      extraSystemPrompt: STAGE1_SYSTEM,
      timeoutMs: 60_000, runId,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.config ? { config: opts.config } : {}),
    });

    const text = collectText(result.payloads);
    if (!text) throw new Error("LLM returned empty response");

    const jsonStr = extractTopLevelJson(stripCodeFences(text));
    if (!jsonStr) throw new Error(`No JSON in Stage 1 response: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonStr) as {
      shouldSplit: boolean;
      reason: string;
      newNodes?: Array<{ id: string; description: string; keyTags?: string[] }>;
      newEdges?: ReorgNewEdge[];
    };

    return {
      shouldSplit: parsed.shouldSplit,
      reason: parsed.reason,
      nodes: (parsed.newNodes ?? []).map((n) => ({
        id: n.id,
        description: n.description,
        keyTags: n.keyTags ?? [],
      })),
      edges: parsed.newEdges ?? [],
    };
  } finally {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

// ─── Stage 2: Batch Classify ───

interface Stage2Assignment {
  paperId: string;
  nodeId: string;
  secondary: string | null;
}

async function callStage2(
  nodes: Array<{ id: string; description: string; keyTags: string[] }>,
  batch: SummaryCard[],
  opts: { provider?: string; model?: string; agentDir?: string; config?: Record<string, unknown>; dataDir: string },
): Promise<Stage2Assignment[]> {
  const runFn = await loadRunEmbeddedPiAgent();
  const tmpDir = join(opts.dataDir, ".tmp-sessions");
  await mkdir(tmpDir, { recursive: true });

  const runId = randomUUID();
  const sessionId = `reorg-s2-${runId.slice(0, 8)}`;
  const workDir = join(tmpDir, sessionId);
  await mkdir(workDir, { recursive: true });
  const sessionFile = join(workDir, `${sessionId}.json`);

  await writeFile(sessionFile, `${JSON.stringify({
    type: "session", version: 2, id: sessionId,
    timestamp: new Date().toISOString(), cwd: workDir,
  })}\n`, "utf-8");

  try {
    const result = await runFn({
      sessionId, sessionFile, workspaceDir: workDir,
      prompt: buildStage2Prompt(nodes, batch),
      extraSystemPrompt: STAGE2_SYSTEM,
      timeoutMs: 90_000, runId,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.config ? { config: opts.config } : {}),
    });

    const text = collectText(result.payloads);
    if (!text) throw new Error("LLM returned empty response");

    const jsonStr = extractTopLevelJson(stripCodeFences(text));
    if (!jsonStr) throw new Error(`No JSON in Stage 2 response: ${text.slice(0, 200)}`);

    const parsed = JSON.parse(jsonStr) as {
      assignments?: Array<{ paperId: string; nodeId: string; secondary?: string | null }>;
    };

    // 验证 paperId 是真实 ID（不是序号）
    const batchIds = new Set(batch.map((c) => c.id));
    const assignments: Stage2Assignment[] = [];

    for (const a of parsed.assignments ?? []) {
      if (batchIds.has(a.paperId)) {
        assignments.push({
          paperId: a.paperId,
          nodeId: a.nodeId,
          secondary: a.secondary ?? null,
        });
      }
      // 序号会被静默忽略（不在 batchIds 中）
    }

    return assignments;
  } finally {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

// ─── JSON 提取（括号计数法，支持嵌套） ───

function extractTopLevelJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

// ─── Apply Diff ───

function applyDiff(graph: SemanticGraph, diff: ReorgDiff, parentId: string): void {
  for (const nn of diff.newNodes) {
    const newNode: GraphNode = {
      id: nn.id,
      description: nn.description,
      parent: parentId,
      papers: [],
      edges: [],
    };
    addNode(graph, newNode);
  }

  for (const nn of diff.newNodes) {
    movePapers(graph, nn.papers, parentId, nn.id);
  }

  for (const ne of diff.newEdges) {
    addEdge(graph, ne.from, { target: ne.to, relation: ne.relation });
    addEdge(graph, ne.to, { target: ne.from, relation: ne.relation });
  }

  const parent = getNode(graph, parentId);
  if (parent && parent.description.includes("冷启动")) {
    parent.description = parent.description.replace("（冷启动状态）", "（已分裂）");
  }
}
