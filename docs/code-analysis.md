# OpenClaw 记忆加载机制：源码分析

## 分析版本

- 仓库：`openclaw-ai-agent`（开源仓库）
- 分析时间：2026-02-28

---

## 架构总览

Memory 系统由以下核心层次组成：

| 层次 | 关键文件 | 职责 |
|------|---------|------|
| **配置层** | `src/config/types.memory.ts` | 定义 Memory 后端类型（builtin/qmd） |
| **配置解析层** | `src/agents/memory-search.ts` | 解析并合并 memorySearch 配置 |
| **后端选择层** | `src/memory/backend-config.ts` | 根据 `memory.backend` 选择 builtin 或 qmd |
| **管理器工厂** | `src/memory/search-manager.ts` | 获取/创建 MemorySearchManager 实例（带 fallback） |
| **内建索引管理器** | `src/memory/manager.ts` | SQLite + embedding 索引、同步、搜索 |
| **Agent 工具层** | `src/agents/tools/memory-tool.ts` | 提供 `memory_search` 和 `memory_get` 两个工具 |
| **工作区引导层** | `src/agents/workspace.ts` | 加载 bootstrap 文件（含 MEMORY.md）到 system prompt |
| **系统提示层** | `src/agents/system-prompt.ts` | 将 Memory Recall 指令嵌入系统提示 |
| **Memory Flush 层** | `src/auto-reply/reply/memory-flush.ts` | 会话压缩前自动写入持久记忆 |

---

## 两条加载路径详解

### 路径 1：Bootstrap 全量注入

**入口**：`src/agents/workspace.ts` → `loadWorkspaceBootstrapFiles()`

```
session 初始化
  → resolveMemoryBootstrapEntries()  // 第 404-439 行
      → 读取 MEMORY.md 和 memory.md
  → buildBootstrapContextFiles()     // bootstrap.ts 第 187-246 行
      → 截断处理（单文件 ≤ 20,000 字符，总计 ≤ 150,000 字符）
      → 截断策略：头部 70% + 尾部 20%，中间标注 [truncated]
  → 注入 system prompt 的 "# Project Context" 部分
```

**关键限制**：
- 每个文件最多 `DEFAULT_BOOTSTRAP_MAX_CHARS = 20,000`
- 所有文件总计最多 `DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 150,000`
- **无选择性** — 不管用户聊什么，MEMORY.md 全文都会注入

### 路径 2：运行时 Tool 调用

**工具定义**：`src/agents/tools/memory-tool.ts`

- `memory_search(query)` — 语义搜索 `MEMORY.md` + `memory/*.md`
  - 混合搜索：vector (权重 0.7) + BM25 text (权重 0.3)
  - 过滤 minScore ≥ 0.35，返回 maxResults ≤ 6
  - 可选 MMR 去重、时间衰减
- `memory_get(path, from, lines)` — 精确读取文件片段

**触发方式**：`src/agents/system-prompt.ts` 第 44-70 行

```
## Memory Recall
Before answering anything about prior work, decisions, dates, people,
preferences, or todos: run memory_search on MEMORY.md + memory/*.md;
then use memory_get to pull only the needed lines.
```

**本质**：通过 prompt 指令"建议" Agent 在需要时搜索，但没有强制执行机制。

---

## 索引存储与搜索细节

### SQLite 表结构（`src/memory/memory-schema.ts`）

| 表 | 用途 |
|----|------|
| `files` | 已索引文件（path, hash, mtime, size, source） |
| `chunks` | 分块文本 + embedding 向量 |
| `chunks_vec` | sqlite-vec 向量索引（如果可用） |
| `chunks_fts` | FTS5 全文索引（如果可用） |
| `embedding_cache` | embedding 缓存 |

### 分块策略（`src/memory/internal.ts` 第 184-265 行）

- 默认 400 tokens/chunk，80 tokens 重叠
- 按行分割，markdown 感知
- 每个 chunk 独立计算 hash 和 embedding

### 同步策略（`src/memory/manager.ts`）

- `onSessionStart: true`（默认）— session 开始时同步
- `onSearch: true`（默认）— 每次搜索时检查 dirty 标志
- `watch: true`（默认）— chokidar 监控文件变化
- 增量同步：基于文件 hash 判断是否需要重新索引

### FTS-Only 降级（`src/memory/query-expansion.ts`）

当没有 embedding provider 时，自动降级为纯 FTS 模式：
- 使用关键词提取（支持中/英/日/韩等多语言停用词过滤）替代语义搜索

---

## 其他记忆写入机制

### Memory Flush（`src/auto-reply/reply/memory-flush.ts`）

- 当 session token 接近上下文窗口限制时自动触发
- 在 auto-compaction 之前让 Agent 将重要记忆写入 `memory/YYYY-MM-DD.md`
- 这是自动**写入**机制，不是读取机制

### Session Memory Hook（`src/hooks/bundled/session-memory/handler.ts`）

- 当用户执行 `/new` 或 `/reset` 命令时触发
- 自动将最近 15 条消息保存到 `memory/YYYY-MM-DD-{slug}.md`
- 使用 LLM 生成描述性 slug

---

## 关键发现

### ❌ 没有 Reasoning Gate

整个流程中**不存在**一个"先分析用户问题是否需要 memory，再决定加载什么"的预处理步骤。
MEMORY.md 里精心设计的「主题→文件映射表」只是被当作普通文本注入，系统层面并不解析它。

### ❌ 搜索是语义驱动，不是领域驱动

`memory_search` 做的是 embedding cosine similarity + BM25，不是"先判断领域 → 再加载对应分片"。
这意味着搜索结果是关键词相关性排序的碎片，而不是按用户意图精确加载的完整文件。

### ✅ 已有的好设计

- MEMORY.md 的主题映射表设计本身很好，是 reasoning routing 的天然基础
- memory_get 工具可以精确读取文件片段，是精准加载的执行层
- 增量索引和文件监控机制成熟可靠

### 🔍 改善切入点

1. **在 Bootstrap 和 Agent 运行之间插入一个 Reasoning Gate** — 解析 MEMORY.md 的映射表，根据用户消息决定预加载哪些文件
2. **或者在 Skill/Prompt 层面实现** — 强制 Agent 在回答前先执行一个结构化的记忆路由流程
3. 两条路径可以并行：Skill 层面可以快速迭代验证，代码层面提供系统级可靠性
