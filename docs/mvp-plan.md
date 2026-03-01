# 语义路标系统 — MVP 实现计划

> 从设计到代码的分阶段实现路径。  
> 设计方案见 [technical-design.md](./technical-design.md)，项目背景见 [proposal.md](./proposal.md)。  
> 文档索引见 [INDEX.md](./INDEX.md)

**状态**: Phase 1 待开始  
**日期**: 2026-02-28  

---

## 当前位置

```
已完成                                    待实现
─────────                                ──────────
✅ RSS 拉取 + 存储 + search_feed         ⏳ 摘要卡生成
✅ Agent 自主调用 tool 推荐               ⏳ 语义网（节点 + 边）
✅ 端到端闭环验证                         ⏳ LLM 导航游走
✅ 设计方案全部收敛                        ⏳ 自生长 + 重整
```

---

## 总体节奏

```
Phase 1: 摘要卡 + 单节点（~1 周）
  → 验证：LLM 生成摘要卡的质量、入库时归类的可行性

Phase 2: 多节点语义网 + LLM 导航（~1-2 周）
  → 验证：路标导航 vs 全量灌入，推荐精准度和 token 效率的对比

Phase 3: 自生长 + 重整（~1-2 周）
  → 验证：LLM 能否自主做节点分裂/合并/建边
```

---

## Phase 1：摘要卡 + 单节点归类

**目标**：论文入库时 LLM 自动生成摘要卡，归到语义网节点。先只有一个根节点（冷启动状态）。

### 1.0 数据积累（前置）

Phase 2 的导航 vs 全量 A/B 对比需要足够的数据量（~500+ 篇）和多领域覆盖（测跨领域边）。在 Phase 1 开始前先把数据攒够。

**两条腿走路**：

| 策略 | 做法 | 目标量 | 价值 |
|------|------|--------|------|
| **拉历史** | arXiv OAI-PMH API 批量拉 cs.IR 过去 30 天 | ~300-600 篇 | 快速堆量，验证分裂 |
| **加源** | 新增 arXiv cs.AI / cs.LG | ~1500 篇/30天 | 多领域，验证跨领域边 |

**优先级**：先拉历史（零适配成本），再加源。

**实现**：
- `src/feeds/backfill.ts` — 历史数据批量拉取（调用 arXiv OAI-PMH API，按日期范围）
- 复用现有 `parser.ts` + `storage.ts`，输出格式和日常拉取一致
- 加源：在 `openclaw.plugin.json` 的 `configSchema.feeds` 中增加 RSS URL 即可，管道已通用

**验证点**：
- 历史数据拉取完整（日期范围内无遗漏）
- 多源数据格式统一（不同 arXiv 分类的数据能共用同一套摘要卡/归类流程）
- 积累到 500+ 篇后再进入 1.1

---

### 1.1 摘要卡生成器

```
输入：论文原始数据（title + abstract）
输出：摘要卡 JSON

{
  "id": "2602.12345",
  "主题标签": ["multi-objective", "reward-shaping"],
  "方法类型": "优化方法",
  "解决的问题": "多目标配平",
  "质量信号": "...",
  "一句话": "不需要手动调 loss 权重的多目标配平方法"
}
```

**实现**：
- `src/summarizer/generator.ts`
- 调用 `runEmbeddedPiAgent()`（dynamic import 内部模块，参考 `llm-task` extension）让 LLM 生成摘要卡
- prompt 模板：给定论文 title+abstract → 输出结构化 JSON
- 在 feed service 拉取后自动批量生成

**验证点**：
- 摘要卡质量（人工抽检 10 篇：标签准不准、一句话概括到不到位）
- 信息压缩比（原始 ~200 tokens → 摘要卡 ~30 tokens）
- 生成延迟和成本（31 篇论文批量生成耗时）

### 1.2 语义网数据结构

- `src/knowledge/graph.ts` — 语义网的读写操作
- 数据格式（JSON 文件）：

```
~/.openclaw/personal-rec/knowledge/
├── graph.json          # 语义网结构（节点 + 边）
├── cards/              # 摘要卡存储
│   ├── 2602.12345.json
│   └── ...
└── signals.json        # 入库时的微感知信号（归类置信度等）
```

`graph.json` 结构：

```json
{
  "nodes": [
    {
      "id": "root",
      "description": "所有论文的根节点",
      "parent": null,
      "papers": ["2602.12345", "2602.12346"],
      "edges": []
    }
  ]
}
```

**验证点**：
- 数据持久化正确
- 读写性能（几百个节点/几千篇论文的 JSON 操作）

### 1.3 入库归类（冷启动版）

- `src/summarizer/classifier.ts`
- 论文入库时：生成摘要卡 → 归到现有节点（冷启动期只有根节点）
- 同时输出微感知信号：

```json
{
  "归类到": "root",
  "归类置信度": "高",
  "感知信号": null
}
```

