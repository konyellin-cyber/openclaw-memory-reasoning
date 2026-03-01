/**
 * arXiv 历史数据 backfill — 通过 arXiv API 拉取指定日期范围的论文
 *
 * 用法: npx tsx src/feeds/backfill.ts [--days 30] [--categories cs.IR,cs.AI,cs.LG]
 *
 * arXiv API 限制: max_results 单次最多 30000，但推荐分页（每页 100）+ 3s 间隔
 * 参考: https://info.arxiv.org/help/api/user-manual.html
 */

import { fetchArxivApi, type FeedItem } from "./parser.js";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_STATE_DIR = join(
  process.env.HOME ?? "~",
  ".openclaw",
);
const DATA_DIR_NAME = "personal-rec";
const FEEDS_DIR = "feeds";

interface BackfillOpts {
  days: number;
  categories: string[];
  stateDir: string;
  pageSize: number;
  delayMs: number;
}

function parseArgs(): BackfillOpts {
  const args = process.argv.slice(2);
  let days = 30;
  let categories = ["cs.IR"];
  let stateDir = DEFAULT_STATE_DIR;
  const pageSize = 200;
  const delayMs = 3000; // arXiv 要求 3s 间隔

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--categories" && args[i + 1]) {
      categories = args[i + 1].split(",").map((c) => c.trim());
      i++;
    } else if (args[i] === "--state-dir" && args[i + 1]) {
      stateDir = args[i + 1];
      i++;
    }
  }

  return { days, categories, stateDir, pageSize, delayMs };
}

function formatArxivDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}0000`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 分页拉取 arXiv API，突破单次 100 条限制
 */
async function fetchArxivPaginated(
  category: string,
  fromDate: Date,
  toDate: Date,
  pageSize: number,
  delayMs: number,
): Promise<FeedItem[]> {
  const fromStr = formatArxivDate(fromDate);
  const toStr = formatArxivDate(toDate);
  const allItems: FeedItem[] = [];
  let start = 0;
  let hasMore = true;

  while (hasMore) {
    const apiUrl =
      `https://export.arxiv.org/api/query?` +
      `search_query=cat:${category}+AND+submittedDate:[${fromStr}+TO+${toStr}]` +
      `&start=${start}&max_results=${pageSize}&sortBy=submittedDate&sortOrder=descending`;

    console.log(`  [${category}] fetching start=${start}...`);

    const response = await fetch(apiUrl);
    if (!response.ok) {
      console.error(`  ❌ HTTP ${response.status}: ${response.statusText}`);
      break;
    }

    const xml = await response.text();
    const { XMLParser } = await import("fast-xml-parser");
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const parsed = parser.parse(xml);

    const feed = parsed?.feed;
    if (!feed?.entry) {
      hasMore = false;
      break;
    }

    const entries: any[] = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
    const source = `arxiv:${category}`;

    for (const entry of entries) {
      const title = cleanText(entry.title ?? "");
      const abstract = cleanText(entry.summary ?? "");
      const link = extractAtomLink(entry.link);
      const id = extractArxivId(link) ?? link;
      const rawAuthors = entry.author;
      const authors = parseAtomAuthors(rawAuthors);
      const published = entry.published ?? "";
      const date = published ? published.slice(0, 10) : new Date().toISOString().slice(0, 10);

      allItems.push({ id, title, authors, abstract, date, source, url: link });
    }

    console.log(`  [${category}] got ${entries.length} items (total: ${allItems.length})`);

    if (entries.length < pageSize) {
      hasMore = false;
    } else {
      start += pageSize;
      // arXiv rate limiting
      await sleep(delayMs);
    }
  }

  return allItems;
}

/**
 * 按日期分组存储，复用现有存储格式
 */
