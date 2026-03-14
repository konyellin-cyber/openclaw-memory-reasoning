/**
 * 导航式检索工具 — Phase 2 核心（唯一对外工具）
 *
 * Agent 通过此工具探索论文知识图谱：
 *
 * 1. action="overview" → 返回顶层节点列表（Layer 0 路标索引）
 * 2. action="explore" + nodeId → 返回该节点的子节点 + 邻居 + 边描述
 * 3. action="read_papers" + nodeId → 返回该节点下的摘要卡（支持分页和时间过滤）
 *
 * 冷启动时（只有 root 节点），overview 自动 fallback 为近期论文列表。
 */

import { Type } from "@sinclair/typebox";
import {
  loadGraph,
  getNode,
  getChildren,
  getNeighbors,
  getTopLevelNodes,
  loadNodeCards,
  type SemanticGraph,
} from "../knowledge/graph.js";
import { getDataDir } from "../feeds/storage.js";

let resolvedStateDir: string | null = null;

export function setNavStateDir(dir: string) {
  resolvedStateDir = dir;
}

export function createNavigateKnowledgeTool() {
  return (_ctx: { config?: unknown }) => {
    return {
      name: "navigate_knowledge",
      label: "Navigate Knowledge",
      description: [
        "Navigate and search the semantic knowledge graph of academic papers.",
        "This is the primary tool for discovering and retrieving paper recommendations.",
        "",
        "Actions:",
        "  - 'overview': See top-level topic nodes and paper counts (start here).",
        "  - 'explore': Drill into a node to see sub-topics, neighbors, and edge descriptions.",
        "  - 'read_papers': Read summary cards of papers under a node (supports limit, offset, since).",
        "",
        "Workflow: overview → explore → read_papers.",
        "Use 'since' parameter in read_papers to find recent papers (e.g. last 7 days).",
        "Use 'limit' and 'offset' for pagination on large nodes.",
      ].join("\n"),

      parameters: Type.Object({
        action: Type.Union(
          [
            Type.Literal("overview"),
            Type.Literal("explore"),
            Type.Literal("read_papers"),
          ],
          {
            description:
              "Navigation action: 'overview' for top-level map, 'explore' to drill into a node, 'read_papers' to get paper details.",
          },
        ),
        nodeId: Type.Optional(
          Type.String({
            description:
              "Node ID to explore or read papers from. Required for 'explore' and 'read_papers' actions.",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description:
              "Max number of papers to return for 'read_papers'. Default: 20. Use to avoid token overflow on large nodes.",
            default: 20,
            minimum: 1,
            maximum: 200,
          }),
        ),
        offset: Type.Optional(
          Type.Number({
            description:
              "Pagination offset for 'read_papers'. Default: 0. Use with limit for paging through large nodes.",
            default: 0,
            minimum: 0,
          }),
        ),
        since: Type.Optional(
          Type.String({
            description:
              "ISO date string (e.g. '2026-02-25') for 'read_papers'. Only returns papers published on or after this date.",
          }),
        ),
      }),

      async execute(
        _toolCallId: string,
        params: {
          action: "overview" | "explore" | "read_papers";
          nodeId?: string;
          limit?: number;
          offset?: number;
          since?: string;
        },
        _signal?: AbortSignal,
      ) {
        const stateDir = resolvedStateDir ?? resolveDefaultStateDir();
        const dataDir = getDataDir(stateDir);
        const graph = await loadGraph(dataDir);

        switch (params.action) {
          case "overview":
            return handleOverview(graph);
          case "explore":
            return handleExplore(graph, params.nodeId);
          case "read_papers":
            return handleReadPapers(graph, dataDir, params.nodeId, {
              limit: params.limit,
              offset: params.offset,
              since: params.since,
            });
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      },
    };
  };
}

// ─── Action Handlers ───

function handleOverview(graph: SemanticGraph) {
  const topNodes = getTopLevelNodes(graph);
  const totalPapers = graph.nodes.reduce((s, n) => s + n.items.length, 0);

  // 如果只有 root 节点且没有子节点，提示还没重整
  const root = getNode(graph, "root");
  const children = getChildren(graph, "root");

  if (graph.nodes.length === 1 && root) {
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Knowledge graph has 1 node (root) with ${root.items.length} papers.`,
            `The graph has not been reorganized into topic nodes yet.`,
            `You can still use action='read_papers' with nodeId='root' to browse papers.`,
            `Papers are sorted by date (newest first) and support limit/since filtering.`,
          ].join("\n"),
        },
      ],
      details: { nodeCount: 1, totalPapers, status: "cold-start" },
    };
  }

  const lines: string[] = [
    `## Knowledge Graph Overview`,
    `Total: ${graph.nodes.length} nodes, ${totalPapers} papers`,
    ``,
  ];

  // root 节点信息
  if (root) {
    lines.push(`### Root: ${root.description}`);
    if (root.items.length > 0) {
      lines.push(`  Uncategorized papers: ${root.items.length}`);
    }
    lines.push(``);
  }

  // 子节点列表
  if (children.length > 0) {
    lines.push(`### Topic Nodes (${children.length})`);
    for (const child of children) {
      const neighborCount = child.edges.length;
      lines.push(
        `  - **[${child.id}]** ${child.description} (${child.items.length} papers${neighborCount > 0 ? `, ${neighborCount} edges` : ""})`,
      );
    }
  }

  // 其他顶层节点
  const otherTop = topNodes.filter((n) => n.id !== "root" && !children.some((c) => c.id === n.id));
  if (otherTop.length > 0) {
    lines.push(``);
    lines.push(`### Other Nodes`);
    for (const n of otherTop) {
      lines.push(`  - **[${n.id}]** ${n.description} (${n.items.length} papers)`);
    }
  }

  lines.push(``);
  lines.push(`💡 Use action="explore" with a nodeId to drill deeper.`);

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { nodeCount: graph.nodes.length, totalPapers, childNodes: children.length },
  };
}

