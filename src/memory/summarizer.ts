/**
 * 内部记忆摘要卡 LLM 增强器
 *
 * 读取现有 ContentCard（parser 规则生成的简单版本），
 * 调用 LLM 增强 title、oneLiner、tags、qualitySignal 字段。
 *
 * 幂等：已增强的卡片通过 `llmEnhanced` 标记跳过。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile, readdir, readFile as readFileAsync } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

import { loadRunEmbeddedPiAgent, collectText, stripCodeFences } from "../llm/loader.js";
import { saveCard, type ContentCard } from "../knowledge/graph.js";

// ─── Prompt Template ───

const SYSTEM_PROMPT = `你是个人记忆摘要助手。给定一段工作记忆的原始内容（可能是决策、洞察、日志、人物信息或项目记录），请输出以下 JSON（不要 markdown fence，不要额外解释）：

{
  "title": "简短标题（≤20字）",
  "oneLiner": "一句话中文概括核心内容（≤40字）"
}

规则：
- title: 用中文，简洁概括这段记忆的主题。不要照抄原文标题，提炼核心。如原标题已足够简洁准确，可保留
- oneLiner: 精炼概括核心结论或事实，帮助快速理解`;

function buildUserPrompt(card: ContentCard, rawContent: string): string {
  return `请为以下工作记忆生成增强摘要（严格按JSON格式，不要任何其他输出）：

原始标题: ${card.title}
日期: ${card.date}
来源文件: ${card.sourceFile ?? "unknown"}
${card.people?.length ? `相关人物: ${card.people.join(", ")}` : ""}

---原始内容---
${rawContent.slice(0, 2000)}
---

请直接输出JSON，格式如下（不要markdown fence，不要解释，不要使用任何工具）：
{"title":"简短标题","oneLiner":"一句话概括"}`;
}

// ─── Types ───

export interface SummarizerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface SummarizerResult {
  total: number;
  enhanced: number;
  skipped: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
  stats?: {
    totalDurationMs: number;
    avgDurationMs: number;
  };
}

// ─── Core ───

/**
 * 批量 LLM 增强记忆摘要卡
 *
 * @param indexDir - 记忆索引目录 (e.g. ~/.openclaw/memory-index)
 * @param memoryDir - 原始记忆文件目录 (e.g. ~/.openclaw/workspace/memory)
 */
export async function enhanceMemoryCards(
  indexDir: string,
  memoryDir: string,
  opts: {
    logger: SummarizerLogger;
    limit?: number;
    provider?: string;
    model?: string;
    agentDir?: string;
    config?: Record<string, unknown>;
    dryRun?: boolean;
  },
): Promise<SummarizerResult> {
  const { logger, limit, provider, model, agentDir, config, dryRun } = opts;

  // 加载 LLM
  let runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>> | null = null;
  if (!dryRun) {
    runFn = await loadRunEmbeddedPiAgent();
  }

  // 加载所有 memory 卡片
  const cardsDir = join(indexDir, "knowledge", "cards");
  if (!existsSync(cardsDir)) {
    logger.error(`Cards directory not found: ${cardsDir}`);
    return { total: 0, enhanced: 0, skipped: 0, failed: 0, errors: [] };
  }

  const cardFiles = (await readdir(cardsDir)).filter((f) => f.endsWith(".json"));
  const cards: ContentCard[] = [];

  for (const file of cardFiles) {
    try {
      const content = await readFileAsync(join(cardsDir, file), "utf-8");
      const card = JSON.parse(content) as ContentCard;
      if (card.type === "memory") {
        cards.push(card);
      }
    } catch {
      // skip malformed files
    }
  }

  logger.info(`[memory-summarizer] 找到 ${cards.length} 张记忆卡片`);

  // 筛选需要增强的卡片（跳过已增强的）
  const toEnhance = cards.filter((c) => !(c as any).llmEnhanced);
  const toProcess = limit ? toEnhance.slice(0, limit) : toEnhance;

  logger.info(`[memory-summarizer] 待增强: ${toProcess.length}（已增强: ${cards.length - toEnhance.length}）`);

  if (toProcess.length === 0 || dryRun) {
    return { total: toProcess.length, enhanced: 0, skipped: cards.length - toEnhance.length, failed: 0, errors: [] };
  }

  // 准备临时 session 目录
  const tmpSessionDir = join(indexDir, ".tmp-sessions");
  await mkdir(tmpSessionDir, { recursive: true });

  const result: SummarizerResult = {
    total: toProcess.length,
    enhanced: 0,
    skipped: cards.length - toEnhance.length,
    failed: 0,
    errors: [],
  };

  const durations: number[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const card = toProcess[i];
    const progress = `[${i + 1}/${toProcess.length}]`;

    // 读取原始内容（从 memory 目录中的源文件）
    const rawContent = loadRawContent(memoryDir, card);
    if (!rawContent || rawContent.length < 30) {
      logger.warn(`${progress} skip ${card.id} — 原始内容过短`);
      result.failed++;
      result.errors.push({ id: card.id, error: "原始内容过短" });
      continue;
    }

    try {
      const { enhanced, durationMs } = await callLLMForEnhancement(
        runFn!,
        card,
        rawContent,
        tmpSessionDir,
        { provider, model, agentDir, config },
      );

      // 更新卡片
      const updatedCard: ContentCard & { llmEnhanced: boolean } = {
        ...card,
        title: enhanced.title || card.title,
        oneLiner: enhanced.oneLiner || card.oneLiner,
        llmEnhanced: true,
      };

      await saveCard(indexDir, updatedCard);
      result.enhanced++;
      durations.push(durationMs);

      if (result.enhanced % 10 === 0 || result.enhanced <= 3) {
        logger.info(`${progress} ✅ ${card.id} → "${updatedCard.oneLiner}" (${durationMs}ms)`);
      }
    } catch (err) {
      result.failed++;
      result.errors.push({ id: card.id, error: (err as Error).message });
      logger.warn(`${progress} ❌ ${card.id} — ${(err as Error).message}`);
    }
  }

  // 统计
  if (durations.length > 0) {
    const totalDurationMs = durations.reduce((s, d) => s + d, 0);
    result.stats = {
      totalDurationMs,
      avgDurationMs: Math.round(totalDurationMs / durations.length),
    };
    logger.info(`[memory-summarizer] 统计: avg ${result.stats.avgDurationMs}ms/卡片`);
  }

  // 清理临时目录
  try {
    const { rm } = await import("node:fs/promises");
    await rm(tmpSessionDir, { recursive: true, force: true });
  } catch {
    // non-critical
  }

  logger.info(
    `[memory-summarizer] 完成: ${result.enhanced} 增强, ${result.skipped} 跳过, ${result.failed} 失败 / ${result.total} 总计`,
  );

  return result;
}

