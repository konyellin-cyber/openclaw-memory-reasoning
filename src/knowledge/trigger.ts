/**
 * 自动触发机制 — 入库后检查是否需要重整语义网
 *
 * 三个触发条件（满足任一即触发）：
 *   a) 某节点论文数 > 阈值（默认 20）
 *   b) 某节点近期低置信度归类比例 > 30%
 *   c) 距上次重整超过 N 天（定时兜底，默认 30 天）
 *
 * 触发后调用 reorganizer.ts 执行重整，diff 自动 apply。
 */

import {
  loadGraph,
  loadSignals,
  getChildren,
  type SemanticGraph,
  type GraphNode,
  type ClassificationSignal,
} from "./graph.js";
import { reorganize, type ReorgResult, type ReorgOpts } from "./reorganizer.js";

// ─── Types ───

export interface TriggerOpts {
  /** 节点论文数阈值（默认 20） */
  paperThreshold?: number;
  /** 低置信度比例阈值（默认 0.3） */
  lowConfidenceRatio?: number;
  /** 信号统计窗口天数（默认 7） */
  signalWindowDays?: number;
  /** 定时兜底间隔天数（默认 30） */
  reorgIntervalDays?: number;
  /** 定时兜底最低论文数（默认 10，避免对小节点触发） */
  timerMinPapers?: number;
  /** LLM provider */
  provider?: string;
  /** LLM model */
  model?: string;
  /** OpenClaw agent dir */
  agentDir?: string;
  /** OpenClaw config */
  config?: Record<string, unknown>;
  /** Logger */
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface TriggerCheckResult {
  triggered: boolean;
  nodeId: string;
  reason: string;
  condition: "paper_threshold" | "low_confidence" | "timer_fallback";
}

// ─── Condition Checks ───

/**
 * 条件 a: 节点论文数超过阈值
 */
export function checkPaperThreshold(
  graph: SemanticGraph,
  threshold: number,
): TriggerCheckResult | null {
  // 检查所有非 root 叶子节点（没有子节点的节点）
  for (const node of graph.nodes) {
    if (node.id === "root") continue;
    const children = getChildren(graph, node.id);
    if (children.length > 0) continue; // 非叶子节点跳过
    if (node.items.length > threshold) {
      return {
        triggered: true,
        nodeId: node.id,
        reason: `Node "${node.id}" has ${node.items.length} items (threshold: ${threshold})`,
        condition: "paper_threshold",
      };
    }
  }
  return null;
}

/**
 * 条件 b: 节点近期低置信度归类比例超阈值
 */
export function checkLowConfidence(
  graph: SemanticGraph,
  signals: ClassificationSignal[],
  ratio: number,
  windowDays: number,
): TriggerCheckResult | null {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString();

  // 按节点分组统计近期信号
  const nodeSignals = new Map<string, { total: number; low: number }>();

  for (const sig of signals) {
    if (sig.timestamp < cutoffStr) continue;
    const stats = nodeSignals.get(sig.assignedNode) ?? { total: 0, low: 0 };
    stats.total++;
    if (sig.confidence === "low") stats.low++;
    nodeSignals.set(sig.assignedNode, stats);
  }

  for (const [nodeId, stats] of nodeSignals) {
    if (nodeId === "root") continue;
    if (stats.total < 3) continue; // 样本太少不触发
    const currentRatio = stats.low / stats.total;
    if (currentRatio > ratio) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const children = getChildren(graph, nodeId);
      if (children.length > 0) continue; // 非叶子节点跳过
      return {
        triggered: true,
        nodeId,
        reason: `Node "${nodeId}" has ${(currentRatio * 100).toFixed(0)}% low-confidence signals (${stats.low}/${stats.total}, threshold: ${(ratio * 100).toFixed(0)}%)`,
        condition: "low_confidence",
      };
    }
  }
  return null;
}

/**
 * 条件 c: 定时兜底 — 距上次重整超过 N 天
 */
