/**
 * 入库归类器 — 将摘要卡挂到语义网节点 + 输出 ClassificationSignal
 *
 * Phase 1: 所有论文归到 root 节点（单节点）
 * Phase 2: LLM 读节点描述列表 → 选择最匹配的节点归类（多节点），支持多归属
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import {
  loadGraph,
  saveGraph,
  addPaperToNode,
  hasPaper,
  loadCard,
  listCardIds,
  appendSignal,
  getNode,
  getChildren,
  type ClassificationSignal,
  type SummaryCard,
  type SemanticGraph,
  type GraphNode,
} from "../knowledge/graph.js";
import { loadRunEmbeddedPiAgent, collectText, stripCodeFences } from "../llm/loader.js";

// ─── Types ───

export interface ClassifyLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ClassifyResult {
  total: number;
  classified: number;
  skipped: number; // 已在 graph 中
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

export interface ClassifyOpts {
  logger: ClassifyLogger;
  targetNode?: string; // Phase 1: 固定 "root"，Phase 2: 忽略（LLM 选择）
  provider?: string;
  model?: string;
  agentDir?: string;
  config?: Record<string, unknown>;
}

// ─── Prompt (Phase 2) ───

const CLASSIFY_SYSTEM_PROMPT = `你是论文归类助手。给定一篇论文的摘要卡和可选节点列表，选择最匹配的节点。

输出 JSON（不要 markdown fence，不要额外解释）：

{
  "assignedNodes": ["node-id-1"],
  "confidence": "high" | "medium" | "low",
  "perception": "微感知信号（如果论文和所有节点都不太匹配，描述原因）或 null"
}

规则：
- assignedNodes: 选 1-2 个最匹配的节点 ID
- 如果论文只匹配一个节点，只输出一个
- 如果论文跨两个方向，可输出两个（多归属）
- confidence: 有明确匹配的用 "high"，勉强匹配用 "medium"，都不太合适用 "low"
- perception: confidence 为 "low" 时必须说明原因（用于触发未来的重整），否则为 null`;

function buildClassifyPrompt(card: SummaryCard, nodes: GraphNode[]): string {
  const nodeList = nodes
    .map((n) => `  - [${n.id}] ${n.description} (${n.papers.length} papers)`)
    .join("\n");

  return `请为以下论文选择归属节点：

Paper: ${card.title}
Tags: ${card.tags.join(", ")}
Summary: ${card.oneLiner}
Signal: ${card.qualitySignal}

可选节点：
${nodeList}

请直接输出JSON（不要markdown fence，不要解释，不要使用任何工具）。`;
}

// ─── Classifier ───

/**
 * 对指定的摘要卡执行入库归类。
 *
 * Phase 2 逻辑：
 * - 如果 graph 只有 root（没有子节点）→ fallback Phase 1 行为（全归 root）
 * - 如果有多个节点 → LLM 选择归到哪个节点
 */
export async function classifyCards(
  dataDir: string,
  cardIds: string[] | undefined,
  opts: ClassifyOpts,
): Promise<ClassifyResult> {
  const { logger } = opts;

  const graph = await loadGraph(dataDir);
  const ids = cardIds && cardIds.length > 0 ? cardIds : await listCardIds(dataDir);
  const result: ClassifyResult = { total: ids.length, classified: 0, skipped: 0, failed: 0, errors: [] };

  // 判断使用 Phase 1 还是 Phase 2 模式
  const children = getChildren(graph, "root");
  const usePhase2 = children.length > 0;

  if (usePhase2) {
    logger.info(`[classifier] Phase 2 mode: ${children.length} sub-nodes available, LLM-assisted classification`);
    await classifyWithLLM(dataDir, graph, ids, children, result, opts);
  } else {
    logger.info(`[classifier] Phase 1 mode: single root node, direct classification`);
    await classifyToRoot(graph, dataDir, ids, result, logger);
  }

  await saveGraph(dataDir, graph);

  logger.info(
    `[classifier] done: ${result.classified} classified, ${result.skipped} skipped, ${result.failed} failed / ${result.total} total`,
  );

  return result;
}

// ─── Phase 1: 直接归 root ───

async function classifyToRoot(
  graph: SemanticGraph,
  dataDir: string,
  ids: string[],
  result: ClassifyResult,
  logger: ClassifyLogger,
): Promise<void> {
  const targetNode = "root";
  logger.info(`[classifier] Processing ${ids.length} cards → node "${targetNode}"`);

  for (let i = 0; i < ids.length; i++) {
    const paperId = ids[i];

    if (hasPaper(graph, paperId)) {
      result.skipped++;
      continue;
    }

    try {
      const card = await loadCard(dataDir, paperId);
      if (!card) {
        logger.warn(`[classifier] card not found: ${paperId}`);
        result.failed++;
        result.errors.push({ id: paperId, error: "card not found" });
        continue;
      }

      addPaperToNode(graph, targetNode, paperId);

      const signal: ClassificationSignal = {
        paperId,
        assignedNode: targetNode,
        confidence: "high",
        perception: null,
        timestamp: new Date().toISOString(),
      };
      await appendSignal(dataDir, signal);
      result.classified++;

      if (result.classified % 20 === 0 || result.classified <= 3) {
        logger.info(`[classifier] [${i + 1}/${ids.length}] ✅ ${paperId} → "${targetNode}"`);
      }
    } catch (err) {
      result.failed++;
      result.errors.push({ id: paperId, error: (err as Error).message });
      logger.warn(`[classifier] [${i + 1}/${ids.length}] ❌ ${paperId} — ${(err as Error).message}`);
    }
  }
}

