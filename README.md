# openclaw-memory-reasoning

> 用 100% 的你去匹配整个世界

**Inner-Outer Memory Reasoning Recommender** (内外长记忆推理推荐系统) — 一个运行在 [OpenClaw](https://github.com/nicepkg/openclaw) 上的个人信息推荐插件。

你的 AI 分身不只记得你说过什么（**Inner Memory**），还能看到外面发生了什么（**Outer Knowledge**），然后在对话中主动把对你有价值的信息推荐给你。

```
推荐 = f(你是谁, 你在想什么, 外面发生了什么)
     = f(Inner Memory × Outer Knowledge)
```

---

## 核心理念

传统推荐系统是 **"用 1% 的你去匹配 100% 的内容"**。

这个系统是 **"用 100% 的你去匹配整个世界"**。

| 维度 | 传统推荐 | 本项目 |
|------|---------|--------|
| 用户画像 | 行为特征 + 标签 | **完整个人记忆 + 价值观** |
| 物品池 | 平台内容库 | arXiv 论文 + RSS 公开信息源 |
| 排序信号 | CTR / CVR 预估 | **"对你的价值"推理** |
| 检索方式 | Embedding → 向量召回 → 排序模型 | **多层语义路标 + LLM 导航** |
| 触发方式 | 被动推送 | **Agent 在对话中自主判断** |

---

## 核心架构：多层语义路标

**"百万级检索"是伪命题。** 真正的问题不是"怎么在 100 万篇中搜"，而是"怎么让每篇信息进来的时候就被处理掉"。

传统路径是 embedding → 向量检索 → top-K → 排序模型。我们不做外挂检索。核心洞察是：

> **让 LLM 在生成摘要卡的同时，构建一棵多级知识地图。每个节点都是自然语言"路标"——LLM 写给未来的自己的笔记。推荐时，LLM 沿着自己留下的路标导航，而不是系统替它匹配。**

### 三层架构

```
第一层：共性推理（O(1)，入库时）
    新论文 → LLM 生成摘要卡（tags + 一句话 + 质量信号）
    压缩比 ~3x，对所有用户共享

第二层：语义路标（多层语义网，LLM 自动维护）
    LLM 将论文组织为网状知识地图
    节点 = 自然语言路标    边 = 自然语言关系描述
    论文可被多个节点引用（天然多归属）

第三层：LLM 导航（推荐时，图上推理游走）
    Agent 读路标 → 推理 → 选择方向 → 逐层深入
    全程 LLM 决策，系统只负责"打开指定节点"
```

### 多层语义网（不是树，是网）

知识不是树状的，知识是网状的——概念之间有多种关系、多个角度的关联。

```
                    ┌──────────────────────────────────────────┐
  Layer 0           │            顶层路标索引                    │
  (方向层)          │  [推荐系统]  [NLP]  [医疗AI]  [安全] ...   │
                    └─────┬──────────┬──────────┬──────────────┘
                          │          │          │
           ┌──────────────┘          │          └─────────────┐
           ▼                         ▼                        ▼
  Layer 1  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
  (领域层) │ [多目标优化]   │  │ [冷启动]      │  │ [大模型推理]    │
           │ 路标："Pareto │  │ 路标："生成式  │  │ 路标："..."     │
           │ 方法居多"     │  │ 召回替代 ID"  │  │                │
           └───┬──────┬───┘  └───┬──────────┘  └────────────────┘
               │      │          │
               │      ◆══════════╪═══════════◆
               │      ║  边："方法可用于      ║
               │      ║  冷启动场景"         ║
               │      ◆══════════╪═══════════◆
               │                 │
  Layer 2      ▼                 ▼
  (论文层)   [A] [B] [C] [F]  [D] [E] [F]
                       ↑               ↑
                       └─ 论文 F 同时属于两个节点 ─┘
```

**节点** = 自然语言路标描述 &nbsp;|&nbsp; **边** = 自然语言关系 &nbsp;|&nbsp; **论文** = 可多归属

### 为什么不用 embedding

关键判断标准：**谁在做决策？**

| | 向量检索 | 标签交集 | 语义路标 |
|---|---|---|---|
| 谁生成表示 | 外挂模型 | LLM | LLM |
| 谁做匹配 | **系统**（余弦距离） | **系统**（集合操作） | **LLM**（推理导航） |
| 随基座加强 | ❌ | 生成加强，消费不变 | **生成 + 消费都加强** |
| 可解释性 | ❌ | 弱 | **路标和推荐理由都是自然语言** |

语义路标：**LLM 生成路标，LLM 消费路标。全链路零外挂。**

### 导航效率

```
10 万篇论文，3-4 级路标导航：
  每层 ~500-800 tokens（读子节点描述）
  总计 ~2300-3500 tokens 即可到达目标

对比：全量灌入 → 不可能（几十万 tokens）
对比：向量检索 → 外挂，不符合设计原则
```

| 方案 | 入库成本 | 推荐成本 | 全链路 LLM |
|------|---------|---------|-----------|
| 全量灌入（v0.1） | O(0) | O(全量 tokens) | ✅ 但扛不住量 |
| 向量检索 | O(1) | O(top-K) | ❌ 系统做匹配 |
| **语义路标** | **O(1)** | **O(log N × 路标)** | **✅** |

### 自生长机制

语义网结构由 LLM 自生长，不预定义分类体系：

```
日常入库（高频、轻量）          定期重整（低频、重量）
────────────────────          ──────────────────
新论文 → 摘要卡 → 归现有节点    LLM 全局审视路标网络
不改结构，O(1)                分裂 / 合并 / 新建边 / 迁移论文
```

- **入库时**：LLM 生成摘要卡 + 归到最匹配的现有节点，同时输出微感知信号（归类置信度）
- **重整时**：累积触发（节点 >20 篇 / 低置信度 >30% / 每月兜底），LLM 审视后输出 diff
- **冷启动**：从零开始，第一次重整自然"长出"结构

---

## 工作原理

Agent 通过 `navigate_knowledge` 工具在语义网上做推理导航，在对话中自然推荐论文：

```
用户消息 → Agent 推理
              ↓
        调用 navigate_knowledge (overview)
              → 读顶层路标，选择方向
              ↓
        调用 navigate_knowledge (explore)
              → 沿边跳转，发现跨领域关联
              ↓
        调用 navigate_knowledge (read_papers)
              → 读摘要卡，挑选推荐
              ↓
        在回复中带出推荐 + 推荐理由
```

### 效果示例

```
你：最近多目标配平搞得头疼...

林风过竹：确实，加热保量和 CTR 优化天然冲突...

  对了，最近有两篇论文和你正在纠结的事情直接相关：
  1. 📄 "Pareto-Optimal Multi-Objective Reward Shaping for Recommendation"
     → 提出了不需要手动调 loss 权重的多目标配平方法
  2. 📄 "Constrained Optimization for Ecosystem Diversity in RecSys"
     → 直接讲模态挤占问题，和你遇到的现象完全对应
```

---

## 双源信息模型

### Inner Memory（已有）

来自 OpenClaw `workspace/memory/`，包含个人记忆、价值观、决策历史、当前关注点等。直接复用，无需额外建设。

### Outer Knowledge（本插件提供）

通过标准 RSS 协议拉取公开信息源（arXiv cs.IR / cs.AI / cs.LG），LLM 自动生成摘要卡并组织为多层语义网。

> Inner Memory 本身就是一个已验证的小规模路标系统（MEMORY.md → 分类目录 → 具体记忆）。
> Outer Knowledge 的语义路标是同一套模式在"大规模 + LLM 自动维护"条件下的泛化。
> **导航者相同，导航方式相同。唯一的区别是谁来建和维护路标。**

---

## 安装

### 本地开发安装

```bash
git clone https://github.com/nicepkg/openclaw-memory-reasoning.git
cd openclaw-memory-reasoning
npm install
npm run build
npm run deploy   # 编译并部署到 ~/.openclaw/extensions/personal-rec/
```

### 启用插件

在 `~/.openclaw/openclaw.json` 中添加：

```json
{
  "plugins": {
    "entries": {
      "personal-rec": {
        "enabled": true,
        "config": {
          "feeds": ["https://rss.arxiv.org/rss/cs.IR"],
          "fetchIntervalHours": 6
        }
      }
    }
  }
}
```

重启 Gateway：

```bash
openclaw gateway restart
```

---

## 配置项

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `feeds` | `string[]` | `["https://rss.arxiv.org/rss/cs.IR"]` | RSS Feed URL 列表 |
| `fetchIntervalHours` | `number` | `6` | 拉取间隔（小时） |

---

## 项目结构

```
openclaw-memory-reasoning/
├── src/
│   ├── index.ts                  # 插件入口：注册 service + tool
│   ├── feeds/
│   │   ├── service.ts            # 后台定时 RSS 拉取 + 摘要卡 pipeline
│   │   ├── parser.ts             # arXiv RSS XML 解析器
│   │   ├── backfill.ts           # arXiv API 历史数据回填
│   │   └── storage.ts            # JSON 文件存储 + 去重 + 索引
│   ├── knowledge/
│   │   ├── graph.ts              # 语义网 CRUD（节点/边/论文/摘要卡）
│   │   ├── reorganizer.ts        # LLM 驱动的语义网重整器
│   │   └── reorganize-cli.ts     # 重整 CLI
│   ├── summarizer/
│   │   ├── generator.ts          # LLM 摘要卡生成器
│   │   ├── classifier.ts         # LLM 多节点归类器
│   │   ├── cli.ts                # 摘要卡生成 CLI
│   │   └── classify-cli.ts       # 归类 CLI
│   ├── llm/
│   │   └── loader.ts             # runEmbeddedPiAgent 动态加载
│   └── tools/
│       ├── navigate-knowledge.ts # navigate_knowledge 工具（唯一对外）
│       └── search-feed.ts        # search_feed（已降级为内部工具）
├── docs/
│   ├── INDEX.md                  # 文档索引
│   ├── proposal.md               # 方案设计
│   ├── technical-design.md       # 语义路标技术设计
│   ├── mvp-plan.md               # 分阶段实现计划
│   └── checklist.md              # 实现进度 checklist
├── openclaw.plugin.json          # 插件清单
├── package.json
└── tsconfig.json
```

---

## 设计原则

- **一切基于 LLM 基座** — 不做外挂检索/向量召回/路由层，LLM 生成路标、LLM 消费路标
- **模型越强越好** — 路标越精准、导航越智能、推荐理由越深
- **纯公开数据** — 所有信息源通过 RSS 等公开协议获取，无私有数据依赖
- **管道通用、源可插拔** — 标准 RSS 协议，信息源随时增减
- **自生长、不预定义** — 语义网结构由 LLM 从数据中自动涌现

---

## 当前状态

- **Phase 1** ✅ — 摘要卡生成 + 单节点归类（588 篇论文，压缩比 3x）
- **Phase 2** ✅ — 多节点语义网 + LLM 导航（10 个子节点，导航省 96% tokens）
- **Phase 3** 🔜 — 自生长 + 自动重整 + 主动 briefing

---

## License

MIT
