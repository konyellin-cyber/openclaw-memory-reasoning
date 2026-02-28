# 技术方案：基于 Plugin Hook 的推理路由记忆加载

## 方案概述

利用 OpenClaw 的 `before_prompt_build` Plugin Hook，在 system prompt 构建之前插入一个**推理路由层**，根据用户消息的意图动态决定加载哪些记忆文件，替代当前的全量灌入机制。

**核心理念**：把 MEMORY.md 从"被动文本"变为"主动路由表"，由插件在代码层面解析执行。

---

## 流程对比：修改前 vs 修改后

### 修改前：全量灌入 + Agent 自觉搜索

```
用户发送消息："帮我回顾一下推荐系统的召回实验效果"
  │
  ▼
① Session 初始化
  │  loadWorkspaceBootstrapFiles()
  │  读取 MEMORY.md 全文（~5K tokens）
  │  截断到 20,000 字符
  │  ⚠️ 不理解 MEMORY.md 的结构，当纯文本处理
  │
  ▼
② System Prompt 组装
  │  将 MEMORY.md 全文塞入 "Project Context" 段落
  │  附带一段指令："## Memory Recall — 回答前请搜索 memory..."
  │  ⚠️ MEMORY.md 里的映射表只是文本，没有被代码解析执行
  │
  ▼
③ LLM 调用
  │  Agent 收到 system prompt（含 MEMORY.md 全文 + 搜索指令）
  │  Agent 自行判断是否调用 memory_search
  │  ⚠️ 可能搜也可能不搜（取决于 LLM 对指令的遵循度）
  │
  ├── 情况 A：Agent 没搜索（常见于简单问题）
  │     → 仅凭 MEMORY.md 全文中碰巧看到的片段回答
  │     → 回答可能不完整或错误
  │
  └── 情况 B：Agent 调用了 memory_search("召回实验")
        → SQLite embedding + FTS5 关键词搜索
        → 返回语义匹配的片段（可能命中，也可能偏）
        → ⚠️ 搜索是关键词驱动，不是领域驱动
        → 不会按 MEMORY.md 映射表去加载 insights/recsys-algorithm.md
        │
        ▼
④ Agent 回答
   上下文 = MEMORY.md 全文（大部分无关）+ 可能搜到的片段
   记忆命中：不确定 ❌
   Token 消耗：5K-13K（大量浪费）
```

**问题汇总**：

| 步骤 | 问题 |
|------|------|
| ① Bootstrap | 全量注入，不看用户在问什么 |
| ② System Prompt | MEMORY.md 的映射表没有被代码执行，只是"希望 Agent 看懂" |
| ③ LLM 搜索 | Agent 是否搜索不可控；搜索方式是关键词匹配而非领域路由 |
| ④ 回答 | 上下文里大部分内容与问题无关，关键信息可能缺失 |

---

### 修改后：推理路由 + 精准加载

```
用户发送消息："帮我回顾一下推荐系统的召回实验效果"
  │
  ▼
① Session 初始化（OpenClaw Core，不变）
  │  加载 session messages
  │  MEMORY.md 仍可作为轻量索引注入（精简后 <2K tokens）
  │
  ▼
② before_prompt_build Hook 触发 ← 【新增：插件介入点】
  │
  │  ┌─────────────────────────────────────────┐
  │  │ memory-reasoning 插件                     │
  │  │                                           │
  │  │ Step A: 读取记忆索引                        │
  │  │   加载 MEMORY.md 索引文件（~2K tokens）     │
  │  │   包含：目录结构、文件描述、主题说明         │
  │  │                                           │
  │  │ Step B: 模型推理路由                        │
  │  │   调用轻量模型（如 haiku / gemini-flash）   │
  │  │   输入：用户消息 + 记忆索引全文              │
  │  │   模型理解索引结构后推理：                   │
  │  │   "用户在问推荐系统召回实验                  │
  │  │    → 需要 insights/recsys-algorithm.md     │
  │  │    → 需要 projects/ 下的相关项目文件"        │
  │  │   输出：JSON 文件列表 + 推理理由             │
  │  │                                           │
  │  │ Step C: 读取文件（并行，~10ms）             │
  │  │   读取模型指定的记忆文件                     │
  │  │   Token 预算控制（上限 8K）                 │
  │  │                                           │
  │  │ Step D: 返回 prependContext                │
  │  │   拼装精准记忆上下文（~3K tokens）          │
  │  └─────────────────────────────────────────┘
  │
  ▼
③ System Prompt 组装（OpenClaw Core，不变）
  │  prependContext（精准记忆）拼接到用户 prompt 前面
  │  + 原有 system prompt（含精简版 MEMORY.md）
  │  + Skills / Tools 指令
  │
  ▼
④ LLM 调用
  │  Agent 收到的上下文里已经包含了精准的推荐系统记忆
  │  Agent 仍可调用 memory_search 做更细粒度的查询（互补）
  │
  ▼
⑤ Agent 回答
   上下文 = 精准加载的领域记忆（高度相关）
   记忆命中：确定性高 ✅
   Token 消耗：1K-5K（精准高效）
```

