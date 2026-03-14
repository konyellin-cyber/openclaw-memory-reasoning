/**
 * 搜索结果去重器 — Phase 5.3
 *
 * 去重逻辑：
 * 1. 批次内去重：多个 query 可能搜到同一篇论文（paperId 相同）
 * 2. 与现有卡片去重：
 *    - 优先用 arxivId 匹配（现有论文卡片 ID 就是 arXiv ID 格式）
 *    - 无 arxivId 时用 "ss:{paperId}" 前缀匹配
 */

import { listCardIds } from "../knowledge/graph.js";
import type { SearchResult } from "./semantic-scholar.js";

// ─── Types ───

export interface DeduplicateResult {
  /** 去重后的新论文 */
  newPapers: SearchResult[];
  /** 统计 */
  stats: {
    totalSearched: number;
    batchDuplicates: number;   // 批次内重复
    existingDuplicates: number; // 已入库重复
    newCount: number;           // 去重后新论文数
  };
}

// ─── Core ───

/**
 * 对搜索结果执行去重
 *
 * @param results - 所有 query 的搜索结果（可能有重复）
 * @param dataDir - 数据根目录（用于加载现有卡片 ID）
 */
export async function deduplicateResults(
  results: SearchResult[],
  dataDir: string,
): Promise<DeduplicateResult> {
  const totalSearched = results.length;

  // 1. 加载现有卡片 ID 集合
  const existingIds = new Set(await listCardIds(dataDir));

  // 2. 批次内去重（基于 paperId）
  const seenPaperIds = new Set<string>();
  let batchDuplicates = 0;
  const uniqueInBatch: SearchResult[] = [];

  for (const paper of results) {
    if (seenPaperIds.has(paper.paperId)) {
      batchDuplicates++;
      continue;
    }
    seenPaperIds.add(paper.paperId);
    uniqueInBatch.push(paper);
  }

  // 3. 与现有卡片去重
  let existingDuplicates = 0;
  const newPapers: SearchResult[] = [];

  for (const paper of uniqueInBatch) {
    if (isExistingPaper(paper, existingIds)) {
      existingDuplicates++;
      continue;
    }
    newPapers.push(paper);
  }

  return {
    newPapers,
    stats: {
      totalSearched,
      batchDuplicates,
      existingDuplicates,
      newCount: newPapers.length,
    },
  };
}

/**
 * 检查论文是否已在现有卡片中
 */
function isExistingPaper(paper: SearchResult, existingIds: Set<string>): boolean {
  // 优先用 arxivId 匹配（现有论文卡片 ID 就是 arXiv ID 格式，如 "2602.12345"）
  if (paper.arxivId && existingIds.has(paper.arxivId)) {
    return true;
  }

  // fallback: 用 "ss:{paperId}" 前缀匹配
  if (existingIds.has(`ss:${paper.paperId}`)) {
    return true;
  }

  return false;
}

/**
 * 为搜索结果生成卡片 ID
 * 优先用 arxivId，无则用 "ss:{paperId}"
 */
export function deriveCardId(paper: SearchResult): string {
  return paper.arxivId ?? `ss:${paper.paperId}`;
}
