/**
 * 内部记忆重整器 — 对 memory 图执行 LLM 驱动的节点分裂/归类
 *
 * 复用 knowledge/reorganizer.ts 的核心流程，但使用记忆专用的 prompt。
 * 适配点：
 * - Stage 1 prompt: "论文" → "记忆片段"，节点命名用日常用语
 * - Stage 2 prompt: "paperId" → "cardId"，摘要内容来自记忆
 * - 数据路径: memory-index 目录
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { loadRunEmbeddedPiAgent, collectText, stripCodeFences } from "../llm/loader.js";
import {
  loadGraph,
  saveGraph,
  getNode,
  addNode,
  addEdge,
  moveItems,
  loadNodeCards,
  type SemanticGraph,
  type GraphNode,
  type ContentCard,
} from "../knowledge/graph.js";

// ─── Types ───

export interface MemReorgResult {
  success: boolean;
  applied: boolean;
  error?: string;
  newNodes: Array<{ id: string; description: string; itemCount: number }>;
  movedItems: number;
  remainingItems: number;
  durationMs: number;
}

// ─── Prompts ───

const STAGE1_SYSTEM = `你是个人记忆组织专家。根据记忆片段的标签统计和样本内容，定义子节点来组织这些记忆。

输出 JSON（不要 markdown fence，不要额外解释）：

{
  "shouldSplit": true/false,
  "reason": "分裂/不分裂的理由",
  "newNodes": [
    {
      "id": "kebab-case-id",
      "description": "该节点涵盖的记忆主题方向（中文，1-2句话）",
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
- id 使用 kebab-case 英文，简短有意义（如 "sticker-traffic"、"team-collaboration"）
- **节点命名用日常用语**，如"推荐 Scaling"、"产品方法论"、"团队协作模式"，不要用算法编号
- 节点数量 3-8 个，覆盖所有主要方向
- keyTags 列出 3-5 个标志性标签
- 如果记忆数 <8 或主题高度统一，shouldSplit=false
- newEdges 描述方向之间的语义关系（如"为...提供技术基础"、"影响...的推进方式"）`;

function buildStage1Prompt(
  sourceNodeId: string,
  sourceDescription: string,
  totalItems: number,
  samples: Array<{ id: string; title: string; date: string; people: string[]; summary: string }>,
): string {
  const sampleList = samples
    .map((s) =>
      `  - [${s.id}] ${s.title}\n    日期: ${s.date} | 人物: ${(s.people ?? []).join(", ") || "无"}\n    摘要: ${s.summary}`,
    )
    .join("\n\n");

  return `节点「${sourceNodeId}」（${sourceDescription}）下共有 ${totalItems} 条记忆。

以下是 ${samples.length} 条代表性记忆片段：
${sampleList}

请根据以上信息，定义子节点来组织这些记忆。
注意：节点应覆盖大部分记忆方向，用日常用语命名。
请直接输出JSON。`;
}

const STAGE2_SYSTEM = `你是记忆归类助手。给定节点定义和一批记忆片段，为每条记忆选择最匹配的节点。

输出 JSON（不要 markdown fence，不要额外解释）：

{
  "assignments": [
    { "cardId": "xxx", "nodeId": "node-id", "secondary": null },
    { "cardId": "yyy", "nodeId": "node-id-1", "secondary": "node-id-2" }
  ]
}

规则：
- cardId 使用记忆的真实 ID
- nodeId: 最匹配的节点 ID
- secondary: 如果跨两个方向，填第二个节点 ID；否则 null
- 必须为批次中的每一条记忆输出归类结果
- 如果某条记忆和所有节点都不匹配，nodeId 设为 "root"`;

function buildStage2Prompt(
  nodes: Array<{ id: string; description: string; keyTags: string[] }>,
  batch: ContentCard[],
): string {
  const nodeList = nodes
    .map((n) => `  - [${n.id}] ${n.description} (keyTags: ${n.keyTags.join(", ")})`)
    .join("\n");

  const cardList = batch
    .map((c) =>
      `  - id=${c.id} | ${c.title}\n    Summary: ${c.oneLiner}\n    Date: ${c.date} | People: ${(c.people ?? []).join(", ") || "无"}`,
    )
    .join("\n\n");

  return `可选节点：
${nodeList}
  - [root] 不匹配任何节点的兜底

请为以下 ${batch.length} 条记忆选择归属节点：

${cardList}

请直接输出JSON（必须为每条记忆输出归类结果，使用真实 ID）。`;
}

// ─── Core ───

export async function reorganizeMemory(opts: {
  indexDir?: string;
  nodeId?: string;
  dryRun?: boolean;
  provider?: string;
  model?: string;
  agentDir?: string;
  config?: Record<string, unknown>;
  batchSize?: number;
}): Promise<MemReorgResult> {
  const indexDir = opts.indexDir ?? join(homedir(), ".openclaw", "memory-index");
  const nodeId = opts.nodeId ?? "daily-log"; // 默认对最大的日志节点重整
  const dryRun = opts.dryRun ?? false;
  const batchSize = opts.batchSize ?? 40;

  const start = Date.now();
  console.log(`[mem-reorg] Starting reorganization of "${nodeId}" (dryRun=${dryRun})`);

  const graph = await loadGraph(indexDir);
  const node = getNode(graph, nodeId);
  if (!node) {
    return { success: false, applied: false, error: `Node "${nodeId}" not found`, newNodes: [], movedItems: 0, remainingItems: 0, durationMs: 0 };
  }

  const cards = await loadNodeCards(indexDir, graph, nodeId);
  console.log(`[mem-reorg] Node "${nodeId}" has ${node.items.length} items, ${cards.length} loaded`);

  if (cards.length < 8) {
    return { success: true, applied: false, error: "Too few items to split", newNodes: [], movedItems: 0, remainingItems: cards.length, durationMs: Date.now() - start };
  }

  const runFn = await loadRunEmbeddedPiAgent();
  const tmpDir = join(indexDir, ".tmp-reorg");
  await mkdir(tmpDir, { recursive: true });

  const llmCallOpts = {
    provider: opts.provider,
    model: opts.model,
    agentDir: opts.agentDir ?? join(homedir(), ".openclaw", "agents", "main", "agent"),
    config: opts.config,
  };

  // ── Stage 1: 定义子节点 ──
  console.log("[mem-reorg] Stage 1: Defining sub-nodes...");

  const samples = selectSamples(cards, 30);
  console.log(`[mem-reorg] ${samples.length} samples selected`);

  const stage1Prompt = buildStage1Prompt(nodeId, node.description, cards.length, samples);
  const stage1Result = await callLLM(runFn, STAGE1_SYSTEM, stage1Prompt, tmpDir, llmCallOpts);

  // 解析 Stage 1 结果
  const cleaned1 = stripCodeFences(stage1Result);
  const json1Match = cleaned1.match(/\{[\s\S]*?"shouldSplit"[\s\S]*?\}/);
  if (!json1Match) {
    return { success: false, applied: false, error: `Stage 1: no JSON found: ${cleaned1.slice(0, 200)}`, newNodes: [], movedItems: 0, remainingItems: cards.length, durationMs: Date.now() - start };
  }

  let stage1: { shouldSplit: boolean; reason: string; newNodes: Array<{ id: string; description: string; keyTags: string[] }>; newEdges: Array<{ from: string; to: string; relation: string }> };
  try {
    stage1 = JSON.parse(extractTopLevelJson(cleaned1));
  } catch (err) {
    return { success: false, applied: false, error: `Stage 1: JSON parse error: ${(err as Error).message}`, newNodes: [], movedItems: 0, remainingItems: cards.length, durationMs: Date.now() - start };
  }

  if (!stage1.shouldSplit) {
    console.log(`[mem-reorg] Stage 1: No split needed — ${stage1.reason}`);
    return { success: true, applied: false, newNodes: [], movedItems: 0, remainingItems: cards.length, durationMs: Date.now() - start };
  }

  console.log(`[mem-reorg] Stage 1: ${stage1.newNodes.length} nodes defined`);
  for (const n of stage1.newNodes) {
    console.log(`  → [${n.id}] ${n.description}`);
  }

  // ── Stage 2: 批量归类 ──
  console.log(`[mem-reorg] Stage 2: Classifying ${cards.length} items in batches of ${batchSize}...`);

  const allAssignments = new Map<string, { primary: string; secondary: string | null }>();

  for (let i = 0; i < cards.length; i += batchSize) {
    const batch = cards.slice(i, i + batchSize);
    const batchIdx = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(cards.length / batchSize);
    console.log(`[mem-reorg] Batch ${batchIdx}/${totalBatches} (${batch.length} items)...`);

    try {
      const stage2Prompt = buildStage2Prompt(stage1.newNodes, batch);
      const stage2Result = await callLLM(runFn, STAGE2_SYSTEM, stage2Prompt, tmpDir, llmCallOpts);
      const cleaned2 = stripCodeFences(stage2Result);
      const json2 = extractTopLevelJson(cleaned2);
      const parsed2 = JSON.parse(json2) as { assignments: Array<{ cardId: string; nodeId: string; secondary: string | null }> };

      for (const a of parsed2.assignments) {
        allAssignments.set(a.cardId, { primary: a.nodeId, secondary: a.secondary });
      }
      console.log(`  ✅ ${parsed2.assignments.length} assignments`);
    } catch (err) {
      console.warn(`  ❌ Batch ${batchIdx} failed: ${(err as Error).message}`);
    }
  }

  console.log(`[mem-reorg] Stage 2 done: ${allAssignments.size}/${cards.length} classified`);

  // ── 组装结果 ──
  const nodeItems = new Map<string, string[]>();
  for (const n of stage1.newNodes) {
    nodeItems.set(n.id, []);
  }

  const remaining: string[] = [];
  for (const card of cards) {
    const a = allAssignments.get(card.id);
    if (!a || a.primary === "root") {
      remaining.push(card.id);
      continue;
    }
    const items = nodeItems.get(a.primary);
    if (items) {
      items.push(card.id);
    } else {
      remaining.push(card.id);
    }
    if (a.secondary && a.secondary !== "root") {
      const secItems = nodeItems.get(a.secondary);
      if (secItems && !secItems.includes(card.id)) {
        secItems.push(card.id);
      }
    }
  }

  // 过滤空节点
  const resultNodes: Array<{ id: string; description: string; itemCount: number }> = [];
  for (const n of stage1.newNodes) {
    const items = nodeItems.get(n.id) ?? [];
    if (items.length >= 2) {
      resultNodes.push({ id: n.id, description: n.description, itemCount: items.length });
    } else {
      remaining.push(...items);
      console.warn(`[mem-reorg] Node "${n.id}" has only ${items.length} items, merging back`);
    }
  }

  const movedItems = resultNodes.reduce((s, n) => s + n.itemCount, 0);
  console.log(`\n[mem-reorg] Result: ${resultNodes.length} nodes, ${movedItems} moved, ${remaining.length} remaining`);
  for (const n of resultNodes) {
    console.log(`  → [${n.id}] ${n.description} (${n.itemCount} items)`);
  }

  if (dryRun) {
    console.log("[mem-reorg] Dry run — not applying changes");
  } else {
    // Apply: 添加子节点并移动 items
    for (const n of resultNodes) {
      const stageNode = stage1.newNodes.find((sn) => sn.id === n.id)!;
      addNode(graph, {
        id: n.id,
        description: n.description,
        parent: nodeId,
        items: nodeItems.get(n.id) ?? [],
        edges: [],
      });

      // 从源节点移除这些 items
      const srcNode = getNode(graph, nodeId)!;
      const itemsToMove = nodeItems.get(n.id) ?? [];
      srcNode.items = srcNode.items.filter((id) => !itemsToMove.includes(id));
    }

    // 添加边
    const validIds = new Set(resultNodes.map((n) => n.id));
    for (const e of stage1.newEdges ?? []) {
      if (validIds.has(e.from) && validIds.has(e.to)) {
        addEdge(graph, e.from, { target: e.to, relation: e.relation });
      }
    }

    // 添加从源节点到新子节点的边
    for (const n of resultNodes) {
      addEdge(graph, nodeId, { target: n.id, relation: `包含${n.description}` });
    }

    await saveGraph(indexDir, graph);
    console.log("[mem-reorg] Applied successfully");
  }

  // 清理
  try {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  } catch {}

  return {
    success: true,
    applied: !dryRun,
    newNodes: resultNodes,
    movedItems,
    remainingItems: remaining.length,
    durationMs: Date.now() - start,
  };
}

// ─── Helpers ───

function selectSamples(
  cards: ContentCard[],
  maxSamples: number,
): Array<{ id: string; title: string; date: string; people: string[]; summary: string }> {
  // 按日期排序，取最近的样本，确保多样性
  const sorted = [...cards].sort((a, b) => b.date.localeCompare(a.date));
  const samples: Array<{ id: string; title: string; date: string; people: string[]; summary: string }> = [];

  // 先取最近的样本
  for (const c of sorted) {
    if (samples.length >= maxSamples) break;
    samples.push({
      id: c.id,
      title: c.title,
      date: c.date,
      people: c.people ?? [],
      summary: c.oneLiner,
    });
  }

  return samples;
}

async function callLLM(
  runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>,
  systemPrompt: string,
  userPrompt: string,
  tmpDir: string,
  opts: { provider?: string; model?: string; agentDir?: string; config?: Record<string, unknown> },
): Promise<string> {
  const runId = randomUUID();
  const sessionId = `mem-reorg-${runId.slice(0, 12)}`;
  const workDir = join(tmpDir, sessionId);
  await mkdir(workDir, { recursive: true });
  const sessionFile = join(workDir, `${sessionId}.json`);

  const sessionHeader = {
    type: "session",
    version: 2,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: workDir,
  };
  await writeFile(sessionFile, `${JSON.stringify(sessionHeader)}\n`, "utf-8");

  try {
    const result = await runFn({
      sessionId,
      sessionFile,
      workspaceDir: workDir,
      prompt: userPrompt,
      extraSystemPrompt: systemPrompt,
      timeoutMs: 120_000,
      runId,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.config ? { config: opts.config } : {}),
    });

    const text = collectText(result.payloads);
    if (!text) throw new Error("LLM returned empty response");
    return text;
  } finally {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(workDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 从可能包含额外文本的 LLM 响应中提取顶层 JSON 对象（括号计数法）
 */
function extractTopLevelJson(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) throw new Error("No { found");

  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced JSON braces");
}

// ─── CLI ───

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");

  const { values } = parseArgs({
    options: {
      "index-dir": { type: "string" },
      "node-id": { type: "string", short: "n" },
      "dry-run": { type: "boolean" },
      provider: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      "batch-size": { type: "string" },
    },
  });

  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  let config: Record<string, unknown> | undefined;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {}

  const result = await reorganizeMemory({
    indexDir: values["index-dir"],
    nodeId: values["node-id"],
    dryRun: values["dry-run"] ?? false,
    provider: values.provider ?? process.env.PERSONAL_REC_PROVIDER ?? "alibaba",
    model: values.model ?? process.env.PERSONAL_REC_MODEL ?? "qwen3-coder-plus",
    config,
    batchSize: values["batch-size"] ? parseInt(values["batch-size"], 10) : undefined,
  });

  console.log(`\n📊 重整结果: ${JSON.stringify(result, null, 2)}`);
}