- 信号存到 `signals.json`，不触发任何操作

**验证点**：
- 入库流程跑通（RSS 拉取 → 生成摘要卡 → 归类 → 存储）
- 微感知信号输出格式稳定

### Phase 1 交付物

- 每篇论文自动生成摘要卡 + 归类到节点
- 数据全部持久化到 `~/.openclaw/personal-rec/knowledge/`
- `search_feed` 工具升级：返回摘要卡而不是原始 abstract（token 更省）

---

## Phase 2：多节点语义网 + LLM 导航

**目标**：手动触发第一次"重整"，让 LLM 把单节点分裂成多节点。然后实现导航式检索，对比全量灌入。

### 2.1 重整器（手动触发版）

- `src/knowledge/reorganizer.ts`
- 手动触发（CLI 命令或 tool），不做自动触发（Phase 3 才做）
- 输入：当前 `graph.json` + 该节点下所有摘要卡
- LLM 推理：要不要拆？拆成几个？节点怎么命名？边怎么描述？
- 输出：结构变更 diff（JSON）

```json
{
  "split": {
    "sourceNode": "root",
    "newNodes": [
      { "id": "multi-obj", "description": "多目标优化：...", "papers": ["..."] },
      { "id": "cold-start", "description": "冷启动：...", "papers": ["..."] }
    ],
    "newEdges": [
      { "from": "multi-obj", "to": "cold-start", "relation": "方法可用于冷启动场景" }
    ],
    "remainingPapers": ["..."]
  }
}
```

- 应用 diff → 更新 `graph.json`
- 注册 `registerTool: reorganize_knowledge`（让 agent 也能触发）

**验证点**：
- LLM 能否输出稳定的结构化 diff（JSON schema 约束）
- 分裂结果的质量（节点命名合理、论文归属准确、边描述有意义）
- 积累 ~50 篇后手动触发一次，看效果

### 2.2 导航式检索

- `src/tools/navigate-knowledge.ts`
- 替代/升级 `search_feed`，用路标导航替代全量返回
- 流程：
  1. 读 `graph.json` 的顶层节点描述（Layer 0）
  2. LLM 选择进入哪个节点
  3. 读该节点的子节点/邻居 + 边描述
  4. LLM 选择下一步
  5. 到达叶子节点 → 读该节点下的摘要卡 → 返回

- 关键：每一步都是 LLM 推理（`runEmbeddedPiAgent`，dynamic import）

**验证点（核心 A/B 对比）**：
- 全量灌入 vs 导航式检索，对比：
  - a) token 消耗（导航应该远小于全量）
  - b) 推荐精准度（导航是否能找到全量也能找到的论文？有没有漏？）
  - c) 推荐理由质量（导航路径本身就是理由，应该更好解释）
  - d) 延迟

### 2.3 入库归类（多节点版）

- 升级 `classifier.ts`：现在有多个节点了，LLM 要选择归到哪个
- 读所有节点描述 → LLM 选择最匹配的节点 → 归类 + 输出置信度
- 论文可以多归属（同时归到 2 个节点）

**验证点**：
- 归类准确率（人工抽检）
- 低置信度信号是否合理（LLM 说"不确定"的时候，是真的不好归吗？）

### Phase 2 交付物

- 语义网有多个节点 + 边
- 导航式检索工具可用
- A/B 对比数据（全量 vs 导航）

---

## Phase 3：自生长 + 自动重整

**目标**：实现两阶段触发的自动重整，语义网能自生长。

### 3.1 自动触发机制

- `src/knowledge/trigger.ts`
- 每次入库后检查触发条件：
  - a) 某节点论文数 > 20
  - b) 某节点近期低置信度归类 > 30%
  - c) 定时兜底（配置项，默认每月）
- 触发后调用 `reorganizer.ts` 执行重整
- 重整结果自动应用

### 3.2 完整的自生长闭环

```
RSS 拉取 → 生成摘要卡 → 归类到节点（+ 微感知信号）
  → 触发条件满足 → 自动重整（分裂/合并/建边）
  → 导航式检索使用新结构 → 推荐
```

### 3.3 主动 briefing

- 利用 OpenClaw 的 heartbeat/cron 机制
- 每日自动：读 Inner Memory + 导航 Outer Knowledge → 生成推荐 briefing
- 推送到飞书/对话

**验证点**：
- 自动重整是否在正确的时机触发
- 重整后导航质量是否提升（对比重整前后的推荐效果）
- 经过 1 个月的积累，语义网结构是否合理

---

## 文件结构演进