export function checkTimerFallback(
  graph: SemanticGraph,
  intervalDays: number,
  minPapers: number,
): TriggerCheckResult | null {
  const now = Date.now();
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;

  for (const node of graph.nodes) {
    if (node.id === "root") continue;
    const children = getChildren(graph, node.id);
    if (children.length > 0) continue; // 非叶子节点跳过
    if (node.items.length < minPapers) continue; // 论文太少不触发

    if (!node.lastReorgAt) {
      // 从未重整过，触发
      return {
        triggered: true,
        nodeId: node.id,
        reason: `Node "${node.id}" has never been reorganized and has ${node.items.length} papers (min: ${minPapers})`,
        condition: "timer_fallback",
      };
    }

    const lastReorg = new Date(node.lastReorgAt).getTime();
    if (now - lastReorg > intervalMs) {
      const daysSince = Math.floor((now - lastReorg) / (24 * 60 * 60 * 1000));
      return {
        triggered: true,
        nodeId: node.id,
        reason: `Node "${node.id}" last reorganized ${daysSince} days ago (threshold: ${intervalDays} days)`,
        condition: "timer_fallback",
      };
    }
  }
  return null;
}

// ─── Main Entry ───

/**
 * 检查所有触发条件，返回第一个命中的结果（优先级 a > b > c）
 */
export async function checkTriggerConditions(
  dataDir: string,
  opts?: {
    paperThreshold?: number;
    lowConfidenceRatio?: number;
    signalWindowDays?: number;
    reorgIntervalDays?: number;
    timerMinPapers?: number;
  },
): Promise<TriggerCheckResult | null> {
  const {
    paperThreshold = 20,
    lowConfidenceRatio = 0.3,
    signalWindowDays = 7,
    reorgIntervalDays = 30,
    timerMinPapers = 10,
  } = opts ?? {};

  const graph = await loadGraph(dataDir);
  const signalsStore = await loadSignals(dataDir);

  // 条件 a: 论文数阈值
  const a = checkPaperThreshold(graph, paperThreshold);
  if (a) return a;

  // 条件 b: 低置信度比例
  const b = checkLowConfidence(graph, signalsStore.signals, lowConfidenceRatio, signalWindowDays);
  if (b) return b;

  // 条件 c: 定时兜底
  const c = checkTimerFallback(graph, reorgIntervalDays, timerMinPapers);
  if (c) return c;

  return null;
}

/**
 * 检查触发条件 → 满足时调用 reorganizer → 返回结果
 * 非阻塞：重整失败只 log 不抛异常
 */
export async function triggerReorgIfNeeded(
  dataDir: string,
  opts: TriggerOpts,
): Promise<ReorgResult | null> {
  const {
    paperThreshold, lowConfidenceRatio, signalWindowDays,
    reorgIntervalDays, timerMinPapers,
    provider, model, agentDir, config, logger,
  } = opts;

  logger.info("[trigger] Checking reorganization trigger conditions...");

  const check = await checkTriggerConditions(dataDir, {
    paperThreshold, lowConfidenceRatio, signalWindowDays,
    reorgIntervalDays, timerMinPapers,
  });

  if (!check) {
    logger.info("[trigger] No reorganization needed");
    return null;
  }

  logger.info(`[trigger] Triggered! Condition: ${check.condition}, node: ${check.nodeId}`);
  logger.info(`[trigger] Reason: ${check.reason}`);

  try {
    const result = await reorganize(dataDir, {
      logger,
      nodeId: check.nodeId,
      dryRun: false,
      provider,
      model,
      agentDir,
      config,
    });

    if (result.success && result.applied) {
      logger.info(
        `[trigger] Reorganization complete: ${result.meta?.newNodeCount ?? 0} new nodes, ` +
        `${result.meta?.movedPapers ?? 0} papers moved, ${result.meta?.durationMs ?? 0}ms`,
      );
    } else if (result.success && !result.applied) {
      logger.info(`[trigger] Reorganization: LLM decided no split needed`);
    } else {
      logger.warn(`[trigger] Reorganization failed: ${result.error}`);
    }

    return result;
  } catch (err) {
    logger.error(`[trigger] Reorganization error: ${(err as Error).message}`);
    return null;
  }
}
