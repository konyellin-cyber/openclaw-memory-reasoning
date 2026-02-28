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
  │  │ Step A: 读取路由表                         │
  │  │   加载 route-table.yaml（带缓存，~1ms）    │
  │  │                                           │
  │  │ Step B: 意图分类                           │
  │  │   用户消息："推荐系统的召回实验效果"         │
  │  │   ✅ 命中关键词 ["推荐", "召回"]            │
  │  │   → 路由 "推荐系统/算法"                    │
  │  │                                           │
  │  │ Step C: 构建加载计划                       │
  │  │   路由表指定加载：                          │
  │  │   - insights/recsys-algorithm.md           │
  │  │   - projects/ 目录下所有文件                │
  │  │   Token 预算：5000                         │
  │  │                                           │
  │  │ Step D: 读取文件（并行，~10ms）             │
  │  │   读取 insights/recsys-algorithm.md        │
  │  │   读取 projects/*.md                       │
  │  │                                           │
  │  │ Step E: 返回 prependContext                │
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
| ② 记忆路由 | ❌ 不存在 | ✅ 插件在 hook 中执行推理路由（<25ms） |
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
| **加载内容** | MEMORY.md 全文（完全浪费） | 无额外加载（路由未命中 → 跳过） |
| **Token 消耗** | ~8K（浪费） | ~0（节省） |
| **记忆命中** | N/A | N/A |

#### 场景 3：用户说"继续上次的讨论"

| | 修改前 | 修改后 |
|---|---|---|
| **加载内容** | MEMORY.md 全文，Agent 可能猜上次聊了什么 | 命中 "继续讨论" 路由 → 加载最近 3 天日志 |
| **Token 消耗** | ~8K + Agent 可能搜索 | ~4K（最近日志） |
| **记忆命中** | 不确定，Agent 需要先猜再搜 | 高，日志中包含完整对话摘要 |

#### 场景 4：用户问"我喜欢什么类型的音乐"

| | 修改前 | 修改后 |
|---|---|---|
| **加载内容** | MEMORY.md 全文，个人偏好可能被截断 | 命中 "个人信息" 路由 → 加载 `facts/personal.md` |
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
                    │  route-table.yaml │ (路由规则)
                    └────────┬─────────┘
                             │ 解析
                             ▼
┌──────────┐      ┌──────────────────────┐
│ 用户消息  │─────→│ memory-reasoning     │
└──────────┘      │ 插件 (hook)          │
                  │                      │
                  │ 1. 意图分类 (~0ms)    │
                  │ 2. 路由匹配          │
                  │ 3. 文件选择          │
                  └────────┬─────────────┘
                           │ 精准加载
                           ▼
                  ┌──────────────────────┐
                  │ insights/xxx.md      │ (~1K-5K tokens)
                  │ projects/xxx.md      │ (只加载命中的)
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
┌─────────────────────────────────────────────────┐
│ OpenClaw Core（不修改）                           │
│                                                   │
│  session 加载 → messages 准备好                    │
│       │                                           │
│       ▼                                           │
│  ┌─── before_prompt_build Hook ───┐              │
│  │                                 │              │
│  │  ┌───────────────────────────┐  │              │
│  │  │ memory-reasoning 插件     │  │              │
│  │  │                           │  │              │
│  │  │ 1. 解析用户意图           │  │              │
│  │  │ 2. 读取路由表             │  │              │
│  │  │ 3. 匹配记忆文件           │  │              │
│  │  │ 4. 读取文件内容           │  │              │
│  │  │ 5. 返回 prependContext    │  │              │
│  │  └───────────────────────────┘  │              │
│  │                                 │              │
│  └─────────────────────────────────┘              │
│       │                                           │
│       ▼                                           │
│  system prompt 组装（含注入的记忆上下文）           │
│       │                                           │
│       ▼                                           │
│  LLM 调用                                        │
└─────────────────────────────────────────────────┘
```

### 插件内部架构

```
memory-reasoning-plugin/
├── src/
│   ├── index.ts                  # 插件入口，注册 hook
│   ├── router/
│   │   ├── intent-classifier.ts  # 意图分类器
│   │   ├── route-table.ts        # 路由表解析器
│   │   └── file-selector.ts      # 文件选择策略
│   ├── loader/
│   │   ├── memory-reader.ts      # 记忆文件读取
│   │   └── context-builder.ts    # 上下文拼装 + 预算控制
│   ├── config/
│   │   └── types.ts              # 配置类型
│   └── utils/
│       └── logger.ts             # 调试日志
├── route-table.yaml              # 默认路由表（可被 workspace 覆盖）
├── package.json
└── tsconfig.json
```

---

## 核心模块设计

### 1. 路由表（Route Table）

将 MEMORY.md 中的 Markdown 映射表转为结构化配置，插件直接解析执行。

**格式设计（YAML）**：

```yaml
# route-table.yaml — 可放在 workspace/ 下由用户自定义

version: 1

# 默认行为：不匹配任何路由时加载什么
defaults:
  files: []                    # 不加载额外记忆
  max_tokens: 2000             # 默认 token 预算

# 路由规则：按顺序匹配，首个命中的生效（支持多个命中）
routes:
  - name: "推荐系统/算法"
    match:
      keywords: ["推荐", "召回", "排序", "模型", "CTR", "CVR", "embedding", "特征"]
      patterns: ["算[法子]", "实验.*效果", "AB.*test"]
    load:
      - insights/recsys-algorithm.md
      - projects/                          # 目录 → 加载目录下所有文件
    max_tokens: 5000

  - name: "商业/产品"
    match:
      keywords: ["产品", "商业", "ROI", "变现", "用户增长", "DAU"]
    load:
      - insights/business-product.md
    max_tokens: 3000

  - name: "组织管理"
    match:
      keywords: ["团队", "管理", "协作", "OKR", "周报", "汇报"]
    load:
      - insights/management-org.md
    max_tokens: 3000

  - name: "创作/AI工具"
    match:
      keywords: ["创作", "AI", "工具", "分身", "头像", "生成"]
    load:
      - insights/creation-tools.md
    max_tokens: 3000

  - name: "个人信息"
    match:
      keywords: ["我的", "个人", "兴趣", "偏好", "喜欢"]
    load:
      - facts/personal.md
    max_tokens: 2000

  - name: "工作信息"
    match:
      keywords: ["工作", "职位", "部门", "公司", "同事"]
    load:
      - facts/work.md
    max_tokens: 2000

  - name: "继续讨论/上次"
    match:
      keywords: ["上次", "继续", "刚才", "之前聊的"]
      patterns: ["昨天.*说"]
    load:
      - "$recent_logs:3"                   # 特殊语法：最近 3 天日志
    max_tokens: 4000

  - name: "待办/决策"
    match:
      keywords: ["待办", "TODO", "todo", "决策", "决定"]
    load:
      - todo.md
      - decisions.md
    max_tokens: 2000

# 全局配置
global:
  total_max_tokens: 8000                   # 所有路由加起来的上限
  memory_base_path: "memory/"              # 相对 workspace 的记忆目录
  always_load: []                          # 每次都加载的文件（留空）
  enable_reasoning_log: true               # 是否在 prependContext 中附带路由推理日志
```

**设计要点**：
- **关键词匹配**（`keywords`）：简单字符串包含，零延迟
- **正则匹配**（`patterns`）：支持更灵活的模式
- **多路由叠加**：一条消息可以命中多个路由，文件去重后合并加载
- **Token 预算**：每个路由有独立 `max_tokens`，全局有 `total_max_tokens` 上限
- **特殊语法**：`$recent_logs:N` 自动解析为最近 N 天的日志文件

### 2. 意图分类器（Intent Classifier）

分两级策略，兼顾速度和准确度：

```
用户消息
  │
  ▼
Level 1: 规则匹配（~0ms）
  │ - 关键词匹配
  │ - 正则匹配
  │ - 对话历史分析（最近 3 轮的话题延续）
  │
  ├─ 匹配到 → 直接返回路由结果
  │
  └─ 未匹配 → Level 2
        │
        ▼
      Level 2: 轻量 LLM 推理（可选，~200ms）
        │ - 用小模型（如 haiku）做一次分类
        │ - 输入：用户消息 + 路由表名称列表
        │ - 输出：匹配的路由名称
        │
        ├─ 匹配到 → 返回路由结果
        └─ 未匹配 → 不加载额外记忆
```

**Level 1 实现细节**：

```typescript
interface IntentMatch {
  routeName: string;
  confidence: "high" | "medium";
  matchedBy: "keyword" | "pattern" | "history_continuation";
}

function classifyIntent(
  prompt: string,
  messages: unknown[],
  routes: RouteConfig[],
): IntentMatch[] {
  const matches: IntentMatch[] = [];

  for (const route of routes) {
    // 1. 关键词匹配
    if (route.match.keywords?.some(kw => prompt.includes(kw))) {
      matches.push({ routeName: route.name, confidence: "high", matchedBy: "keyword" });
      continue;
    }

    // 2. 正则匹配
    if (route.match.patterns?.some(p => new RegExp(p, "i").test(prompt))) {
      matches.push({ routeName: route.name, confidence: "high", matchedBy: "pattern" });
      continue;
    }

    // 3. 对话延续检测：检查最近 3 轮 assistant 消息是否提到过该路由的关键词
    if (isTopicContinuation(messages, route)) {
      matches.push({ routeName: route.name, confidence: "medium", matchedBy: "history_continuation" });
    }
  }

  return matches;
}
```

**Level 2（可选）**：

- 默认关闭，通过配置 `enable_llm_fallback: true` 开启
- 使用独立的小模型调用，不影响主对话的模型选择
- Prompt 模板：

```
Given the user message and a list of memory categories, 
which categories are relevant? Reply with category names only.

User message: "{prompt}"

Categories:
- 推荐系统/算法
- 商业/产品
- 组织管理
- 创作/AI工具
- 个人信息
- 工作信息
- 待办/决策
```

### 3. 文件选择与加载

```typescript
interface LoadPlan {
  files: string[];           // 最终要加载的文件路径列表
  totalEstimatedTokens: number;
  reasoning: string;         // 路由推理过程说明
}

async function buildLoadPlan(
  matches: IntentMatch[],
  routeTable: RouteTable,
  workspaceDir: string,
): Promise<LoadPlan> {
  const files = new Set<string>();
  let tokenBudget = routeTable.global.total_max_tokens;
  const reasoning: string[] = [];

  // 1. always_load 文件
  for (const f of routeTable.global.always_load) {
    files.add(f);
  }

  // 2. 按匹配路由加载
  for (const match of matches) {
    const route = routeTable.routes.find(r => r.name === match.routeName);
    if (!route) continue;

    reasoning.push(`[${match.matchedBy}] "${match.routeName}" → ${route.load.join(", ")}`);

    for (const target of route.load) {
      if (target.startsWith("$recent_logs:")) {
        // 特殊语法：解析最近 N 天日志
        const days = parseInt(target.split(":")[1]);
        const logFiles = await resolveRecentLogs(workspaceDir, days);
        logFiles.forEach(f => files.add(f));
      } else if (target.endsWith("/")) {
        // 目录：加载目录下所有 .md 文件
        const dirFiles = await resolveDirectory(workspaceDir, target);
        dirFiles.forEach(f => files.add(f));
      } else {
        files.add(target);
      }
    }
  }

  // 3. Token 预算裁剪（如果超了，按优先级截断）
  // ...

  return {
    files: Array.from(files),
    totalEstimatedTokens: estimateTokens(files),
    reasoning: reasoning.join("\n"),
  };
}
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
  if (config.enable_reasoning_log) {
    sections.push(
      `<!-- memory-reasoning route log:\n${reasoning}\n-->`
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
import { loadRouteTable } from "./router/route-table";
import { classifyIntent } from "./router/intent-classifier";
import { buildLoadPlan } from "./router/file-selector";
import { readMemoryFiles } from "./loader/memory-reader";
import { buildPrependContext } from "./loader/context-builder";

const plugin: OpenClawPluginDefinition = {
  id: "memory-reasoning",
  name: "Memory Reasoning Router",
  version: "0.1.0",
  description: "Reasoning-based memory routing — load memory by analyzing intent, not brute force",

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

        // 1. 加载路由表（workspace 下的 route-table.yaml，带缓存）
        const routeTable = await loadRouteTable(workspaceDir);
        if (!routeTable) return;

        // 2. 意图分类
        const matches = classifyIntent(prompt, messages, routeTable.routes);
        if (matches.length === 0) {
          return; // 不匹配任何路由 → 不注入额外记忆
        }

        // 3. 构建加载计划
        const plan = await buildLoadPlan(matches, routeTable, workspaceDir);
        if (plan.files.length === 0) return;

        // 4. 读取文件
        const memoryBasePath = `${workspaceDir}/${routeTable.global.memory_base_path}`;
        const loadedFiles = await readMemoryFiles(memoryBasePath, plan.files);

        // 5. 构建注入上下文
        const context = buildPrependContext(loadedFiles, plan.reasoning, routeTable.global);

        return {
          prependContext: context,
        };
      },
      { priority: 50 },  // 较高优先级，确保记忆在其他插件上下文之前
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
| 路由表加载 | ~1ms | YAML 解析 + 文件系统缓存（带 mtime 校验） |
| Level 1 意图分类 | ~0ms | 纯字符串/正则操作 |
| Level 2 LLM 推理 | ~200ms | 可选，默认关闭 |
| 文件读取 | ~5-20ms | 2-5 个 .md 文件，并行读取 |
| **总计** | **<25ms**（无 LLM） | 对用户感知延迟几乎无影响 |

### Token 预算控制

```
当前方案（全量注入）：
  MEMORY.md 全文 ≈ 3K-8K tokens（随记忆增长）
  + Agent 可能额外 memory_search ≈ 0-5K tokens
  总计：3K-13K tokens

本方案（推理路由）：
  路由推理日志 ≈ 50-100 tokens
  + 精准记忆文件 ≈ 1K-5K tokens（受 total_max_tokens 约束）
  总计：1K-5K tokens
  
预估节省：40%-70% 的记忆相关 token
```

---

## 路由表的维护方式

### 方案 A：手动维护（推荐初期）

用户直接编辑 `~/.openclaw/workspace/route-table.yaml`，根据自己的记忆结构调整路由规则。

**优点**：完全可控，规则透明
**适合**：记忆结构稳定、类别清晰的场景

### 方案 B：自动生成（后续迭代）

提供一个 CLI 工具或 Skill，扫描 `memory/` 目录结构 + 各文件的 README/标题，自动生成路由表草稿。

```
openclaw-memory-reasoning generate-routes
  → 扫描 memory/ 目录
  → 读取每个子目录的 README.md 提取关键词
  → 生成 route-table.yaml 草稿
  → 用户 review 后生效
```

### 方案 C：运行时自学习（远期）

通过 `llm_output` 观察型钩子，收集"哪些路由命中了 + Agent 是否额外搜索了记忆"的统计数据，用于优化路由表：
- 如果某路由经常命中但 Agent 还是要额外 `memory_search` → 路由表漏了文件
- 如果某路由加载的文件 Agent 从未引用 → 路由表太宽泛

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
      "routeTablePath": "route-table.yaml",
      "enableLlmFallback": false,
      "enableReasoningLog": true,
      "totalMaxTokens": 8000
    }
  }
}
```

### 在 workspace 中放置路由表

```
~/.openclaw/workspace/
├── route-table.yaml        ← 新增：路由表配置
├── MEMORY.md               ← 精简为纯索引（可选）
├── memory/
│   ├── insights/
│   ├── projects/
│   └── ...
```

---

## 实现路线图

### Phase 1：MVP（核心路由）
- [ ] 插件骨架 + `before_prompt_build` 注册
- [ ] YAML 路由表解析器
- [ ] Level 1 关键词/正则意图分类
- [ ] 文件读取 + prependContext 构建
- [ ] 基本 token 预算控制

### Phase 2：增强（对话感知）
- [ ] 对话历史话题延续检测
- [ ] `$recent_logs:N` 特殊语法支持
- [ ] 目录通配符解析
- [ ] 路由表热加载（文件变更自动重载）

### Phase 3：可选 LLM 推理
- [ ] Level 2 小模型意图分类
- [ ] 配置化的 fallback 策略

### Phase 4：自适应优化
- [ ] `llm_output` 钩子收集使用统计
- [ ] 路由表自动生成 CLI
- [ ] 路由效果报告

---

## 开放问题

1. **MEMORY.md 是否需要改造？** 当前 MEMORY.md 既是索引又是给 Agent 看的文本。引入插件后，路由逻辑由 `route-table.yaml` 承担，MEMORY.md 可以精简为纯人类可读的目录概览，不再需要"主题→文件映射表"。但这意味着两套配置要保持同步。

2. **与 `memory_search` 工具的分工？** 插件做"粗路由"（基于话题分类加载整个文件），`memory_search` 做"细查询"（在具体文件中找特定信息）。两者互补，但需要在 Skill SOP 中明确说明这个分工。

3. **多 workspace 支持？** 如果用户有多个 workspace（工作/个人），路由表是否需要感知当前 workspace 的记忆结构差异？初期建议每个 workspace 独立维护自己的 `route-table.yaml`。

4. **路由表的版本管理？** 路由表随记忆结构演进需要更新。是否纳入 Git 管理？建议是——因为路由表本身是记忆系统的"元配置"。
