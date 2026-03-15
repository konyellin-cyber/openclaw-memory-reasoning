import { homedir } from "node:os";

/**
 * Semantic Navigator - Main CLI Entry Point
 *
 * Replaces the legacy navigate_knowledge plugin tool.
 * Supports dual sources: papers (external) and memory (internal).
 *
 * Usage:
 *   npx tsx navigate.ts --source papers --action overview
 *   npx tsx navigate.ts --source papers --action explore --nodeId <id>
 *   npx tsx navigate.ts --source papers --action read --nodeId <id> --limit 20 --since 2026-03-01
 *   npx tsx navigate.ts --source papers --action search --mode query-only
 *   npx tsx navigate.ts --source papers --action search --mode dry-run
 *   npx tsx navigate.ts --source papers --action search --direction recommendation-system
 */

import { Command } from "commander";
import {
  loadGraph,
  getNode,
  getChildren,
  getNeighbors,
  getTopLevelNodes,
  loadNodeCards,
  loadCard,
  type ContentCard,
  type SemanticGraph,
} from "../../knowledge/graph.js";
import { join } from "node:path";
import { runProactiveSearch, type PipelineOpts, type PipelineResult } from "../../search/pipeline.js";

type SourceType = "papers" | "memory";
type ActionType = "overview" | "explore" | "read" | "search";
type SearchMode = "query-only" | "dry-run" | "full";

interface ReadOptions {
  limit?: number;
  offset?: number;
  since?: string;
}

// ─── CLI Configuration ───

const program = new Command();

program
  .name("semantic-navigator")
  .description("Semantic navigation for papers and memory")
  .version("1.0.0");

