/**
 * 摘要卡生成器 — 调用 LLM 为论文生成 SummaryCard
 *
 * 使用 runEmbeddedPiAgent 做 LLM 推理。
 * 逐篇生成，串行执行避免 rate limit。
 *
 * 注意：不使用 disableTools: true，因为 DashScope coding 端点
 * 不接受空 tools 数组。通过强 prompt 约束模型只输出 JSON。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { loadRunEmbeddedPiAgent, collectText, stripCodeFences } from "../llm/loader.js";
import type { SummaryCard, ContentCard } from "../knowledge/graph.js";
import { cardExists, saveCard } from "../knowledge/graph.js";
import type { FeedItem } from "../feeds/parser.js";

// ─── Prompt Template ───

const SYSTEM_PROMPT = `你是论文摘要助手。给定论文的 title 和 abstract，请输出以下 JSON（不要 markdown fence，不要额外解释）：

{
  "tags": ["tag1", "tag2"],
  "oneLiner": "一句话中文概括（≤30字）",
  "qualitySignal": "核心方法或贡献的一句话描述"
}

规则：
- tags: 2-3 个关键技术标签，英文，小写，如 "graph-neural-network", "collaborative-filtering"
- oneLiner: 精炼的中文概括，帮助快速判断论文方向
- qualitySignal: 描述核心贡献/方法，英文或中文均可`;

function buildUserPrompt(item: FeedItem): string {
  return `请为以下论文生成摘要卡（严格按JSON格式，不要任何其他输出）：

Title: ${item.title}

Abstract: ${item.abstract}

请直接输出JSON，格式如下（不要markdown fence，不要解释，不要使用任何工具）：
{"tags":["tag1","tag2"],"oneLiner":"一句话中文概括","qualitySignal":"核心贡献描述"}`;
}

// ─── Types ───

export interface GeneratorLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface GenerateResult {
  total: number;
  generated: number;
  skipped: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
  /** 统计信息 — 用于记录压缩比和耗时成本 */
  stats?: {
    totalDurationMs: number;
    avgDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgInputTokens: number;
    avgOutputTokens: number;
    avgCompressionRatio: number; // inputTokens / outputTokens
    perPaper: Array<{
      id: string;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      compressionRatio: number;
    }>;
  };
}

// ─── Generator ───

/**
 * 为一批论文生成摘要卡。
 * 已有摘要卡的论文会跳过（幂等）。
 *
 * @param dataDir - 数据根目录 (e.g. ~/.openclaw/personal-rec)
 * @param items - 论文列表
 * @param opts.logger - 日志
 * @param opts.maxRetries - JSON parse 失败时重试次数（默认 1）
 * @param opts.limit - 最多处理多少篇（调试用）
 * @param opts.provider - LLM provider (e.g. "alibaba", "zai", "anthropic")
 * @param opts.model - LLM model name (e.g. "qwen3.5-plus", "glm-4.7")
 * @param opts.config - OpenClaw config (needed for custom provider apiKey resolution)
 */
export async function generateSummaryCards(
  dataDir: string,
  items: FeedItem[],
  opts: {
    logger: GeneratorLogger;
    maxRetries?: number;
    limit?: number;
    provider?: string;
    model?: string;
    agentDir?: string;
    config?: Record<string, unknown>;
  },
): Promise<GenerateResult> {
  const { logger, maxRetries = 1, limit, provider, model, agentDir, config } = opts;
  const runFn = await loadRunEmbeddedPiAgent();

  // 准备临时 session 目录
  const tmpSessionDir = join(dataDir, ".tmp-sessions");
  await mkdir(tmpSessionDir, { recursive: true });

  const toProcess = limit ? items.slice(0, limit) : items;
  const result: GenerateResult = { total: toProcess.length, generated: 0, skipped: 0, failed: 0, errors: [] };

  // 统计数据收集
  const perPaperStats: Array<{
    id: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    compressionRatio: number;
  }> = [];

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;

    // 跳过已有摘要卡的论文
    if (await cardExists(dataDir, item.id)) {
      result.skipped++;
      continue;
    }

    // 跳过没有 abstract 的论文
    if (!item.abstract || item.abstract.length < 20) {
      logger.warn(`${progress} skip ${item.id} — abstract too short`);
      result.skipped++;
      continue;
    }

    let card: ContentCard | null = null;
    let meta: CallMeta | null = null;
    let lastError = "";

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const r = await callLLMForCard(runFn, item, tmpSessionDir, { provider, model, agentDir, config });
        card = r.card;
        meta = r.meta;
        break;
      } catch (err) {
        lastError = (err as Error).message;
        if (attempt < maxRetries) {
          logger.warn(`${progress} ${item.id} attempt ${attempt + 1} failed, retrying...`);
        }
      }
    }

    if (card) {
      await saveCard(dataDir, card);
      result.generated++;

      // 收集统计
      if (meta) {
        const inputTokens = meta.usage?.prompt_tokens ?? meta.usage?.input_tokens ?? 0;
        const outputTokens = meta.usage?.completion_tokens ?? meta.usage?.output_tokens ?? 0;
        const compressionRatio = outputTokens > 0 ? inputTokens / outputTokens : 0;
        perPaperStats.push({
          id: item.id,
          durationMs: meta.durationMs,
          inputTokens,
          outputTokens,
          compressionRatio,
        });
      }

      if (result.generated % 10 === 0 || result.generated <= 3) {
        logger.info(`${progress} ✅ ${item.id} → "${card.oneLiner}" (${meta?.durationMs ?? "?"}ms)`);
      }
    } else {
      result.failed++;
      result.errors.push({ id: item.id, error: lastError });
      logger.warn(`${progress} ❌ ${item.id} — ${lastError}`);
    }
  }

  // 汇总统计
  if (perPaperStats.length > 0) {
    const totalDurationMs = perPaperStats.reduce((s, p) => s + p.durationMs, 0);
    const totalInputTokens = perPaperStats.reduce((s, p) => s + p.inputTokens, 0);
    const totalOutputTokens = perPaperStats.reduce((s, p) => s + p.outputTokens, 0);
    const n = perPaperStats.length;
    result.stats = {
      totalDurationMs,
      avgDurationMs: Math.round(totalDurationMs / n),
      totalInputTokens,
      totalOutputTokens,
      avgInputTokens: Math.round(totalInputTokens / n),
      avgOutputTokens: Math.round(totalOutputTokens / n),
      avgCompressionRatio: totalOutputTokens > 0 ? Math.round((totalInputTokens / totalOutputTokens) * 100) / 100 : 0,
      perPaper: perPaperStats,
    };
    logger.info(`[summarizer] stats: avg ${result.stats.avgDurationMs}ms/paper, input ${result.stats.avgInputTokens} tok → output ${result.stats.avgOutputTokens} tok, compression ratio ${result.stats.avgCompressionRatio}x`);
  }

  // 清理临时 session 目录
  try {
    const { rm } = await import("node:fs/promises");
    await rm(tmpSessionDir, { recursive: true, force: true });
  } catch {
    // non-critical
  }

  logger.info(
    `[summarizer] done: ${result.generated} generated, ${result.skipped} skipped, ${result.failed} failed / ${result.total} total`,
  );

  return result;
}

