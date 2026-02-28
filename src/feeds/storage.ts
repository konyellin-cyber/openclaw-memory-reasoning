import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { FeedItem } from "./parser.js";

const FEEDS_DIR = "feeds";

export function getDataDir(stateDir: string): string {
  return join(stateDir, "personal-rec");
}

function getFeedsDir(dataDir: string): string {
  return join(dataDir, FEEDS_DIR);
}

function getFilePath(dataDir: string, date: string): string {
  return join(getFeedsDir(dataDir), `${date}.json`);
}

export async function saveFeedItems(
  dataDir: string,
  items: FeedItem[],
  _feedUrl: string,
): Promise<void> {
  if (items.length === 0) return;

  const feedsDir = getFeedsDir(dataDir);
  await mkdir(feedsDir, { recursive: true });

  const date = items[0].date;
  const filePath = getFilePath(dataDir, date);

  // Load existing items for this date (if any) to avoid duplicates
  let existing: FeedItem[] = [];
  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // corrupted file, overwrite
    }
  }

  // Merge: deduplicate by id
  const existingIds = new Set(existing.map((i) => i.id));
  const newItems = items.filter((i) => !existingIds.has(i.id));
  const merged = [...existing, ...newItems];

  await writeFile(filePath, JSON.stringify(merged, null, 2), "utf-8");

  // Update index
  await updateIndex(dataDir);
}

export async function loadFeedItems(
  dataDir: string,
  days: number,
): Promise<FeedItem[]> {
  const feedsDir = getFeedsDir(dataDir);
  if (!existsSync(feedsDir)) return [];

  const now = new Date();
  const allItems: FeedItem[] = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const filePath = getFilePath(dataDir, dateStr);

    if (existsSync(filePath)) {
      try {
        const raw = await readFile(filePath, "utf-8");
        const items: FeedItem[] = JSON.parse(raw);
        allItems.push(...items);
      } catch {
        // skip corrupted files
      }
    }
  }

  return allItems;
}

interface FeedIndex {
  lastUpdated: string;
  totalItems: number;
  dateRange: { from: string; to: string } | null;
}

async function updateIndex(dataDir: string): Promise<void> {
  const feedsDir = getFeedsDir(dataDir);
  if (!existsSync(feedsDir)) return;

  const { readdir } = await import("node:fs/promises");
  const files = await readdir(feedsDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

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

  const index: FeedIndex = {
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