program
  .requiredOption("--source <papers|memory>", "Data source to navigate")
  .requiredOption("--action <overview|explore|read|search>", "Navigation action")
  .option("--nodeId <id>", "Node ID to explore or read (required for explore/read)")
  .option("--limit <number>", "Max items to return for read action", "20")
  .option("--offset <number>", "Pagination offset for read action", "0")
  .option("--since <date>", "ISO date string (YYYY-MM-DD) for time filtering")
  // search action options
  .option("--mode <query-only|dry-run|full>", "Search mode: query-only (just generate queries), dry-run (search but don't ingest), full (complete pipeline)", "full")
  .option("--direction <nodeId>", "Search only this direction (internal memory node)")
  .option("--query <text>", "Manual query text (skip LLM generation), comma-separated for multiple")
  .option("--provider <name>", "LLM provider for search action", process.env.PERSONAL_REC_PROVIDER ?? "alibaba")
  .option("--model <name>", "LLM model for search action", process.env.PERSONAL_REC_MODEL ?? "glm-5")
  .action(async (options) => {
    try {
      const source = options.source as SourceType;
      const action = options.action as ActionType;

      if (!["papers", "memory"].includes(source)) {
        console.error(`Error: Invalid source "${source}". Must be "papers" or "memory".`);
        process.exit(1);
      }

      if (!["overview", "explore", "read", "search"].includes(action)) {
        console.error(`Error: Invalid action "${action}". Must be "overview", "explore", "read", or "search".`);
        process.exit(1);
      }

      if ((action === "explore" || action === "read") && !options.nodeId) {
        console.error(`Error: nodeId is required for "${action}" action.`);
        process.exit(1);
      }

      // search action only works with papers source
      if (action === "search" && source !== "papers") {
        console.error(`Error: search action only supports --source papers (not memory).`);
        process.exit(1);
      }

      const dataDir = getDataDir(source);
      const graph = await loadGraph(dataDir);

      let result: string;

      switch (action) {
        case "overview":
          result = handleOverview(graph, source);
          break;
        case "explore":
          result = handleExplore(graph, source, options.nodeId);
          break;
        case "read":
          result = await handleRead(
            graph,
            dataDir,
            source,
            options.nodeId,
            {
              limit: parseInt(options.limit),
              offset: parseInt(options.offset),
              since: options.since,
            },
          );
          break;
        case "search":
          result = await handleSearch({
            mode: options.mode as SearchMode,
            direction: options.direction,
            query: options.query,
            provider: options.provider,
            model: options.model,
          });
          break;
        default:
          throw new Error(`Unknown action: ${action}`);
      }

      console.log(result);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ─── Action Handlers ───

function handleOverview(graph: SemanticGraph, source: SourceType): string {
  const topNodes = getTopLevelNodes(graph);
  const totalItems = graph.nodes.reduce((s, n) => s + n.items.length, 0);

  const sourceLabel = source === "papers" ? "papers" : "memory items";
  const root = getNode(graph, "root");
  const children = getChildren(graph, "root");

  const lines: string[] = [
    `## Knowledge Graph Overview (${source})`,
    `Total: ${graph.nodes.length} nodes, ${totalItems} ${sourceLabel}`,
    ``,
  ];

  if (root) {
    lines.push(`### Root: ${root.description}`);
    if (root.items.length > 0) {
      lines.push(`  Uncategorized ${sourceLabel}: ${root.items.length}`);
    }
    lines.push(``);
  }

  if (children.length > 0) {
    lines.push(`### Topic Nodes (${children.length})`);
    for (const child of children) {
      const neighborCount = child.edges.length;
      lines.push(
        `  - **[${child.id}]** ${child.description} (${child.items.length} ${sourceLabel}${neighborCount > 0 ? `, ${neighborCount} edges` : ""})`,
      );
    }
    lines.push(``);
  }

  const otherTop = topNodes.filter((n) => n.id !== "root" && !children.some((c) => c.id === n.id));
  if (otherTop.length > 0) {
    lines.push(`### Other Nodes`);
    for (const n of otherTop) {
      lines.push(`  - **[${n.id}]** ${n.description} (${n.items.length} ${sourceLabel})`);
    }
    lines.push(``);
  }

  lines.push(`💡 Use --action explore --nodeId <id> to drill deeper.`);

  return lines.join("\n");
}

function handleExplore(graph: SemanticGraph, source: SourceType, nodeId: string): string {
  const node = getNode(graph, nodeId);
  if (!node) {
    const available = getTopLevelNodes(graph).map((n) => n.id).join(", ");
    return `Error: Node "${nodeId}" not found.\n\nAvailable nodes: ${available}\n\nUse --action overview to see all nodes.`;
  }

  const children = getChildren(graph, nodeId);
  const neighbors = getNeighbors(graph, nodeId);

  const sourceLabel = source === "papers" ? "papers" : "items";

  const lines: string[] = [
    `## Node: ${node.id}`,
    `Description: ${node.description}`,
    `${sourceLabel}: ${node.items.length}`,
    ``,
  ];

  if (children.length > 0) {
    lines.push(`### Sub-topics (${children.length})`);
    for (const child of children) {
      lines.push(`  - **[${child.id}]** ${child.description} (${child.items.length} ${sourceLabel})`);
    }
    lines.push(``);
  }

  if (neighbors.length > 0) {
    lines.push(`### Connected Nodes (via edges)`);
    for (const { node: neighbor, relation } of neighbors) {
      lines.push(
        `  - **[${neighbor.id}]** ← "${relation}" → ${neighbor.description} (${neighbor.items.length} ${sourceLabel})`,
      );
    }
    lines.push(``);
  }

  if (node.parent) {
    const parent = getNode(graph, node.parent);
    if (parent) {
      lines.push(`### Parent`);
      lines.push(`  - **[${parent.id}]** ${parent.description}`);
      lines.push(``);
    }
  }

  if (node.items.length > 0) {
    lines.push(`💡 Use --action read --nodeId="${nodeId}" to see ${sourceLabel}.`);
  }
  if (children.length > 0) {
    lines.push(`💡 Use --action explore --nodeId <child-id> to drill deeper.`);
  }

  return lines.join("\n");
}

async function handleRead(
  graph: SemanticGraph,
  dataDir: string,
  source: SourceType,
  nodeId: string,
  opts: ReadOptions,
): Promise<string> {
  const node = getNode(graph, nodeId);
  if (!node) {
    return `Error: Node "${nodeId}" not found.`;
  }

  if (node.items.length === 0) {
    return `Node "${nodeId}" has no items.`;
  }

  // 加载全部 cards
  // 注意: 对于memory源,graph.ts会添加knowledge子目录,但实际数据在memory-index/
  // 所以需要直接构造正确的路径
  let cards = await loadNodeCards(dataDir, graph, nodeId);

  // 对于memory源,需要手动加载卡片(因为路径问题)
  if (source === "memory") {
    const home = homedir();
    // loadCard 内部会自动添加 knowledge/cards/ 子目录
    const memoryDataDir = join(home, ".openclaw", "memory-index");
    cards = [];
    for (const itemId of node.items) {
      const card = await loadCard(memoryDataDir, itemId);
      if (card) cards.push(card);
    }
  }

  // 过滤 source 类型
  if (source === "papers") {
    cards = cards.filter((c) => c.type === "paper");
  } else {
    cards = cards.filter((c) => c.type === "memory");
  }

  // since 过滤
  const sinceDate = opts.since;
  if (sinceDate) {
    cards = cards.filter((c) => c.date >= sinceDate);
  }

  // 排序：最新优先
  cards.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));

  const totalFiltered = cards.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 20;
  const paged = cards.slice(offset, offset + limit);
  const hasMore = offset + limit < totalFiltered;

  const sourceLabel = source === "papers" ? "Papers" : "Items";

  const lines: string[] = [
    `## ${sourceLabel} in [${nodeId}] — ${node.description}`,
    `Total in node: ${node.items.length} | Filtered: ${totalFiltered}${sinceDate ? ` (since ${sinceDate})` : ""} | Showing: ${offset + 1}–${offset + paged.length}`,
    ``,
  ];

  for (let i = 0; i < paged.length; i++) {
    const c = paged[i];
    lines.push(
      `[${offset + i + 1}] ${c.title}\n` +
        `    Summary: ${c.oneLiner}\n` +
        `    Source: ${c.source} | Date: ${c.date}` +
        (c.people?.length ? `\n    People: ${c.people.join(", ")}` : "") +
        (c.url ? `\n    URL: ${c.url}` : ""),
    );
    if (i < paged.length - 1) lines.push(``);
  }

  if (hasMore) {
    lines.push(``);
    lines.push(`💡 More items available. Use --offset=${offset + limit} to see next page.`);
  }

  return lines.join("\n");
}

// ─── Search Action Handler ───

interface SearchOptions {
  mode?: SearchMode;
  direction?: string;
  query?: string;
  provider?: string;
  model?: string;
}

async function handleSearch(opts: SearchOptions): Promise<string> {
  const mode = opts.mode ?? "full";

  const pipelineOpts: PipelineOpts = {
    queryOnly: mode === "query-only",
    dryRun: mode === "dry-run",
    provider: opts.provider,
    model: opts.model,
  };

  // 如果指定了 direction，限制只搜该方向
  if (opts.direction) {
    // TODO: 实现方向过滤逻辑
    // 当前 pipeline 不支持按 direction 过滤，需要扩展
    // 暂时忽略 direction，记录警告
    console.warn(`Warning: --direction filtering not yet implemented. Searching all directions.`);
  }

  // 如果指定了手动 query，跳过 LLM 生成
  if (opts.query) {
    // TODO: 实现手动 query 逻辑
    // 当前 pipeline 依赖 current-focus.json 自动生成 query
    // 需要扩展 pipeline 支持手动 query 输入
    console.warn(`Warning: --query manual input not yet implemented. Using auto-generated queries.`);
  }

  const result = await runProactiveSearch(pipelineOpts);

  return formatSearchResult(result, mode);
}

function formatSearchResult(result: PipelineResult, mode: SearchMode): string {
  const lines: string[] = [
    `## Search Result`,
    `Mode: ${mode}`,
    `Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
    ``,
  ];

  // Query 生成结果
  lines.push(`### Queries Generated (${result.queryResult.queries.length})`);
  if (result.queryResult.queries.length > 0) {
    for (const q of result.queryResult.queries.slice(0, 10)) {
      lines.push(`  - "${q.text}" ← [${q.sourceNodeId}]`);
    }
    if (result.queryResult.queries.length > 10) {
      lines.push(`  - ... and ${result.queryResult.queries.length - 10} more`);
    }
  } else {
    lines.push(`  No queries generated.`);
  }
  lines.push(``);

  // 搜索统计
  if (mode !== "query-only") {
    lines.push(`### Search Statistics`);
    lines.push(`  Queries executed: ${result.searchStats.totalQueries}`);
    lines.push(`  Papers found: ${result.searchStats.totalPapersFound}`);
    lines.push(`  Queries with results: ${result.searchStats.queriesWithResults}`);
    lines.push(`  Empty queries: ${result.searchStats.queriesEmpty}`);
    lines.push(``);

    // 去重统计
    lines.push(`### Deduplication`);
    lines.push(`  New papers: ${result.dedupStats.newCount}`);
    lines.push(`  Batch duplicates: ${result.dedupStats.batchDuplicates}`);
    lines.push(`  Existing duplicates: ${result.dedupStats.existingDuplicates}`);
    lines.push(``);

    // 入库统计
    if (result.ingestStats) {
      lines.push(`### Ingestion`);
      lines.push(`  Cards generated: ${result.ingestStats.cardsGenerated}`);
      lines.push(`  Cards skipped: ${result.ingestStats.cardsSkipped}`);
      lines.push(`  Cards classified: ${result.ingestStats.classified}`);
      lines.push(``);
      lines.push(`✅ Search complete. New papers are now in the knowledge graph.`);
    } else {
      if (mode === "dry-run") {
        lines.push(`💡 Dry run — no papers were ingested. Use --mode full to ingest.`);
      } else {
        lines.push(`💡 No new papers to ingest (all were duplicates).`);
      }
    }
  } else {
    lines.push(`💡 Query-only mode — no search executed. Use --mode dry-run or --mode full to search.`);
  }

  return lines.join("\n");
}

// ─── Helpers ───

function getDataDir(source: SourceType): string {
  const home = homedir();
  if (source === "papers") {
    // getKnowledgeDir 会在路径后添加 "knowledge" 子目录
    // 所以这里传递 ~/.openclaw/personal-rec 即可
    return join(home, ".openclaw", "personal-rec");
  } else {
    // 对于memory,直接使用 ~/.openclaw/memory-index
    // graph.ts 也会添加 "knowledge" 子目录,所以需要调整
    // 但 memory-index 目录结构应该是:
    // ~/.openclaw/memory-index/
    // ├── graph.json
    // ├── cards/
    // └── signals.json
    // 传递路径时需要传递 ~/.openclaw,然后KNOWLEDGE_DIR会拼接为memory-index
    // 这需要修改graph.ts,暂时用临时方案
    return join(home, ".openclaw", "memory-index");
  }
}

// ─── Entry Point ───

program.parse(process.argv);