interface CallMeta {
  durationMs: number;
  usage?: Record<string, number>;
}

/**
 * 调用 LLM 生成单篇论文的摘要卡
 */
async function callLLMForCard(
  runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>,
  item: FeedItem,
  tmpSessionDir: string,
  opts?: { provider?: string; model?: string; agentDir?: string; config?: Record<string, unknown> },
): Promise<{ card: ContentCard; meta: CallMeta }> {
  const runId = randomUUID();
  const sessionId = `summarizer-${item.id}-${runId.slice(0, 8)}`;
  // 每次调用创建独立的 workspaceDir，避免 Gateway 扫描同目录其他文件干扰 system prompt
  const workDir = join(tmpSessionDir, sessionId);
  await mkdir(workDir, { recursive: true });
  const sessionFile = join(workDir, `${sessionId}.json`);

  // 创建带有正确 session header 的 session 文件（JSONL 格式）
  const sessionHeader = {
    type: "session",
    version: 2,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: workDir,
  };
  await writeFile(sessionFile, `${JSON.stringify(sessionHeader)}\n`, "utf-8");

  try {
    const result = await runFn({
      sessionId,
      sessionFile,
      workspaceDir: workDir,
      prompt: buildUserPrompt(item),
      extraSystemPrompt: SYSTEM_PROMPT,
      timeoutMs: 60_000,
      runId,
      ...(opts?.provider ? { provider: opts.provider } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.agentDir ? { agentDir: opts.agentDir } : {}),
      ...(opts?.config ? { config: opts.config } : {}),
    });

    const text = collectText(result.payloads);
    if (!text) {
      throw new Error("LLM returned empty response");
    }

    const cleaned = stripCodeFences(text);
    // 从可能包含额外文本的响应中提取 JSON 对象
    const jsonMatch = cleaned.match(/\{[\s\S]*?"tags"[\s\S]*?"oneLiner"[\s\S]*?"qualitySignal"[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error(`No valid JSON found in LLM response: ${cleaned.slice(0, 150)}`);
    }
    const jsonStr = jsonMatch[0];
    const parsed = JSON.parse(jsonStr) as {
      tags?: string[];
      oneLiner?: string;
      qualitySignal?: string;
    };

    if (!parsed.tags || !parsed.oneLiner || !parsed.qualitySignal) {
      throw new Error(`Incomplete JSON: ${cleaned.slice(0, 100)}`);
    }

    const card: ContentCard = {
      id: item.id,
      type: "paper",
      title: item.title,
      tags: parsed.tags.slice(0, 3),
      oneLiner: parsed.oneLiner,
      qualitySignal: parsed.qualitySignal,
      source: item.source,
      date: item.date,
      url: item.url,
      generatedAt: new Date().toISOString(),
    };

    const callMeta: CallMeta = {
      durationMs: result.meta?.durationMs ?? 0,
      usage: result.meta?.agentMeta?.usage,
    };

    return { card, meta: callMeta };
  } finally {
    // 清理独立的临时 workDir（含 session 文件）
    try {
      const { rm } = await import("node:fs/promises");
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