**改善汇总**：

| 步骤 | 修改前 | 修改后 |
|------|--------|--------|
| ① 初始化 | MEMORY.md 全文灌入（5K-8K tokens） | MEMORY.md 精简为轻量索引（<2K tokens） |
| ② 记忆路由 | ❌ 不存在 | ✅ 插件调用轻量模型理解索引，推理出需要加载的文件（~300ms） |
| ③ 上下文组装 | 全量无差别注入 | 精准领域文件 + prependContext 拼接 |
| ④ LLM 搜索 | Agent 可能搜可能不搜（不可控） | 核心记忆已预加载，Agent 搜索变为补充而非必须 |
| ⑤ 回答质量 | 取决于 Agent 自觉性 | 系统级保障，关键记忆必定在上下文中 |

---

### 场景对比

#### 场景 1：用户聊推荐系统

| | 修改前 | 修改后 |
|---|---|---|
| **加载内容** | MEMORY.md 全文（含个人信息、待办、家庭等无关内容） | `insights/recsys-algorithm.md` + `projects/` 相关文件 |
| **Token 消耗** | ~8K（全量） | ~3K（精准） |
| **记忆命中** | 看 Agent 是否主动搜索 | 100% 命中 |

#### 场景 2：用户聊天气（不需要记忆）

| | 修改前 | 修改后 |
|---|---|---|
| **加载内容** | MEMORY.md 全文（完全浪费） | 模型判断无需记忆 → 不加载（零浪费） |
| **Token 消耗** | ~8K（浪费） | ~0（节省） |
| **记忆命中** | N/A | N/A |

#### 场景 3：用户说"继续上次的讨论"

| | 修改前 | 修改后 |
|---|---|---|
| **加载内容** | MEMORY.md 全文，Agent 可能猜上次聊了什么 | 模型理解"继续讨论"意图 → 加载最近日志 |
| **Token 消耗** | ~8K + Agent 可能搜索 | ~4K（最近日志） |
| **记忆命中** | 不确定，Agent 需要先猜再搜 | 高，日志中包含完整对话摘要 |

#### 场景 4：用户问"我喜欢什么类型的音乐"

| | 修改前 | 修改后 |
|---|---|---|
| **加载内容** | MEMORY.md 全文，个人偏好可能被截断 | 模型从索引中找到 `facts/personal.md` → 精准加载 |
| **Token 消耗** | ~8K | ~2K |
| **记忆命中** | 取决于 MEMORY.md 是否包含、是否被截断 | 100% 命中（`personal.md` 完整加载） |

---

### 数据流对比图

**修改前**：
```
                    ┌──────────────────┐
                    │   MEMORY.md 全文  │ (~5K-8K tokens)
                    └────────┬─────────┘
                             │ 全量注入（不看用户在问什么）
                             ▼
┌──────────┐      ┌──────────────────────┐      ┌──────────┐
│ 用户消息  │─────→│   System Prompt      │─────→│   LLM    │
└──────────┘      │  (MEMORY.md 全文     │      │          │
                  │   + 搜索指令)         │      │ 可能搜索  │
                  └──────────────────────┘      │ 可能不搜  │
                                                └────┬─────┘
                                                     │
                  ┌──────────────────────┐           │ 不确定
                  │ memory_search (可选)  │◄──────────┘
                  │ 关键词/语义匹配       │
                  └──────────────────────┘
```

