import { Type } from "@sinclair/typebox";
import { loadFeedItems, getDataDir } from "../feeds/storage.js";
import { loadCard, type SummaryCard } from "../knowledge/graph.js";
import type { FeedItem } from "../feeds/parser.js";

// State dir will be resolved at tool execution time
let resolvedStateDir: string | null = null;

export function setStateDir(dir: string) {
  resolvedStateDir = dir;
}

export function createSearchFeedTool() {
  return (ctx: { config?: unknown }) => {
    return {
      name: "search_feed",
      label: "Search Feed",
      description: [
        "Search recent academic papers from subscribed feeds (arXiv cs.IR, cs.AI, cs.LG).",
        "Returns concise summary cards (tags + one-liner + quality signal) for papers that have been processed.",
        "Papers without summary cards are listed as title-only for reference.",
        "Use when the conversation touches recommendation systems, information retrieval,",
        "machine learning, or multi-objective optimization.",
        "Do NOT call for every message — only when recent papers could add genuine value.",
      ].join(" "),

      parameters: Type.Object({
        days: Type.Optional(
          Type.Number({
            description:
              "How many days of feed history to search. Default: 7",
            default: 7,
            minimum: 1,
            maximum: 30,
          }),
        ),
      }),

      async execute(
        _toolCallId: string,
        params: { days?: number },
        _signal?: AbortSignal,
      ) {
        const days = params.days ?? 7;

        // Resolve state dir — try multiple paths
        const stateDir = resolvedStateDir ?? resolveDefaultStateDir();
        const dataDir = getDataDir(stateDir);

        const allItems = await loadFeedItems(dataDir, days);

        if (allItems.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No feed data found for the last ${days} day(s). The feed service may not have fetched yet.`,
              },
            ],
            details: { count: 0, withCard: 0, withoutCard: 0, total: 0 },
          };
        }

        // Phase 1: 有摘要卡的全量返回精简卡，无卡的只返回标题列表
        const { formatted, withCard, withoutCard } = await formatItemsWithCards(dataDir, allItems);

        const header = [
          `Found ${allItems.length} paper(s) from the last ${days} day(s).`,
          `${withCard} with summary cards (detailed below),`,
          `${withoutCard} without cards (title-only listing).`,
        ].join(" ");

        return {
          content: [
            {
              type: "text" as const,
              text: `${header}\n\n${formatted}`,
            },
          ],
          details: { count: withCard, withCard, withoutCard, total: allItems.length },
        };
      },
    };
  };
}

/**
 * Phase 1 格式化策略：
 * - 有摘要卡 → 全量返回精简卡（tags + oneLiner + qualitySignal，~150 bytes/篇）
 * - 无摘要卡 → 只返回标题 + URL（不含 abstract，~80 bytes/篇）
 *
 * 这样 600 有卡 + 6000 无卡 ≈ 90KB + 480KB ≈ 570KB，远低于 6MB 限制。
 */
async function formatItemsWithCards(
  dataDir: string,
  items: FeedItem[],
): Promise<{ formatted: string; withCard: number; withoutCard: number }> {
  const cardLines: string[] = [];
  const titleLines: string[] = [];
  let withCard = 0;
  let withoutCard = 0;

  for (const item of items) {
    const card = await loadCard(dataDir, item.id);

    if (card) {
      withCard++;
      cardLines.push(formatCardItem(withCard, card));
    } else {
      withoutCard++;
      titleLines.push(`  - ${item.title} (${item.source}, ${item.date}) ${item.url}`);
    }
  }

  const sections: string[] = [];

  if (cardLines.length > 0) {
    sections.push(`## Papers with Summary Cards (${withCard})\n\n${cardLines.join("\n\n")}`);
  }

  if (titleLines.length > 0) {
    // 无卡论文只列标题，不含 abstract，节省大量 token
    sections.push(`## Papers without Cards — title only (${withoutCard})\n\n${titleLines.join("\n")}`);
  }

  return { formatted: sections.join("\n\n---\n\n"), withCard, withoutCard };
}

/** 摘要卡格式 — 精简，省 token */
function formatCardItem(idx: number, card: SummaryCard): string {
  return (
    `[${idx}] ${card.title}\n` +
    `    Tags: ${card.tags.join(", ")}\n` +
    `    Summary: ${card.oneLiner}\n` +
    `    Signal: ${card.qualitySignal}\n` +
    `    Source: ${card.source} | Date: ${card.date}\n` +
    `    URL: ${card.url}`
  );
}

function resolveDefaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return `${home}/.openclaw`;
}
