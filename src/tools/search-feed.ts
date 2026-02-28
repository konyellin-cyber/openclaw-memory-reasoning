import { Type } from "@sinclair/typebox";
import { loadFeedItems, getDataDir } from "../feeds/storage.js";
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
        "Search recent academic papers and articles from subscribed RSS feeds (e.g. arXiv cs.IR).",
        "Use this tool when the current conversation touches on topics that might relate to recent research —",
        "such as recommendation systems, information retrieval, machine learning, multi-objective optimization, etc.",
        "The tool returns paper titles, authors, and abstracts. You should then select the most relevant ones",
        "and naturally weave them into your response with specific reasons why they relate to the current discussion.",
        "Do NOT call this tool for every message — only when you genuinely think recent papers could add value.",
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

        const items = await loadFeedItems(dataDir, days);

        if (items.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No feed data found for the last ${days} day(s). The feed service may not have fetched yet.`,
              },
            ],
            details: { count: 0 },
          };
        }

        const formatted = formatItems(items);

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${items.length} paper(s) from the last ${days} day(s):\n\n${formatted}`,
            },
          ],
          details: { count: items.length },
        };
      },
    };
  };
}

function formatItems(items: FeedItem[]): string {
  return items
    .map(
      (item, i) =>
        `[${i + 1}] ${item.title}\n` +
        `    Authors: ${item.authors.join(", ")}\n` +
        `    Source: ${item.source} | Date: ${item.date}\n` +
        `    URL: ${item.url}\n` +
        `    Abstract: ${item.abstract}`,
    )
    .join("\n\n");
}

function resolveDefaultStateDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return `${home}/.openclaw/state`;
}