**修改后**：
```
                    ┌──────────────────┐
                    │   MEMORY.md 索引  │ (目录结构 + 文件描述)
                    └────────┬─────────┘
                             │ 作为推理输入
                             ▼
┌──────────┐      ┌──────────────────────────┐
│ 用户消息  │─────→│ memory-reasoning 插件     │
└──────────┘      │ (before_prompt_build)     │
                  │                           │
                  │ 调用轻量模型 (~300ms)      │
                  │ 输入：用户消息 + 索引全文   │
                  │ 输出：需要加载的文件列表    │
                  └────────┬──────────────────┘
                           │ 按模型推理结果加载
                           ▼
                  ┌──────────────────────┐
                  │ insights/xxx.md      │ (~1K-5K tokens)
                  │ projects/xxx.md      │ (模型认为相关的)
                  └────────┬─────────────┘
                           │ prependContext
                           ▼
                  ┌──────────────────────┐      ┌──────────┐
                  │   System Prompt      │─────→│   LLM    │
                  │  (精准记忆上下文      │      │          │
                  │   + 精简版索引)       │      │ 已有记忆  │
                  └──────────────────────┘      │ 搜索可选  │
                                                └──────────┘
```

---

## 为什么选择 `before_prompt_build` Hook

### 对比其他扩展点

| 扩展点 | 能否拿到用户消息 | 能否注入上下文 | 侵入性 | 评估 |
|--------|:---:|:---:|:---:|------|
| `agent:bootstrap` Internal Hook | ❌ 只有 session 级信息 | ✅ 可修改 bootstrapFiles | 低 | 无法做消息级路由 |
| `before_prompt_build` Plugin Hook | ✅ `event.prompt` + `event.messages` | ✅ `prependContext` | 零 | **最佳切入点** |
| Skill SOP 强化 | ✅ Agent 可读消息 | ⚠️ 依赖 Agent 执行 | 零 | 不可靠 |
| 修改 `workspace.ts` | ✅ | ✅ | 高 | 需 fork OpenClaw |

### `before_prompt_build` 的关键优势

1. **精确时机**：在 session 历史加载完成后、system prompt 提交前执行
2. **完整上下文**：可访问 `event.prompt`（当前消息）和 `event.messages`（对话历史）
3. **非侵入注入**：通过 `prependContext` 将内容拼接到用户 prompt 前方
4. **多插件兼容**：`prependContext` 是累加拼接的，不会与其他插件冲突
5. **异步支持**：处理函数可以 async/await，支持文件读取、网络调用

---

## 架构设计

### 整体流程

```
用户消息到达
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ OpenClaw Core（不修改）                                │
│                                                        │
│  session 加载 → messages 准备好                         │
│       │                                                │
│       ▼                                                │
│  ┌─── before_prompt_build Hook ───┐                   │
│  │                                 │                   │
│  │  ┌───────────────────────────┐  │                   │
│  │  │ memory-reasoning 插件     │  │                   │
│  │  │                           │  │                   │
│  │  │ 1. 读取 MEMORY.md 索引   │  │                   │
│  │  │ 2. 调用轻量模型推理       │  │                   │
│  │  │    "用户消息+索引→文件列表"│  │                   │
│  │  │ 3. 读取推理结果指定的文件  │  │                   │
│  │  │ 4. 返回 prependContext    │  │                   │
│  │  └───────────────────────────┘  │                   │
│  │                                 │                   │
│  └─────────────────────────────────┘                   │
│       │                                                │
│       ▼                                                │
│  system prompt 组装（含注入的记忆上下文）                 │
│       │                                                │
│       ▼                                                │
│  LLM 调用（主模型）                                     │
└──────────────────────────────────────────────────────┘
```

### 插件内部架构

