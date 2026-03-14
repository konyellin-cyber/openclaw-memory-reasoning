/**
 * Semantic Scholar API 封装 — Phase 5.2
 *
 * 封装 Semantic Scholar Graph API，返回标准化论文搜索结果。
 * - 无 API Key：限 1 req/s（每请求间 sleep 1000ms）
 * - HTTP 429 指数退避重试（1s → 2s → 4s），最多 3 次
 * - HTTP 5xx 重试 1 次后 skip
 * - 网络超时 10s
 *
 * 零新 npm 依赖：使用 Node.js 内置 fetch
 */

// ─── Types ───

export interface SearchResult {
  paperId: string;         // Semantic Scholar ID
  arxivId: string | null;  // arXiv ID（从 externalIds.ArXiv 提取）
  title: string;
  abstract: string;
  authors: string[];       // 作者姓名列表
  year: number;
  url: string;             // Semantic Scholar URL
  citationCount: number;
}

export interface SearchOpts {
  limit?: number;          // 每个 query 返回的论文数（默认 10）
  offset?: number;         // 分页偏移（默认 0）
  apiKey?: string;         // Semantic Scholar API Key（可选，有 key 速率限制更宽）
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// ─── Constants ───

const BASE_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS = "title,abstract,authors,year,externalIds,url,citationCount";
const TIMEOUT_MS = 10_000;
const RATE_LIMIT_DELAY_MS = 1_500; // 无 key 限 ~0.67 req/s（实测 1s 仍频繁 429）
const MAX_RETRIES = 3;

// ─── Rate limiter ───

let lastRequestTime = 0;

async function rateLimitWait(hasApiKey: boolean): Promise<void> {
  if (hasApiKey) return; // 有 key 速率限制更宽松
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await sleep(RATE_LIMIT_DELAY_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Core ───

/**
 * 搜索论文
 */
export async function searchPapers(
  query: string,
  opts: SearchOpts = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 10;
  const offset = opts.offset ?? 0;
  const logger = opts.logger ?? { info: console.log, warn: console.warn, error: console.error };

  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    fields: FIELDS,
  });

  const url = `${BASE_URL}?${params.toString()}`;
  const headers: Record<string, string> = {};
  if (opts.apiKey) {
    headers["x-api-key"] = opts.apiKey;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await rateLimitWait(!!opts.apiKey);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = (await response.json()) as {
          total?: number;
          data?: Array<Record<string, unknown>>;
        };

        const papers = (data.data ?? []).map(normalizePaper);
        logger.info(`[semantic-scholar] query="${query}" → ${papers.length} results (total: ${data.total ?? "?"})`);
        return papers;
      }

      if (response.status === 429) {
        // 429 Too Many Requests — 指数退避
        const backoffMs = RATE_LIMIT_DELAY_MS * Math.pow(2, attempt);
        logger.warn(`[semantic-scholar] 429 rate limited, backing off ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(backoffMs);
        lastError = new Error(`HTTP 429: Rate limited`);
        continue;
      }

      if (response.status >= 500) {
        // 5xx — 重试 1 次后 skip
        if (attempt === 0) {
          logger.warn(`[semantic-scholar] HTTP ${response.status}, retrying once...`);
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
          await sleep(1000);
          continue;
        }
        logger.error(`[semantic-scholar] HTTP ${response.status} after retry, skipping query="${query}"`);
        return [];
      }

      // 其他错误（4xx 等）不重试
      logger.error(`[semantic-scholar] HTTP ${response.status}: ${response.statusText} for query="${query}"`);
      return [];
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        logger.warn(`[semantic-scholar] Timeout (${TIMEOUT_MS}ms) for query="${query}" (attempt ${attempt + 1}/${MAX_RETRIES})`);
        lastError = new Error(`Timeout after ${TIMEOUT_MS}ms`);
        if (attempt < MAX_RETRIES - 1) continue;
        return [];
      }
      // 网络错误
      logger.error(`[semantic-scholar] Network error for query="${query}": ${error.message}`);
      lastError = error;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RATE_LIMIT_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      return [];
    }
  }

  logger.error(`[semantic-scholar] All retries exhausted for query="${query}": ${lastError?.message}`);
  return [];
}

// ─── Normalization ───

function normalizePaper(raw: Record<string, unknown>): SearchResult {
  const externalIds = (raw.externalIds ?? {}) as Record<string, string | undefined>;
  const authors = (raw.authors ?? []) as Array<{ name?: string }>;

  return {
    paperId: String(raw.paperId ?? ""),
    arxivId: externalIds.ArXiv ?? null,
    title: String(raw.title ?? ""),
    abstract: String(raw.abstract ?? ""),
    authors: authors.map((a) => a.name ?? "").filter(Boolean),
    year: Number(raw.year ?? 0),
    url: String(raw.url ?? `https://www.semanticscholar.org/paper/${raw.paperId}`),
    citationCount: Number(raw.citationCount ?? 0),
  };
}