function handleExplore(graph: SemanticGraph, nodeId?: string) {
  if (!nodeId) {
    return errorResult("nodeId is required for 'explore' action");
  }

  const node = getNode(graph, nodeId);
  if (!node) {
    return errorResult(`Node "${nodeId}" not found. Use action="overview" to see available nodes.`);
  }

  const children = getChildren(graph, nodeId);
  const neighbors = getNeighbors(graph, nodeId);

  const lines: string[] = [
    `## Node: ${node.id}`,
    `Description: ${node.description}`,
    `Papers: ${node.items.length}`,
    ``,
  ];

  // 子节点
  if (children.length > 0) {
    lines.push(`### Sub-topics (${children.length})`);
    for (const child of children) {
      lines.push(`  - **[${child.id}]** ${child.description} (${child.items.length} papers)`);
    }
    lines.push(``);
  }

  // 邻居（边关系）
  if (neighbors.length > 0) {
    lines.push(`### Connected Nodes (via edges)`);
    for (const { node: neighbor, relation } of neighbors) {
      lines.push(
        `  - **[${neighbor.id}]** ← "${relation}" → ${neighbor.description} (${neighbor.items.length} papers)`,
      );
    }
    lines.push(``);
  }

  // 父节点
  if (node.parent) {
    const parent = getNode(graph, node.parent);
    if (parent) {
      lines.push(`### Parent`);
      lines.push(`  - **[${parent.id}]** ${parent.description}`);
      lines.push(``);
    }
  }

  if (node.items.length > 0) {
    lines.push(`💡 Use action="read_papers" with nodeId="${nodeId}" to see paper details.`);
  }
  if (children.length > 0) {
    lines.push(`💡 Use action="explore" with a sub-topic nodeId to drill deeper.`);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      nodeId: node.id,
      paperCount: node.items.length,
      childCount: children.length,
      edgeCount: neighbors.length,
    },
  };
}

async function handleReadPapers(
  graph: SemanticGraph,
  dataDir: string,
  nodeId?: string,
  opts?: { limit?: number; offset?: number; since?: string },
) {
  if (!nodeId) {
    return errorResult("nodeId is required for 'read_papers' action");
  }

  const node = getNode(graph, nodeId);
  if (!node) {
    return errorResult(`Node "${nodeId}" not found.`);
  }

  if (node.items.length === 0) {
    return {
      content: [{ type: "text" as const, text: `Node "${nodeId}" has no papers.` }],
      details: { nodeId, count: 0 },
    };
  }

  // 加载全部 cards
  let cards = await loadNodeCards(dataDir, graph, nodeId);

  // since 过滤（按 card.date）
  const sinceDate = opts?.since;
  if (sinceDate) {
    cards = cards.filter((c) => c.date >= sinceDate);
  }

  // 排序：最新优先
  cards.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

  const totalFiltered = cards.length;
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 20;
  const paged = cards.slice(offset, offset + limit);
  const hasMore = offset + limit < totalFiltered;

  const lines: string[] = [
    `## Papers in [${nodeId}] — ${node.description}`,
    `Total in node: ${node.items.length} | Filtered: ${totalFiltered}${sinceDate ? ` (since ${sinceDate})` : ""} | Showing: ${offset + 1}–${offset + paged.length}`,
    ``,
  ];

  for (let i = 0; i < paged.length; i++) {
    const c = paged[i];
    lines.push(
      `[${offset + i + 1}] ${c.title}\n` +
        `    Tags: ${c.tags.join(", ")}\n` +
        `    Summary: ${c.oneLiner}\n` +
        `    Signal: ${c.qualitySignal}\n` +
        `    Source: ${c.source} | Date: ${c.date}\n` +
        `    URL: ${c.url}`,
    );
    if (i < paged.length - 1) lines.push(``);
  }

  // 没有摘要卡的论文只在不分页时提示数量
  if (!sinceDate && offset === 0) {
    const cardsIds = new Set(cards.map((c) => c.id));
    const noCardCount = node.items.filter((p) => !cardsIds.has(p)).length;
    if (noCardCount > 0) {
      lines.push(``);
      lines.push(`### ${noCardCount} paper(s) without summary cards (not shown)`);
    }
  }

  if (hasMore) {
    lines.push(``);
    lines.push(`💡 More papers available. Use offset=${offset + limit} to see next page.`);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      nodeId,
      totalInNode: node.items.length,
      filtered: totalFiltered,
      showing: paged.length,
      offset,
      limit,
      hasMore,
    },
  };
}

// ─── Helpers ───

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    details: { error: message },
  };
}

function resolveDefaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  // Gateway 的 stateDir 是 ~/.openclaw/，getDataDir 会拼 personal-rec/
  return `${home}/.openclaw`;
}