```
memory-reasoning-plugin/
├── src/
│   ├── index.ts                  # 插件入口，注册 hook
│   ├── reasoning/
│   │   ├── memory-router.ts      # 核心：调用轻量模型做路由推理
│   │   ├── index-loader.ts       # MEMORY.md 索引加载 + 缓存
│   │   └── prompt-template.ts    # 推理 prompt 模板
│   ├── loader/
│   │   ├── memory-reader.ts      # 记忆文件读取
│   │   └── context-builder.ts    # 上下文拼装 + 预算控制
│   ├── config/
│   │   └── types.ts              # 配置类型
│   └── utils/
│       └── logger.ts             # 调试日志
├── package.json
└── tsconfig.json
```

---

## 核心模块设计

### 1. 记忆索引（Memory Index）

不再维护独立的路由表（`route-table.yaml`），而是**直接复用 MEMORY.md 作为模型的推理输入**。MEMORY.md 本身就是用户精心设计的索引文件，包含目录结构、文件说明、主题分类——这些信息对模型来说完全可以理解。

**MEMORY.md 的角色转变**：

| | 修改前 | 修改后 |
|---|---|---|
| **给谁看** | 全文灌入 system prompt，希望 Agent 自己看懂 | 作为推理模型的输入，由插件系统级调用 |
| **执行方式** | 被动文本，Agent 可能忽略 | 主动输入，模型必须基于它做出路由决策 |
| **维护方式** | 不变 | 不变（用户照常维护，不需要学新格式） |

**优势**：用户不需要维护两套配置（MEMORY.md + route-table.yaml），索引文件就是路由表，路由表就是索引文件。

**MEMORY.md 示例结构**（索引部分，供推理模型阅读）：

```markdown
## 记忆目录结构

memory/
├── insights/                    # 洞察与方法论
│   ├── recsys-algorithm.md      # 推荐系统、召回、排序、模型、特征工程
│   ├── business-product.md      # 商业变现、产品策略、用户增长
│   ├── management-org.md        # 团队管理、组织协作、OKR
│   └── creation-tools.md        # 创作工具、AI 应用、数字分身
├── projects/                    # 项目追踪（每项目独立文件）
│   ├── <project-A>.md
│   └── <project-B>.md
├── facts/                       # 事实信息
│   ├── personal.md              # 个人兴趣、偏好、生活方式
│   ├── work.md                  # 职场信息、部门、同事
│   └── family.md                # 家庭信息
├── YYYY-MM-DD.md                # 每日日志
├── decisions.md                 # 决策记录
├── conversations.md             # 讨论记录
└── todo.md                      # 待办事项
```

模型读到这个索引后，就能理解"推荐系统"相关的内容在 `insights/recsys-algorithm.md`，"个人偏好"在 `facts/personal.md`——不需要关键词硬编码。

### 2. 推理路由器（Reasoning Router）— 核心模块

用轻量模型阅读记忆索引，理解用户意图后输出文件加载决策。

**设计理念**：把"Agent 应该搜索记忆"这件事，从"靠 prompt 指令提示 Agent 自觉执行"变为"由独立的推理模型在代码层面强制执行"。

**推理 Prompt 模板**：

```
You are a memory routing assistant. Your job is to decide which memory files 
should be loaded to help answer the user's message.

## Memory Index
{MEMORY.md 索引内容}

## Current Context
- User message: "{用户消息}"
- Recent conversation topics: {最近 3 轮对话的摘要，可选}

## Task
Based on the memory index above and the user's message:
1. Determine if any memory files are relevant to this conversation
2. If yes, list the specific file paths that should be loaded
3. If no memory is needed (e.g., general chat, simple questions), return empty

## Response Format (JSON only)
{
  "needs_memory": true/false,
  "files": ["memory/insights/recsys-algorithm.md", "memory/projects/xxx.md"],
  "reasoning": "一句话说明为什么选这些文件"
}
```

**模型调用方式：复用 OpenClaw 内部 `runEmbeddedPiAgent`**

本插件不自行管理 API Key 或 SDK，而是直接复用 OpenClaw 官方的 `llm-task` 扩展所使用的 `runEmbeddedPiAgent()` 内部调用机制。这是 OpenClaw 内置的"从插件中调 LLM"标准模式，具备以下能力：

- **三级回退**：插件配置 → 全局默认模型 → 硬编码 fallback
- **复用认证**：自动读取 `api.config` 中已配置的 provider（apiKey、baseUrl），无需插件独立管理
- **协议统一**：所有 provider（智谱、Kimi、阿里等）都走 OpenAI-兼容的 `openai-completions` 协议
- **配置透传**：通过 `api.config` 传入完整配置，`runEmbeddedPiAgent` 内部自动解析 provider 和认证信息

