# 动机：为什么需要 Reasoning-based Memory Routing

## 一句话总结

OpenClaw 当前的记忆加载是"全量灌入 + 祈祷 Agent 自己搜索"，而不是"先理解意图 → 按需精准加载"。
这导致了 token 浪费、记忆命中率低、Agent 回答不稳定的三重问题。

---

## 背景：OpenClaw 的记忆系统现状

### 记忆的组织结构（已优化）

经过 2026-02 的迭代，记忆已经有了清晰的分层：

```
workspace/
├── MEMORY.md              ← 索引文件（主题→文件映射表）
├── memory/
│   ├── YYYY-MM-DD.md      ← 每日日志
│   ├── insights/           ← 洞察库（4 个领域分片）
│   │   ├── README.md
│   │   ├── business-product.md
│   │   ├── recsys-algorithm.md
│   │   ├── management-org.md
│   │   └── creation-tools.md
│   ├── projects/           ← 项目追踪（每项目独立文件）
│   ├── facts/              ← 事实库（个人/职场/家庭/头像）
│   ├── decisions.md        ← 决策记录
│   ├── conversations.md    ← 讨论记录
│   └── todo.md             ← 待办事项
```

**索引文件 MEMORY.md 已经设计了完整的主题→文件映射表**：

| 用户在聊 | 应该加载的文件 |
|---------|-------------|
| 排序归因 / 算子归因 | `projects/<project-name>.md` |
| 个人/兴趣/偏好 | `facts/personal.md` |
| 洞察 / 方法论 | `insights/README.md` → 按领域加载 |
| 上次 / 继续讨论 | 最近 3 天日志 |

**问题不在记忆的"组织"，而在记忆的"加载"。**

### 记忆的加载机制（问题所在）

通过对 OpenClaw 源码的完整分析，发现记忆加载有两条路径：

#### 路径 1：Bootstrap 全量注入（系统层，每次 session 自动执行）

```
loadWorkspaceBootstrapFiles()
  → 读取 MEMORY.md 全文
  → 截断到 20,000 字符 / 文件
  → 注入 system prompt 的 "Project Context" 部分
```

**问题**：
- MEMORY.md 作为**索引文件**被当成普通文本灌入，系统不理解其结构
- 不会根据 MEMORY.md 里的映射表去加载对应的子文件
- 20K 字符截断 → 当记忆增长后，映射表可能被截掉

#### 路径 2：Agent Tool 调用（运行时，依赖 Agent 自觉性）

```
System Prompt 注入指令：
  "## Memory Recall
   Before answering anything about prior work, decisions, dates, people,
   preferences, or todos: run memory_search on MEMORY.md + memory/*.md;
   then use memory_get to pull only the needed lines."

Agent 工具：
  - memory_search(query) → SQLite embedding + FTS5 混合搜索
  - memory_get(path, from, lines) → 精确读取文件片段
```

**问题**：
- **完全依赖 Agent 的"自觉性"** — 是否搜索、搜什么，取决于 LLM 对 system prompt 指令的遵循程度
- 没有强制执行的 reasoning gate
- 搜索是**语义/关键词驱动**，不是**领域路由驱动** — Agent 不会先看映射表再决定加载哪个文件
- 实际观察：Agent 经常跳过 memory_search 直接回答，尤其是简单问题

---

## 核心矛盾

**已经设计好的记忆路由规则（MEMORY.md 里的映射表）没有被系统执行，只是作为"希望 Agent 能看懂"的文本存在。**

这就好比：
- 你设计了一套精确的图书馆索引系统
- 但图书管理员（Agent）每次只是把索引目录页塞给读者，然后说"你自己找吧"
- 有时候管理员会帮忙搜索，但搜的是全文关键词匹配，而不是按照索引分类去找

---

## 理想的记忆加载流程

```
用户消息到达
  │
  ▼
Step 1: 读取 MEMORY.md 索引（轻量，~2K tokens）
  │
  ▼
Step 2: 推理判断（Reasoning Gate）
  │  "这个问题涉及什么领域？需要加载哪些记忆？"
  │  - 参照 MEMORY.md 的主题→文件映射表
  │  - 判断是否需要加载记忆（有些问题完全不需要）
  │  - 输出：需要加载的文件列表 + 加载理由
  │
  ▼
Step 3: 精准加载
  │  只加载推理判断认为必要的文件
  │  例：用户聊"推荐系统" → 加载 insights/recsys-algorithm.md + projects/相关项目.md
  │  例：用户聊"今天天气" → 不加载任何记忆
  │
  ▼
Step 4: 带精确上下文回答
```

**关键区别**：
- 当前：MEMORY.md 全文灌入 → Agent 可能搜也可能不搜 → 搜的是关键词
- 理想：MEMORY.md 作为路由表解析 → 系统级推理决定加载什么 → 精准加载对应文件

---

## 预期收益

| 维度 | 当前 | 改善后 |
|------|------|--------|
| **Token 消耗** | MEMORY.md 全文 + 可能的全量搜索 ≈ 5K-20K tokens | 索引 + 精准加载 ≈ 1K-5K tokens |
| **记忆命中率** | 依赖 Agent 自觉性，不稳定 | 系统级路由，确定性高 |
| **响应延迟** | memory_search 需要 embedding 计算 | 规则路由几乎零延迟 |
| **可控性** | Agent 行为不可预测 | 路由逻辑可审计、可调试 |
| **扩展性** | 记忆增长后截断风险 | 只加载相关文件，不受总量限制 |