async function saveByDate(dataDir: string, items: FeedItem[]): Promise<void> {
  const feedsDir = join(dataDir, FEEDS_DIR);
  await mkdir(feedsDir, { recursive: true });

  // Group by date
  const byDate = new Map<string, FeedItem[]>();
  for (const item of items) {
    const date = item.date;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(item);
  }

  let totalNew = 0;

  for (const [date, dateItems] of byDate) {
    const filePath = join(feedsDir, `${date}.json`);

    // Load existing items to deduplicate
    let existing: FeedItem[] = [];
    if (existsSync(filePath)) {
      try {
        const raw = await readFile(filePath, "utf-8");
        existing = JSON.parse(raw);
      } catch {
        // corrupted, overwrite
      }
    }

    const existingIds = new Set(existing.map((i) => i.id));
    const newItems = dateItems.filter((i) => !existingIds.has(i.id));
    const merged = [...existing, ...newItems];
    totalNew += newItems.length;

    await writeFile(filePath, JSON.stringify(merged, null, 2), "utf-8");
  }

  console.log(`  💾 saved ${totalNew} new items across ${byDate.size} dates (${items.length} total, ${items.length - totalNew} duplicates skipped)`);

  // Update index
  await updateIndex(dataDir);
}

async function updateIndex(dataDir: string): Promise<void> {
  const feedsDir = join(dataDir, FEEDS_DIR);
  if (!existsSync(feedsDir)) return;

  const { readdir } = await import("node:fs/promises");
  const files = await readdir(feedsDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json") && f !== "index.json").sort();

  let totalItems = 0;
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(feedsDir, file), "utf-8");
      const items: unknown[] = JSON.parse(raw);
      totalItems += items.length;
    } catch {
      // skip
    }
  }

  const index = {
    lastUpdated: new Date().toISOString(),
    totalItems,
    dateRange:
      jsonFiles.length > 0
        ? {
            from: jsonFiles[0].replace(".json", ""),
            to: jsonFiles[jsonFiles.length - 1].replace(".json", ""),
          }
        : null,
  };

  await writeFile(
    join(dataDir, "index.json"),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
}

// --- Helper functions (copied from parser.ts to avoid import issues with standalone execution) ---

function cleanText(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function extractAtomLink(link: unknown): string {
  if (typeof link === "string") return link;
  if (Array.isArray(link)) {
    const alt = link.find((l: any) => l["@_rel"] === "alternate" || l["@_type"] === "text/html");
    return alt?.["@_href"] ?? link[0]?.["@_href"] ?? "";
  }
  if (link && typeof link === "object") return (link as any)["@_href"] ?? "";
  return "";
}

function parseAtomAuthors(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((a: any) => cleanText(a.name ?? "")).filter(Boolean);
  if (typeof raw === "object" && raw !== null) {
    const name = (raw as any).name;
    return name ? [cleanText(name)] : [];
  }
  return [];
}

function extractArxivId(link: string): string | null {
  const match = link.match(/abs\/(\d+\.\d+)/);
  return match ? match[1] : null;
}

// --- Main ---

async function main() {
  const opts = parseArgs();
  const dataDir = join(opts.stateDir, DATA_DIR_NAME);

  console.log("=== arXiv Backfill ===");
  console.log(`  Days: ${opts.days}`);
  console.log(`  Categories: ${opts.categories.join(", ")}`);
  console.log(`  State dir: ${opts.stateDir}`);
  console.log(`  Data dir: ${dataDir}`);
  console.log("");

  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - opts.days);

  let grandTotal = 0;

  for (const category of opts.categories) {
    console.log(`📚 Fetching ${category} (${opts.days} days)...`);
    const feedUrl = `https://rss.arxiv.org/rss/${category}`;

    const items = await fetchArxivPaginated(
      category,
      from,
      now,
      opts.pageSize,
      opts.delayMs,
    );

    if (items.length > 0) {
      await saveByDate(dataDir, items);
      grandTotal += items.length;
    } else {
      console.log(`  ⚠️ no items found`);
    }

    // Delay between categories
    if (opts.categories.indexOf(category) < opts.categories.length - 1) {
      console.log(`  ⏳ waiting ${opts.delayMs / 1000}s before next category...`);
      await sleep(opts.delayMs);
    }
  }

  console.log(`\n✅ Backfill complete: ${grandTotal} total items`);

  // Print final stats
  if (existsSync(join(dataDir, "index.json"))) {
    const idx = JSON.parse(await readFile(join(dataDir, "index.json"), "utf-8"));
    console.log(`📊 Index: ${idx.totalItems} items, date range: ${idx.dateRange?.from} → ${idx.dateRange?.to}`);
  }
}

main().catch((err) => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});