**参考实现**：OpenClaw 的 `llm-task` bundled extension（`extensions/llm-task/src/llm-task-tool.ts`）使用了完全相同的模式。

**模型选择策略**：

| 模型 | 延迟 | 成本 | 推理质量 | 推荐场景 |
|------|------|------|---------|---------|
| claude-3-haiku | ~300ms | 极低 | 足够 | **默认推荐** |
| gemini-2.0-flash | ~200ms | 极低 | 足够 | 备选 |
| gpt-4o-mini | ~400ms | 低 | 好 | 复杂索引 |
| 用户当前主模型（回退） | 视模型而定 | 视模型而定 | 好 | 未配置推理模型时的 fallback |

**关键设计决策**：

1. **推理模型与主对话模型独立** — 推理模型只做"读索引 → 选文件"这一件事，不参与实际对话。即使主模型是 Claude Opus，推理路由也只需要 Haiku 级别。

2. **零额外认证配置** — 通过 `api.config.agents.defaults.model.primary` 获取默认 provider/model，或在 `pluginConfig` 中指定 `routingProvider`/`routingModel` 覆盖。所有认证信息从 OpenClaw 全局配置中自动获取。

3. **索引缓存** — MEMORY.md 的内容在首次读取后缓存，通过 mtime 检测变更。推理模型每次都会被调用（因为用户消息不同），但索引输入是缓存的。

4. **Structured Output** — 要求模型返回 JSON 格式，便于代码层面解析。如果模型返回格式异常，fallback 到不加载额外记忆（安全降级）。

5. **对话历史感知** — 可选地将最近几轮对话的摘要传给推理模型，帮助理解"继续讨论""上次那个"等指代性表达。

**TypeScript 实现**：

```typescript
import { loadRunEmbeddedPiAgent } from "openclaw/runtime"; // OpenClaw 内部 API

interface ReasoningResult {
  needs_memory: boolean;
  files: string[];
  reasoning: string;
}

async function reasonMemoryRoute(
  prompt: string,
  messages: unknown[],
  memoryIndex: string,       // MEMORY.md 索引内容
  config: PluginConfig,
  api: OpenClawPluginApi,    // 插件 API，提供完整配置
): Promise<ReasoningResult> {
  // 1. 构建推理 prompt
  const recentTopics = extractRecentTopics(messages, 3);
  const reasoningPrompt = buildReasoningPrompt(prompt, memoryIndex, recentTopics);

  // 2. 解析 provider/model（三级回退）
  const primary = api.config?.agents?.defaults?.model?.primary ?? "";
  const [primaryProvider, primaryModel] = primary.split("/");
  const provider = config.routingProvider ?? primaryProvider;
  const model = config.routingModel ?? primaryModel;

  // 3. 调用轻量模型（复用 OpenClaw 的 runEmbeddedPiAgent）
  const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();
  const result = await runEmbeddedPiAgent({
    provider,                   // e.g. "alibaba"
    model,                      // e.g. "qwen3.5-plus"
    prompt: reasoningPrompt,
    config: api.config,         // 传入完整配置（含 apiKey、baseUrl）
    disableTools: true,         // 路由推理不需要工具调用
    timeoutMs: 5000,            // 5s 超时保护
    streamParams: {
      temperature: 0,           // 确定性输出
      maxTokens: 200,           // 路由决策不需要长输出
    },
  });

  // 4. 解析 JSON 响应
  try {
    const parsed = JSON.parse(result.output) as ReasoningResult;
    return parsed;
  } catch {
    // 模型返回格式异常 → 安全降级：不加载额外记忆
    return { needs_memory: false, files: [], reasoning: "parse_error" };
  }
}
```

### 3. 文件选择与加载

推理模型返回文件列表后，插件负责实际的文件读取和 token 预算控制。