// ─── Phase 2: LLM 辅助归类 ───

async function classifyWithLLM(
  dataDir: string,
  graph: SemanticGraph,
  ids: string[],
  candidateNodes: GraphNode[],
  result: ClassifyResult,
  opts: ClassifyOpts,
): Promise<void> {
  const { logger, provider, model, agentDir, config } = opts;

  // 加入 root 作为兜底选项
  const root = getNode(graph, "root");
  const allCandidates = root
    ? [root, ...candidateNodes]
    : candidateNodes;

  let runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>> | null = null;
  try {
    runFn = await loadRunEmbeddedPiAgent();
  } catch (err) {
    logger.error(`[classifier] Cannot load LLM, falling back to root: ${(err as Error).message}`);
    await classifyToRoot(graph, dataDir, ids, result, logger);
    return;
  }

  const tmpDir = join(dataDir, ".tmp-sessions");
  await mkdir(tmpDir, { recursive: true });

  logger.info(`[classifier] Processing ${ids.length} cards with LLM (${allCandidates.length} candidate nodes)`);

  for (let i = 0; i < ids.length; i++) {
    const paperId = ids[i];

    if (hasPaper(graph, paperId)) {
      result.skipped++;
      continue;
    }

    try {
      const card = await loadCard(dataDir, paperId);
      if (!card) {
        logger.warn(`[classifier] card not found: ${paperId}`);
        result.failed++;
        result.errors.push({ id: paperId, error: "card not found" });
        continue;
      }

      // 调用 LLM 选择节点
      const classification = await callLLMForClassify(
        runFn!,
        card,
        allCandidates,
        tmpDir,
        { provider, model, agentDir, config },
      );

      // 归类到选定的节点
      for (const nodeId of classification.assignedNodes) {
        if (getNode(graph, nodeId)) {
          addPaperToNode(graph, nodeId, paperId);
        } else {
          // LLM 返回了不存在的节点 ID，fallback 到 root
          logger.warn(`[classifier] LLM returned unknown node "${nodeId}", fallback to root`);
          addPaperToNode(graph, "root", paperId);
        }
      }

      // 记录信号
      const signal: ClassificationSignal = {
        paperId,
        assignedNode: classification.assignedNodes[0] ?? "root",
        confidence: classification.confidence,
        perception: classification.perception,
        timestamp: new Date().toISOString(),
      };
      await appendSignal(dataDir, signal);
      result.classified++;

      if (result.classified % 10 === 0 || result.classified <= 3) {
        logger.info(
          `[classifier] [${i + 1}/${ids.length}] ✅ ${paperId} → [${classification.assignedNodes.join(", ")}] (${classification.confidence})`,
        );
      }
    } catch (err) {
      result.failed++;
      result.errors.push({ id: paperId, error: (err as Error).message });
      logger.warn(`[classifier] [${i + 1}/${ids.length}] ❌ ${paperId} — ${(err as Error).message}`);
    }
  }

  // 清理临时目录
  try {
    const { rm } = await import("node:fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // non-critical
  }
}

interface LLMClassifyResult {
  assignedNodes: string[];
  confidence: "high" | "medium" | "low";
  perception: string | null;
}

async function callLLMForClassify(
  runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>,
  card: SummaryCard,
  candidates: GraphNode[],
  tmpDir: string,
  opts: { provider?: string; model?: string; agentDir?: string; config?: Record<string, unknown> },
): Promise<LLMClassifyResult> {
  const runId = randomUUID();
  const sessionId = `classify-${card.id}-${runId.slice(0, 8)}`;
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
      prompt: buildClassifyPrompt(card, candidates),
      extraSystemPrompt: CLASSIFY_SYSTEM_PROMPT,
      timeoutMs: 30_000,
      runId,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts.config ? { config: opts.config } : {}),
    });

    const text = collectText(result.payloads);
    if (!text) throw new Error("LLM returned empty response");

    const cleaned = stripCodeFences(text);
    const jsonMatch = cleaned.match(/\{[\s\S]*?"assignedNodes"[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error(`No valid JSON: ${cleaned.slice(0, 150)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      assignedNodes?: string[];
      confidence?: string;
      perception?: string | null;
    };

    return {
      assignedNodes: parsed.assignedNodes ?? ["root"],
      confidence: (parsed.confidence as "high" | "medium" | "low") ?? "medium",
      perception: parsed.perception ?? null,
    };
  } finally {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