```
src/
├── index.ts                      # 插件入口（已有）
├── feeds/
│   ├── parser.ts                 # RSS 解析（已有）
│   ├── service.ts                # 定时拉取（已有，Phase 1 改造：拉取后触发摘要卡生成）
│   └── storage.ts                # Feed 数据存储（已有）
├── summarizer/                   # [Phase 1 新增]
│   ├── generator.ts              # 摘要卡生成（LLM 推理）
│   └── classifier.ts             # 入库归类 + 微感知信号
├── knowledge/                    # [Phase 1/2 新增]
│   ├── graph.ts                  # 语义网数据结构（读写操作）
│   ├── reorganizer.ts            # 重整器（Phase 2 手动，Phase 3 自动）
│   └── trigger.ts                # 自动触发机制 [Phase 3 新增]
└── tools/
    ├── search-feed.ts            # 全量检索（已有，Phase 2 后降级为 fallback）
    └── navigate-knowledge.ts     # 导航式检索 [Phase 2 新增]
```

---

## 时间线和风险

| 阶段 | 耗时估计 | 核心验证 | 风险 |
|------|---------|---------|------|
| **Phase 1** | ~1 周 | 数据积累（500+ 篇多源）、摘要卡质量、LLM 结构化输出稳定性 | 低（单步 LLM 调用，成熟能力） |
| **Phase 2** | ~1-2 周 | **导航 vs 全量的 A/B 对比**（需要多领域数据支撑） | 中（多步 LLM 串行推理、重整输出稳定性） |
| **Phase 3** | ~1-2 周 | 自生长闭环、1 个月后结构合理性 | 高（触发时机、重整质量的长期稳定性） |

**关键里程碑**：Phase 2 的 A/B 对比是整个方案的核心验证点——如果导航式检索的效果不比全量好（或者差很多），需要重新审视方案。

---

## 已确认决策

1. **Phase 1 的摘要卡生成用什么模型**：`runEmbeddedPiAgent` 默认模型。先跑通再说，不过早优化成本。
2. **Phase 2 的 A/B 对比怎么做**：先自己体感对比（推荐准不准一看就知道），逐步迭代优化。不预设评分机制。

---

## 技术验证记录

### #1: `runEmbeddedPiAgent` 在 Plugin 里可用 ✅（2026-03-01 验证）

**初始疑问**：`runEmbeddedPiAgent` 不在 `OpenClawPluginApi` 类型定义上（`src/plugins/types.ts:245-284`），Plugin API 没有显式暴露 LLM 调用方法。

**验证结论**：虽然不在 Plugin API 接口上，但 **可以通过 dynamic import 直接加载 OpenClaw 内部模块**。官方 bundled extension `llm-task` 就是这么做的。

**参考实现**（`extensions/llm-task/src/llm-task-tool.ts:14-33`）：

```typescript
async function loadRunEmbeddedPiAgent() {
  // 直接 dynamic import OpenClaw 内部模块
  const mod = await import("../../../src/agents/pi-embedded-runner.js");
  return mod.runEmbeddedPiAgent;
}
```

**调用方式**（同文件 :187-203）：

```typescript
const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();
const result = await runEmbeddedPiAgent({
  sessionId,
  sessionFile,           // 临时文件
  workspaceDir: api.config?.agents?.defaults?.workspace ?? process.cwd(),
  config: api.config,    // 从 Plugin API 拿到的 config（含 provider 认证）
  prompt: fullPrompt,
  timeoutMs,
  provider,              // 从 api.config 或参数解析
  model,
  authProfileId,
  disableTools: true,    // 纯推理，不需要工具
});
```

**关键点**：
- `api.config` 提供 provider 认证信息（API key、auth profile 等），**零额外配置**
- `llm-task` 是 bundled extension（在 OpenClaw 仓库内），用相对路径 import。我们是外部 Plugin，路径不同

**外部 Plugin 可用性验证 ✅（2026-03-01 实测）**：

外部 Plugin **可以** resolve `runEmbeddedPiAgent`，但不是通过 `openclaw/plugin-sdk`（`plugin-sdk/index.js` 的 212 个导出中不含此函数——类型声明有但 JS 被 tree-shake 了），而是通过 **`extensionAPI.js`**：

```typescript
// src/llm/loader.ts — 实际可用的加载方式
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
const openclawEntry = require_.resolve("openclaw"); // → .../openclaw/dist/index.js
const extensionApiPath = path.join(path.dirname(openclawEntry), "extensionAPI.js");
const { runEmbeddedPiAgent } = await import(extensionApiPath);
```

`extensionAPI.js` 是 OpenClaw 专门给 extension 用的 API 模块（`dist/extensionAPI.js`），正式导出 `runEmbeddedPiAgent` + 多个 agent 辅助函数。

Gateway 日志确认：
```
[personal-rec] ✅ runEmbeddedPiAgent loaded (typeof=function)
```

**对 Phase 1 的影响**：无阻塞。摘要卡生成器可以用 `runEmbeddedPiAgent` 实现。实现已在 `src/llm/loader.ts`（3 级 fallback 策略）。

---

_最后更新: 2026-03-01_