```typescript
interface LoadPlan {
  files: string[];                // 最终要加载的文件路径列表
  totalEstimatedTokens: number;
  reasoning: string;              // 模型的推理理由
}

async function buildLoadPlan(
  reasoningResult: ReasoningResult,
  workspaceDir: string,
  config: PluginConfig,
): Promise<LoadPlan> {
  if (!reasoningResult.needs_memory || reasoningResult.files.length === 0) {
    return { files: [], totalEstimatedTokens: 0, reasoning: reasoningResult.reasoning };
  }

  const resolvedFiles: string[] = [];

  for (const filePath of reasoningResult.files) {
    const fullPath = path.join(workspaceDir, filePath);

    if (filePath.endsWith("/")) {
      // 目录：加载目录下所有 .md 文件
      const dirFiles = await resolveDirectory(fullPath);
      resolvedFiles.push(...dirFiles);
    } else if (await fileExists(fullPath)) {
      resolvedFiles.push(filePath);
    }
    // 模型幻觉出不存在的文件 → 静默跳过
  }

  // Token 预算裁剪
  const totalMaxTokens = config.totalMaxTokens ?? 8000;
  const truncatedFiles = truncateByTokenBudget(resolvedFiles, workspaceDir, totalMaxTokens);

  return {
    files: truncatedFiles,
    totalEstimatedTokens: estimateTokens(truncatedFiles, workspaceDir),
    reasoning: reasoningResult.reasoning,
  };
}
```
```

### 4. 上下文构建与注入

最终通过 `prependContext` 返回给 OpenClaw：

```typescript
function buildPrependContext(
  loadedFiles: Map<string, string>,   // path → content
  reasoning: string,
  config: PluginConfig,
): string {
  const sections: string[] = [];

  // 可选：附带推理日志（调试用，可关闭）
  if (config.enableReasoningLog) {
    sections.push(
      `<!-- memory-reasoning: ${reasoning} -->`
    );
  }

  // 按文件拼装
  for (const [path, content] of loadedFiles) {
    sections.push(
      `## Memory: ${path}\n\n${content}`
    );
  }

  return sections.join("\n\n---\n\n");
}
```

---

## Hook 注册代码

### 插件入口

```typescript
// src/index.ts
import type { OpenClawPluginDefinition, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { loadMemoryIndex } from "./reasoning/index-loader";
import { reasonMemoryRoute } from "./reasoning/memory-router";
import { buildLoadPlan } from "./loader/memory-reader";
import { readMemoryFiles } from "./loader/memory-reader";
import { buildPrependContext } from "./loader/context-builder";

const plugin: OpenClawPluginDefinition = {
  id: "memory-reasoning",
  name: "Memory Reasoning Router",
  version: "0.1.0",
  description: "Reasoning-based memory routing — load memory by LLM understanding, not keyword matching",

  async register(api: OpenClawPluginApi) {
    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        const { prompt, messages } = event;
        const workspaceDir = ctx.workspaceDir;

        // 0. 空消息或极短消息 → 跳过
        if (!prompt || prompt.trim().length < 3 || !workspaceDir) {
          return;
        }

        // 1. 加载 MEMORY.md 索引（带文件缓存）
        const memoryIndex = await loadMemoryIndex(workspaceDir);
        if (!memoryIndex) return;

        // 2. 调用轻量模型做推理路由（复用 OpenClaw 模型配置）
        const config = api.pluginConfig as PluginConfig;
        const reasoningResult = await reasonMemoryRoute(
          prompt, messages, memoryIndex, config, api
        );
        if (!reasoningResult.needs_memory) {
          return; // 模型判断不需要记忆 → 不注入
        }

        // 3. 构建加载计划（解析目录、校验文件存在、token 预算）
        const plan = await buildLoadPlan(reasoningResult, workspaceDir, config);
        if (plan.files.length === 0) return;

        // 4. 读取文件
        const loadedFiles = await readMemoryFiles(workspaceDir, plan.files);

        // 5. 构建注入上下文
        const context = buildPrependContext(loadedFiles, plan.reasoning, config);

        return {
          prependContext: context,
        };
      },
      { priority: 50 },
    );
  },
};

