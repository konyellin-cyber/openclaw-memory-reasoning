/**
 * trigger.ts 单元测试 — 验证三个触发条件的边界情况
 */

import { describe, it, expect } from "vitest";
import {
  checkPaperThreshold,
  checkLowConfidence,
  checkTimerFallback,
} from "../trigger.js";
import type { SemanticGraph, ClassificationSignal } from "../graph.js";

// ─── Helpers ───

function makeGraph(nodes: Array<{
  id: string;
  papers: string[];
  parent?: string | null;
  lastReorgAt?: string;
  children?: boolean; // if true, add a child node
}>): SemanticGraph {
  const graphNodes = nodes.map((n) => ({
    id: n.id,
    description: `Node ${n.id}`,
    parent: n.parent ?? (n.id === "root" ? null : "root"),
    papers: n.papers,
    edges: [],
    ...(n.lastReorgAt ? { lastReorgAt: n.lastReorgAt } : {}),
  }));

  // Add child nodes if specified
  for (const n of nodes) {
    if (n.children) {
      graphNodes.push({
        id: `${n.id}-child`,
        description: `Child of ${n.id}`,
        parent: n.id,
        papers: ["child-paper-1"],
        edges: [],
      });
    }
  }

  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    nodes: graphNodes,
  };
}

function makeSignals(entries: Array<{
  nodeId: string;
  confidence: "high" | "medium" | "low";
  daysAgo?: number;
}>): ClassificationSignal[] {
  return entries.map((e, i) => {
    const ts = new Date();
    ts.setDate(ts.getDate() - (e.daysAgo ?? 0));
    return {
      paperId: `paper-${i}`,
      assignedNode: e.nodeId,
      confidence: e.confidence,
      perception: e.confidence === "low" ? "不太确定" : null,
      timestamp: ts.toISOString(),
    };
  });
}

function makePapers(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `2602.${String(i).padStart(5, "0")}`);
}

// ─── Tests ───

describe("checkPaperThreshold", () => {
  it("should NOT trigger when node has exactly threshold papers", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(20) },
    ]);
    expect(checkPaperThreshold(graph, 20)).toBeNull();
  });

  it("should trigger when node has threshold+1 papers", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(21) },
    ]);
    const result = checkPaperThreshold(graph, 20);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("node-a");
    expect(result!.condition).toBe("paper_threshold");
  });

  it("should skip root node", () => {
    const graph = makeGraph([
      { id: "root", papers: makePapers(100) },
      { id: "node-a", papers: makePapers(5) },
    ]);
    expect(checkPaperThreshold(graph, 20)).toBeNull();
  });

  it("should skip non-leaf nodes (nodes with children)", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(50), children: true },
    ]);
    expect(checkPaperThreshold(graph, 20)).toBeNull();
  });

  it("should return first exceeding node", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(25) },
      { id: "node-b", papers: makePapers(30) },
    ]);
    const result = checkPaperThreshold(graph, 20);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("node-a");
  });
});

describe("checkLowConfidence", () => {
  it("should NOT trigger when low ratio is at threshold", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(10) },
    ]);
    // 10 signals, 3 low = 30% = exactly at threshold → NOT trigger (need > 30%)
    const signals = makeSignals([
      ...Array(7).fill({ nodeId: "node-a", confidence: "high" }),
      ...Array(3).fill({ nodeId: "node-a", confidence: "low" }),
    ]);
    expect(checkLowConfidence(graph, signals, 0.3, 7)).toBeNull();
  });

  it("should trigger when low ratio exceeds threshold", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(10) },
    ]);
    // 10 signals, 4 low = 40% > 30%
    const signals = makeSignals([
      ...Array(6).fill({ nodeId: "node-a", confidence: "high" }),
      ...Array(4).fill({ nodeId: "node-a", confidence: "low" }),
    ]);
    const result = checkLowConfidence(graph, signals, 0.3, 7);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("node-a");
    expect(result!.condition).toBe("low_confidence");
  });

  it("should ignore signals older than window", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(10) },
    ]);
    // All low signals are old (8 days ago), only recent ones are high
    const signals = makeSignals([
      ...Array(5).fill({ nodeId: "node-a", confidence: "low", daysAgo: 8 }),
      ...Array(5).fill({ nodeId: "node-a", confidence: "high", daysAgo: 1 }),
    ]);
    expect(checkLowConfidence(graph, signals, 0.3, 7)).toBeNull();
  });

  it("should NOT trigger with fewer than 3 signals", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(10) },
    ]);
    // Only 2 signals, both low = 100% but too few samples
    const signals = makeSignals([
      { nodeId: "node-a", confidence: "low" },
      { nodeId: "node-a", confidence: "low" },
    ]);
    expect(checkLowConfidence(graph, signals, 0.3, 7)).toBeNull();
  });

  it("should skip root node signals", () => {
    const graph = makeGraph([
      { id: "root", papers: makePapers(10) },
    ]);
    const signals = makeSignals([
      ...Array(10).fill({ nodeId: "root", confidence: "low" }),
    ]);
    expect(checkLowConfidence(graph, signals, 0.3, 7)).toBeNull();
  });
});

describe("checkTimerFallback", () => {
  it("should NOT trigger when lastReorgAt is within interval", () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 29);
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(15), lastReorgAt: recentDate.toISOString() },
    ]);
    expect(checkTimerFallback(graph, 30, 10)).toBeNull();
  });

  it("should trigger when lastReorgAt exceeds interval", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 31);
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(15), lastReorgAt: oldDate.toISOString() },
    ]);
    const result = checkTimerFallback(graph, 30, 10);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("node-a");
    expect(result!.condition).toBe("timer_fallback");
  });

  it("should trigger when no lastReorgAt and enough papers", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(15) },
    ]);
    const result = checkTimerFallback(graph, 30, 10);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("node-a");
    expect(result!.condition).toBe("timer_fallback");
  });

  it("should NOT trigger when no lastReorgAt but too few papers", () => {
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(5) },
    ]);
    expect(checkTimerFallback(graph, 30, 10)).toBeNull();
  });

  it("should skip root node", () => {
    const graph = makeGraph([
      { id: "root", papers: makePapers(100) },
    ]);
    expect(checkTimerFallback(graph, 30, 10)).toBeNull();
  });

  it("should skip non-leaf nodes", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(50), lastReorgAt: oldDate.toISOString(), children: true },
    ]);
    expect(checkTimerFallback(graph, 30, 10)).toBeNull();
  });
});

describe("no trigger", () => {
  it("should return null when no conditions are met", () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);
    const graph = makeGraph([
      { id: "root", papers: [] },
      { id: "node-a", papers: makePapers(10), lastReorgAt: recentDate.toISOString() },
      { id: "node-b", papers: makePapers(8), lastReorgAt: recentDate.toISOString() },
    ]);

    // All conditions should be null
    expect(checkPaperThreshold(graph, 20)).toBeNull();
    expect(checkLowConfidence(graph, [], 0.3, 7)).toBeNull();
    expect(checkTimerFallback(graph, 30, 10)).toBeNull();
  });
});
