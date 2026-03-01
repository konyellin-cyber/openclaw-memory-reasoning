/**
 * LLM 调用封装 — 动态加载 runEmbeddedPiAgent
 *
 * 策略：
 * 1. 尝试 import("openclaw/plugin-sdk") — 正式导出
 * 2. 尝试从 extensionAPI.js 加载（通过 require.resolve 找到 openclaw 包路径）
 * 3. 都不行就抛错
 */

import path from "node:path";
import { createRequire } from "node:module";

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<{
  payloads?: Array<{ text?: string; isError?: boolean }>;
  meta: { durationMs: number; agentMeta?: { provider: string; model: string; usage?: Record<string, number> } };
}>;

let _cachedFn: RunEmbeddedPiAgentFn | null = null;

export async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  if (_cachedFn) return _cachedFn;

  // 方式 1: openclaw/plugin-sdk 正式导出
  try {
    // @ts-expect-error — openclaw 不在项目 dependencies 中，仅 Gateway 运行时可用
    const mod = await import("openclaw/plugin-sdk");
    if (typeof (mod as any).runEmbeddedPiAgent === "function") {
      _cachedFn = (mod as any).runEmbeddedPiAgent;
      return _cachedFn!;
    }
  } catch {
    // 继续尝试其他方式
  }

  // 方式 2: 找到 openclaw 包根目录，直接 import extensionAPI.js
  try {
    const require_ = createRequire(import.meta.url);
    const openclawEntry = require_.resolve("openclaw");
    // openclawEntry 类似 /opt/homebrew/lib/node_modules/openclaw/dist/index.js
    const openclawDist = path.dirname(openclawEntry);
    const extensionApiPath = path.join(openclawDist, "extensionAPI.js");
    const mod = await import(extensionApiPath);
    if (typeof mod.runEmbeddedPiAgent === "function") {
      _cachedFn = mod.runEmbeddedPiAgent;
      return _cachedFn!;
    }
  } catch {
    // 继续
  }

  // 方式 3: 直接尝试绝对路径（hardcoded fallback，仅开发用）
  try {
    // @ts-expect-error — hardcoded path, no type declarations
    const mod = await import("/opt/homebrew/lib/node_modules/openclaw/dist/extensionAPI.js");
    if (typeof mod.runEmbeddedPiAgent === "function") {
      _cachedFn = mod.runEmbeddedPiAgent;
      return _cachedFn!;
    }
  } catch {
    // 最后一搏
  }

  throw new Error(
    "[personal-rec] 无法加载 runEmbeddedPiAgent — 所有加载策略均失败。" +
    "请确认 openclaw 已安装且版本支持 plugin-sdk。"
  );
}

/**
 * 从 LLM 结果中提取文本
 */
export function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

/**
 * 去掉 LLM 输出中的 markdown code fence
 */
export function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? (m[1] ?? "").trim() : trimmed;
}