export default plugin;
```

---

## 关键技术细节

### Hook 的执行语义

| 特性 | 详情 |
|------|------|
| **执行时机** | session 消息加载完毕后，system prompt 提交前 |
| **可访问数据** | `event.prompt`（用户消息）、`event.messages`（对话历史）、`ctx.workspaceDir`（工作区路径） |
| **返回值** | `{ prependContext?: string, systemPrompt?: string }` |
| **prependContext 语义** | 拼接到用户 prompt 前面，多插件时累加（`\n\n` 分隔） |
| **systemPrompt 语义** | 完全替换系统提示词（**本方案不使用**，避免干扰） |
| **执行顺序** | 按 priority 降序，同 priority 按注册顺序 |
| **错误处理** | 异常自动捕获记录日志，不影响主流程 |

### 与现有机制的共存策略

| 现有机制 | 本插件的关系 | 处理方式 |
|---------|------------|---------|
| MEMORY.md Bootstrap 全量注入 | **共存但减少依赖** | 建议将 MEMORY.md 精简为纯索引（<2K），重内容由插件按需注入 |
| `memory_search` / `memory_get` 工具 | **互补** | 插件做"粗路由"，工具做"细查询"；Agent 仍可主动调用工具搜索 |
| `memory-manager` Skill | **兼容** | Skill 的 SOP 指令仍有效，插件提供的上下文会让 Agent 更精准地使用工具 |
| `session-memory` 内置钩子 | **无冲突** | session-memory 处理的是会话结束时的记忆归档，与本插件阶段不同 |

### 性能考量

| 环节 | 预估耗时 | 说明 |
|------|---------|------|
| 索引加载 | ~1ms | MEMORY.md 读取 + 文件系统缓存（带 mtime 校验） |
| 推理模型调用 | ~200-400ms | 轻量模型（haiku/flash），输入 ~2K，输出 ~100 tokens |
| 文件读取 | ~5-20ms | 2-5 个 .md 文件，并行读取 |
| **总计** | **~250-450ms** | 相当于多了一次小模型调用，换来精准记忆 |

**延迟 vs 精度的权衡**：相比关键词硬匹配（~0ms），模型推理多了 ~300ms 延迟。但这个延迟换来的是：
- 无需人工维护关键词列表
- 能理解隐含意图和指代表达
- 随记忆结构变化自动适应（只要索引文件更新）

### Token 预算控制

```
当前方案（全量注入）：
  MEMORY.md 全文 ≈ 3K-8K tokens（随记忆增长）
  + Agent 可能额外 memory_search ≈ 0-5K tokens
  总计：3K-13K tokens

本方案（推理路由）：
  推理模型调用 ≈ 2K input + 100 output tokens（独立计费，haiku 成本极低）
  + 精准记忆文件 ≈ 1K-5K tokens（注入主模型上下文）
  总计：1K-5K tokens（主模型侧）
  
主模型 token 节省：40%-70%
额外成本：每次对话多一次 haiku 调用（~$0.0001）
```

---

## 索引文件的维护

### 核心优势：无需额外维护

与关键词路由方案不同，本方案**直接复用 MEMORY.md**作为推理输入，用户不需要学习新格式或维护额外配置文件。

用户照常维护 MEMORY.md：
- 添加新的记忆文件 → 在索引中补一行描述
- 调整目录结构 → 更新索引对应部分
- 推理模型自动适应变化

### 索引质量对推理效果的影响

模型的路由决策质量取决于索引描述的信息量：

| 索引描述质量 | 示例 | 推理效果 |
|-------------|------|---------|
| 差 | `recsys-algorithm.md` （只有文件名） | 模型只能靠文件名猜测，可能漏选 |
| 中 | `recsys-algorithm.md # 推荐系统` | 基本能匹配 |
| 好 | `recsys-algorithm.md # 推荐系统、召回、排序、模型、特征工程、AB实验` | 精准匹配，包括隐含意图 |

**建议**：在 MEMORY.md 的目录结构中，为每个文件附上简短的关键词描述。这本身也是好的索引实践，不是额外负担。

---

## 安装与配置

### 作为 npm 插件安装

```bash
# 发布后
npm install -g openclaw-plugin-memory-reasoning

# 或本地开发
cd openclaw-memory-reasoning
npm link
```

### 在 openclaw.config.json 中启用