// ─── Helpers ───

/**
 * 从原始记忆文件中加载对应 section 的内容
 */
function loadRawContent(memoryDir: string, card: ContentCard): string | null {
  if (!card.sourceFile) return null;

  const filePath = join(memoryDir, card.sourceFile);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");

    // 从 url 中提取行号: memory://decisions.md#L19
    const lineMatch = card.url?.match(/#L(\d+)/);
    if (!lineMatch) return content.slice(0, 3000); // fallback: 取文件开头

    const startLine = parseInt(lineMatch[1], 10);
    const lines = content.split("\n");

    // 从起始行开始，到下一个同级或更高级标题结束
    const startIdx = startLine - 1;
    if (startIdx < 0 || startIdx >= lines.length) return null;

    // 检测当前标题级别
    const headerMatch = lines[startIdx]?.match(/^(#{1,6})\s/);
    const level = headerMatch ? headerMatch[1].length : 0;

    const sectionLines: string[] = [];
    for (let i = startIdx; i < lines.length; i++) {
      if (i > startIdx) {
        const nextHeader = lines[i].match(/^(#{1,6})\s/);
        if (nextHeader && nextHeader[1].length <= level) break;
      }
      sectionLines.push(lines[i]);
    }

    return sectionLines.join("\n");
  } catch {
    return null;
  }
}

interface EnhancedFields {
  title: string;
  oneLiner: string;
}

/**
 * 调用 LLM 增强单张记忆卡片
 */
async function callLLMForEnhancement(
  runFn: Awaited<ReturnType<typeof loadRunEmbeddedPiAgent>>,
  card: ContentCard,
  rawContent: string,
  tmpSessionDir: string,
  opts?: { provider?: string; model?: string; agentDir?: string; config?: Record<string, unknown> },
): Promise<{ enhanced: EnhancedFields; durationMs: number }> {
  const runId = randomUUID();
  const sessionId = `mem-summarizer-${card.id.slice(0, 20)}-${runId.slice(0, 8)}`;
  const workDir = join(tmpSessionDir, sessionId);
  await mkdir(workDir, { recursive: true });
  const sessionFile = join(workDir, `${sessionId}.json`);

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
      prompt: buildUserPrompt(card, rawContent),
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
    const jsonMatch = cleaned.match(/\{[\s\S]*?"title"[\s\S]*?"oneLiner"[\s\S]*?\}/);
    if (!jsonMatch) {
      throw new Error(`No valid JSON found: ${cleaned.slice(0, 150)}`);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<EnhancedFields>;
    if (!parsed.title || !parsed.oneLiner) {
      throw new Error(`Incomplete JSON: ${cleaned.slice(0, 100)}`);
    }

    return {
      enhanced: {
        title: parsed.title,
        oneLiner: parsed.oneLiner,
      },
      durationMs: result.meta?.durationMs ?? 0,
    };
  } finally {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
