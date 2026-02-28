import { XMLParser } from "fast-xml-parser";

export interface FeedItem {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  date: string;
  source: string;
  url: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

/**
 * Check if a feed URL is an arXiv RSS feed.
 * If so, we use the arXiv API instead (supports date range queries).
 */
export function isArxivFeed(feedUrl: string): boolean {
  return feedUrl.includes("arxiv.org");
}

/**
 * Extract arXiv category from RSS URL, e.g. "cs.IR" from
 * "https://rss.arxiv.org/rss/cs.IR"
 */
export function extractArxivCategory(feedUrl: string): string | null {
  const match = feedUrl.match(/rss\/([a-zA-Z-]+\.[A-Z]+)/);
  return match ? match[1] : null;
}

/**
 * Fetch recent papers via arXiv Atom API with date range support.
 * This works on weekends and returns historical data.
 */
export async function fetchArxivApi(
  feedUrl: string,
  days: number = 3,
): Promise<FeedItem[]> {
  const category = extractArxivCategory(feedUrl);
  if (!category) {
    // Fallback to RSS if we can't extract category
    return fetchAndParseRss(feedUrl);
  }

  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - days);

  // arXiv API date format: YYYYMMDDHHMM
  const fromStr = formatArxivDate(from);
  const toStr = formatArxivDate(now);

  const apiUrl =
    `https://export.arxiv.org/api/query?` +
    `search_query=cat:${category}+AND+submittedDate:[${fromStr}+TO+${toStr}]` +
    `&start=0&max_results=100&sortBy=submittedDate&sortOrder=descending`;

  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`arXiv API HTTP ${response.status}: ${response.statusText}`);
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);

  const feed = parsed?.feed;
  if (!feed?.entry) return [];

  const entries: unknown[] = Array.isArray(feed.entry)
    ? feed.entry
    : [feed.entry];

  const source = `arxiv:${category}`;

  return entries.map((entry: any) => {
    const title = cleanText(entry.title ?? "");
    const abstract = cleanText(entry.summary ?? "");

    // Link can be string or array of objects
    const link = extractAtomLink(entry.link);
    const id = extractArxivId(link) ?? link;

    // Authors: single object or array
    const rawAuthors = entry.author;
    const authors = parseAtomAuthors(rawAuthors);

    // Published date
    const published = entry.published ?? "";
    const date = published ? published.slice(0, 10) : new Date().toISOString().slice(0, 10);

    return { id, title, authors, abstract, date, source, url: link };
  });
}

function formatArxivDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}0000`;
}

function extractAtomLink(link: unknown): string {
  if (typeof link === "string") return link;
  if (Array.isArray(link)) {
    // Prefer the "alternate" link
    const alt = link.find(
      (l: any) => l["@_rel"] === "alternate" || l["@_type"] === "text/html",
    );
    return alt?.["@_href"] ?? link[0]?.["@_href"] ?? "";
  }
  if (link && typeof link === "object") {
    return (link as any)["@_href"] ?? "";
  }
  return "";
}

function parseAtomAuthors(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((a: any) => cleanText(a.name ?? "")).filter(Boolean);
  }
  if (typeof raw === "object" && raw !== null) {
    const name = (raw as any).name;
    return name ? [cleanText(name)] : [];
  }
  return [];
}

/**
 * Original RSS-based fetch (fallback for non-arXiv feeds).
 */
export async function fetchAndParseRss(feedUrl: string): Promise<FeedItem[]> {
  const response = await fetch(feedUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);

  const channel = parsed?.rdf?.item ?? parsed?.rss?.channel?.item ?? [];
  const items: unknown[] = Array.isArray(channel) ? channel : [channel];

  const today = new Date().toISOString().slice(0, 10);
  const source = deriveSource(feedUrl);

  return items.map((item: any) => {
    const title = cleanText(item.title ?? "");
    const abstract = cleanText(item.description ?? "");
    const link = item.link ?? "";
    const id = extractArxivId(link) ?? link;

    const rawAuthors = item["dc:creator"] ?? item.author ?? "";
    const authors = parseAuthors(rawAuthors);

    return { id, title, authors, abstract, date: today, source, url: link };
  });
}

/**
 * Unified entry: auto-detect arXiv → use API; otherwise → use RSS.
 */
export async function fetchAndParseFeed(
  feedUrl: string,
  days: number = 3,
): Promise<FeedItem[]> {
  if (isArxivFeed(feedUrl)) {
    return fetchArxivApi(feedUrl, days);
  }
  return fetchAndParseRss(feedUrl);
}

function deriveSource(url: string): string {
  if (url.includes("arxiv.org")) {
    const match = url.match(/rss\/(.+)/);
    return match ? `arxiv:${match[1]}` : "arxiv";
  }
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

function extractArxivId(link: string): string | null {
  const match = link.match(/abs\/(\d+\.\d+)/);
  return match ? match[1] : null;
}

function parseAuthors(raw: string): string[] {
  if (!raw) return [];
  // arXiv format: "Author1, Author2, ..."  or "<a href=...>Author1</a>, ..."
  const cleaned = raw.replace(/<[^>]+>/g, "");
  return cleaned
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

function cleanText(text: string): string {
  return text
    .replace(/<[^>]+>/g, "") // strip HTML tags
    .replace(/\s+/g, " ") // normalize whitespace
    .trim();
}