```json
{
  "plugins": {
    "memory-reasoning": {
      "enabled": true,
      "config": {
        "routingProvider": "alibaba",         // 可选，指定推理路由使用的 provider
        "routingModel": "qwen3.5-plus",       // 可选，指定推理路由使用的模型
        "enableReasoningLog": true,           // 调试日志
        "totalMaxTokens": 8000                // 注入主模型的 token 预算上限
      }
    }
  }
}
```

**配置说明**：

| 配置项 | 是否必须 | 默认值 | 说明 |
|--------|:---:|--------|------|
| `routingProvider` | 否 | 全局默认 provider | 推理路由调用的 LLM provider，不配置则回退到 `api.config.agents.defaults.model.primary` 的 provider |
| `routingModel` | 否 | 全局默认 model | 推理路由调用的模型 ID，不配置则回退到全局默认模型 |
| `enableReasoningLog` | 否 | `false` | 是否在 prependContext 中附带推理理由（调试用） |
| `totalMaxTokens` | 否 | `8000` | 注入主模型上下文的 token 总预算 |

**零配置快速启用**：如果不指定 `routingProvider` 和 `routingModel`，插件会自动复用当前 Agent 的默认模型。建议在生产环境中显式指定一个轻量模型（如 `qwen3.5-plus`、`claude-3-haiku`）以控制延迟和成本。

### Workspace 结构（无需额外文件）

```
~/.openclaw/workspace/
├── MEMORY.md               ← 既是 Agent 的索引，也是推理模型的输入
├── memory/
│   ├── insights/
│   ├── projects/
│   └── ...
```

不需要 `route-table.yaml` — MEMORY.md 就是路由表。

---

## 实现路线图

### Phase 1：MVP（模型推理路由）
- [ ] 插件骨架 + `before_prompt_build` 注册
- [ ] MEMORY.md 索引加载器（带文件缓存）
- [ ] 推理 Prompt 模板 + 轻量模型调用
- [ ] JSON 响应解析 + 安全降级
- [ ] 文件读取 + prependContext 构建
- [ ] 基本 token 预算控制

### Phase 2：增强（上下文感知）
- [ ] 对话历史摘要传入推理模型（理解指代）
- [ ] 推理结果缓存（相同话题的连续消息复用上一次结果）
- [ ] 目录通配符解析
- [ ] 索引文件热加载（mtime 变更检测）

### Phase 3：可观测性
- [ ] 推理日志输出（路由决策 + 理由）
- [ ] `llm_output` 钩子收集使用统计
- [ ] 路由效果报告（命中率、Agent 额外搜索率）

### Phase 4：自适应优化
- [ ] 推理模型可配置切换（haiku / flash / 本地模型）
- [ ] 索引质量检测（提示用户补充描述）
- [ ] 多 workspace 支持

---

## 开放问题

1. **~~推理模型的 API Key 来源？~~（已解决）** ✅ 复用 OpenClaw 的 `runEmbeddedPiAgent()` 内部调用机制，通过 `api.config` 自动获取已配置 provider 的 apiKey 和 baseUrl。插件可在 `pluginConfig` 中通过 `routingProvider`/`routingModel` 指定推理模型，不配置则回退到全局默认模型。参考实现：`llm-task` bundled extension。

2. **推理模型幻觉文件路径怎么办？** 模型可能返回索引中不存在的文件路径。当前设计是静默跳过（`fileExists` 校验），但应该记录日志以便发现索引描述不清晰的情况。

3. **与 `memory_search` 工具的分工？** 插件做"粗路由"（基于索引理解加载整个文件），`memory_search` 做"细查询"（在具体文件中找特定段落）。两者互补，但需要在 Skill SOP 中明确说明这个分工——Agent 已有精准记忆时应减少冗余搜索。

4. **连续对话的推理优化？** 如果用户连续 5 条消息都在聊推荐系统，每条都调一次推理模型是否浪费？可以考虑"话题延续检测"——如果推理结果与上一次相同且间隔 < 5 分钟，复用缓存。

5. **推理延迟是否可接受？** ~300ms 的额外延迟对交互式对话影响不大，但对高频自动化场景（如 Cron/Heartbeat）可能需要跳过推理。可以通过检测 `ctx.messageProvider` 或 session 类型来决定是否执行推理。
