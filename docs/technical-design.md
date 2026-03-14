# 语义路标记忆系统 — 技术设计

> 语义路标引擎 + 双记忆架构（内部驱动外部 + 淘汰机制）  
> 项目愿景见 [proposal.md](./proposal.md)，文档索引见 [INDEX.md](./INDEX.md)

**状态**: Phase R~4 实施完成，Phase 5~7 技术设计已收敛  
**日期**: 2026-03-08

---

## 一、核心架构：语义路标 + LLM 导航

### 问题

数据量从 MVP 的每周百篇增长到数千甚至百万级时，全量灌入 LLM 不现实。传统方案（embedding → 向量检索 → top-K）依赖外挂检索，违反设计原则。

**关键洞察**：这不是一个检索问题，而是一个增量处理问题——信息在进入系统的那一刻就该被处理掉。这是推荐系统思维，不是搜索引擎思维。

> 思路从"标签匹配"到"向量检索"再到"全链路 LLM 推理"的完整演进过程，见 [discussions/design-evolution.md](./discussions/design-evolution.md)。

### 方案：共性推理 × 语义路标 × LLM 导航

#### 第一层：共性推理 — O(1)，全局共享

论文入库时，LLM 推理一次，生成**摘要卡**：

```json
{
  "主题标签": ["multi-objective", "reward-shaping"],
  "方法类型": "优化方法",
  "解决的问题": "多目标配平",
  "质量信号": "ICML 2026 accepted",
  "一句话": "不需要手动调 loss 权重的多目标配平方法"
}
```

- 摘要卡是 **LLM 生成的自然语言**，不是 embedding（可读、可调试、可解释）
- 对所有用户共享，只推理 1 次
- 模型升级后重新生成即可获得更好的表示——**随基座加强而加强**
- **信息压缩比**：原始摘要 ~200 tokens → 摘要卡 ~30 tokens，约 7 倍压缩

#### 第二层：语义路标 — LLM 构建多层语义网

LLM 处理增量论文时，不只生成摘要卡，还维护一张**多层语义网**（不是树，是网）：

```
多层语义网（LLM 生成 + LLM 导航）

知识不是树状的，知识是网状的——概念之间有多种关系、多个角度的关联。

                    ┌─────────────────────────────────────────────┐
  Layer 0           │              顶层路标索引                      │
  (方向层)          │  [推荐系统]  [NLP]  [系统工程]  [因果推断] ...   │
                    └──────┬──────────┬──────────┬────────────────┘
                           │          │          │
            ┌──────────────┘          │          └──────────────┐
            ▼                         ▼                         ▼
  Layer 1  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
  (领域层) │ [多目标优化]   │  │ [冷启动]      │  │ [大模型推理]       │
           │ 路标："2026-02 │  │ 路标："生成式  │  │ 路标："..."        │
           │ Pareto 方法   │  │ 召回替代 ID"  │  │                   │
           └───┬───────┬──┘  └───┬──────────┘  └───────────────────┘
               │       │         │
               │       │ ◆═══════╪══════════◆
               │       │ ║  边："方法可用于   ║
               │       │ ║  冷启动场景"     ║
               │       │ ◆═══════╪══════════◆
               │       │         │
  Layer 2      ▼       ▼         ▼
  (论文层)   [A] [B] [C] [F]   [D] [E] [F]
                        ↑                ↑
                        └── 论文 F 同时属于两个节点 ──┘
```

**节点**：每个节点是一段自然语言路标（LLM 写给未来的自己的笔记）  
**边**：节点之间的关系也是自然语言（"方法可用于"、"共享数学框架"、"是...的子领域"）  
**论文**：可以被多个节点引用（网状天然支持多归属）

节点数据结构示例：

```json
{
  "id": "multi-objective",
  "description": "多目标优化：2026-02 出现一批 Pareto 方法，核心思路是不手动调权重",
  "edges": [
    { "to": "cold-start",        "relation": "方法可用于冷启动场景" },
    { "to": "causal-inference",   "relation": "共享帕累托优化的数学框架" },
    { "to": "rec-system",         "relation": "是推荐系统的子领域" }
  ],
  "papers": ["论文A", "论文B", "论文C", "论文F"]
}
```

**全部自然语言。** `description` 是路标，`relation` 是边的含义。LLM 读这些自然语言来决定导航方向。

**为什么是网不是树？**

| | 树 | 网 |
|---|---|---|
| 到达路径 | 唯一（从根到叶） | **多条**（从不同节点都能到达同一篇论文） |
| 发现关联 | 只能发现"同一分支下"的关联 | **能发现跨领域关联**（沿着边跳转） |
| 导航决策 | "进入哪个子节点" | **"走哪条边"** — 更丰富的推理空间 |
| 多归属 | 论文只能放一个位置 | **论文被多个节点引用**，天然解决 |
| 知识表达 | 层级分类（强制互斥） | **关系网络**（反映知识的真实结构） |

#### 第三层：LLM 导航 — 图上推理游走

推荐时，LLM 在语义网上做**推理驱动的游走**：

```
导航过程（图上推理游走）

1. 读用户兴趣画像
2. 读 Layer 0 顶层路标索引（~500 tokens）→ 选相关方向进入
3. 进入节点，读邻居 + 边描述（~800 tokens）→ 选下一步
4. 逐层深入，发现跨领域关联（沿边跳转）
5. 输出推荐列表 + 推荐理由

总 token 消耗：~2300 tokens，从 10 万篇中导航到最相关的几十篇
```

**每一步都是 LLM 推理**——系统只负责"打开 LLM 指定的那个节点"（数据导航），不做任何匹配判断。

### 为什么这不是外挂

关键判断标准：**谁在做决策？**

| | 标签交集 | 向量检索 | 语义路标 |
|---|---|---|---|
| 谁生成表示 | LLM | 外挂模型 | LLM |
| 谁做匹配决策 | **系统**（集合操作） | **系统**（余弦相似度） | **LLM**（推理导航） |
| 表示形式 | 字符串标签 | 黑盒向量 | **自然语言路标** |
| 随基座加强 | 生成加强，消费不变 | ❌ | **生成 + 消费都加强** |
| 可解释性 | 弱 | ❌ | **✅ 路标和推荐理由都是自然语言** |

### 复杂度对比

| 方案 | 论文入库成本 | 用户请求推荐成本 | 是否符合原则 |
|------|------------|----------------|-------------|
| 全量灌入（MVP） | O(0) | O(全量 tokens) | ✅ 但扛不住量 |
| fanout-on-write | O(用户数) | O(1) | ✅ 但扩散读 |
| ~~标签交集 + 精排~~ | O(1) | O(候选集) | ⚠️ 匹配是系统做的 |
| **语义路标 + LLM 导航** | **O(1)** | **O(log N × 路标)** | **✅ 全链路基座** |

10 万篇论文，3 级路标导航，LLM 只需 ~3500 tokens 即可到达目标。

### 设计选择的定位：与业界方案的对比

> 语义路标是一种 **LLM-native knowledge organization architecture**——索引构建、结构演化、导航检索**全部**交由 LLM 推理完成，不依赖任何外挂匹配机制。

#### 业界方案能力矩阵

| 能力 | SHIMI | Mnemis | RAPTOR | MemWalker | GraphRAG | Gen. Agents | Mem0 | HiAgent | **语义路标** |
|------|-------|--------|--------|-----------|----------|-------------|------|---------|-------------|
| 层次化索引 | ✅ | ✅ | ✅ | ✅ | — | — | — | ✅ | ✅ |
| LLM 生成索引/摘要 | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — | ✅ |
| LLM 导航（非向量） | — | 部分 | — | ✅ | — | — | — | — | **✅** |
| 图（非树）拓扑 | — | — | — | — | ✅ | — | ✅ | — | **✅** |
| 自然语言边 | — | — | — | — | 预定义类型 | — | — | — | **✅** |
| 增量自生长 | 部分 | 不详 | ❌ | ❌ | ❌ | — | — | — | **✅** |
| 全链路零外挂 | — | — | — | — | — | — | — | — | **✅** |

没有人做过的组合：**LLM 生成自然语言路标 → 构成多层语义网（非树）→ LLM 沿路标推理导航（非向量检索）→ LLM 自主重整（自生长）→ 全链路零外挂。**

#### 4 个核心设计选择及其理由

**选择 1：全链路 LLM — 消除系统匹配层**

所有业界方案在匹配环节都保留至少一层系统级组件：RAPTOR 用余弦相似度检索，GraphRAG 用向量匹配，Mnemis 设计了 System-1（快速向量）+ System-2（LLM 推理）双通道，Mem0 依赖向量 + 图检索混合。

我们的判断：这些系统级匹配层**是能力天花板的瓶颈**。基座升级时，RAPTOR 能重新生成更好的摘要但检索仍走向量；Mnemis 的 System-2 变强但 System-1 不变。语义路标将匹配完全交给 LLM 推理——系统能力天花板 = 基座能力天花板，随模型升级自动加强。

| 系统 | 生成表示 | 消费表示（做匹配） | 基座升级时 |
|------|---------|-------------------|-----------|
| RAPTOR | LLM 摘要 | **系统**（余弦相似度） | 检索仍走向量 |
| GraphRAG | LLM 提取 | **系统**（向量匹配） | 检索仍走向量 |
| Mnemis | LLM + 系统 | **系统** + LLM 混合 | System-1 不变 |
| Mem0 | LLM 提取 | **系统**（向量 + 图） | 向量检索不变 |
| **语义路标** | **LLM** | **LLM**（推理导航） | **生成 + 消费都加强** |

**选择 2：自生长语义网 — 从零冷启动、增量演化**

RAPTOR 是一次性自底向上构建，GraphRAG 需一次性提取 + 社区检测，两者都是**静态**的——新数据意味着重建。语义路标设计了完整的自生长生命周期：冷启动从零开始 → 日常入库归到现有节点（O(1)）→ 积累到阈值触发重整 → LLM 分裂/合并/建边 → 结构自然演化。

这不是工程优化，而是**根本理念不同**：知识结构应该是活的，随数据持续演化，而非一次定型。

**选择 3：网状多归属 + 自然语言边 — 反映知识的真实结构**

SHIMI、RAPTOR、MemWalker 都使用树结构——论文只能放一个位置，关联发现局限于"同一分支下"。GraphRAG 用图但边是预定义实体关系类型。

我们的判断：知识不是树状的，知识是网状的。一篇多目标优化的论文同时属于"推荐系统"和"因果推断"，这两个节点之间的关系是"共享帕累托数学框架"——这种关系不在任何预定义类型库里。语义路标的边由 LLM 自由生成自然语言描述，能发现和表达**任意类型的跨领域关联**。

**选择 4：可演进性 — 明确拒绝外挂组件**

这是一个架构哲学：现有论文还没有谁如此彻底地贯彻"全链路基座"理念。其他系统引入外挂匹配层是为了效率（向量检索快、图查询快），代价是**固化了一个不随基座升级的组件**。我们的判断是：上下文窗口持续增长 + 推理成本持续下降，效率差距会缩小，而架构差距不会——外挂一旦写进系统就很难移除。

#### 最近缘的三个工作

| | SHIMI | MemWalker | RAPTOR |
|---|---|---|---|
| **相似点** | 最相似的**结构设计**（语义层次索引） | 最相似的**导航直觉**（LLM 主动走） | 最相似的**构建方法**（LLM 生成摘要节点） |
| **关键分歧** | SHIMI 是树 + 系统检索，重心在去中心化同步 | 处理单文档压缩，不做知识组织；无自生长/网状/边 | 静态构建 + 向量检索 |
| **一句话差异** | 同样做语义层次，但我们**全链路 LLM + 网状** | 导航直觉一样，但我们做的是**持续增长的知识组织** | 同样用 LLM 建摘要，但我们是**动态自生长的网** |

> 各论文的详细分析见 [references/](./references/) 目录，综合对比见 [references/positioning.md](./references/positioning.md)。

---

## 二、路标系统设计

### Inner Memory 就是小规模路标系统

OpenClaw 的 `workspace/memory/` 现在的结构：

```
memory/
├── MEMORY.md              ← 顶层路标（关键词 → 文件映射）
├── insights/              ← 二级路标（洞察类）
├── projects/              ← 二级路标（项目类）
├── conversations.md       ← 时间线索引
└── ...
```

LLM 现在怎么用它：读 MEMORY.md（顶层路标）→ 找映射 → 加载目标文件 → 逐层深入。**这就是路标导航。**

所以：

> **Inner Memory 是路标系统在"小 size + 人工维护"条件下的特例。**  
> **Outer Knowledge 的路标系统是同一套思路在"大 size + LLM 自动维护"条件下的泛化。**

| | Inner Memory（已有） | Outer Knowledge 路标（待建） |
|---|---|---|
| 规模 | 几十个文件 | 几万~几十万篇 |
| 维护者 | **人**（用户 + 分身协作整理） | **LLM**（入库时自动构建） |
| 路标形式 | MEMORY.md 映射 + 目录结构 | 多层语义网节点 + 边 |
| 导航者 | LLM | LLM |

**导航者相同，导航方式相同。唯一的区别是谁来建和维护这些路标。** 数据仍然分开——Inner Memory 构建"你自己"，Outer Knowledge 组织"外部世界的信息"。**组织方式复用，数据独立。**

---

### 已达成共识

**① 入库与结构变更解耦**

```
日常入库（高频、轻量）              定期重整（低频、重量）
─────────────────────              ──────────────────────
新论文 → 摘要卡 → 归到现有节点      LLM 全局审视路标网络
                                     ↓
不改结构                           分裂 / 合并 / 新建边
不迁移论文                         迁移论文 + 更新路标描述
O(1) 推理                          O(N) 推理，但频率低（周/月）
```

- **入库时**：LLM 只做两件事——生成摘要卡 + 归到现有节点。即使归类不完美，暂挂最近似节点，等重整时再调
- **重整时**：LLM 全局审视——分裂过大节点、合并趋同节点、发现新的跨领域边、迁移受影响论文、更新过时的路标描述
- **和人的类比**：每天随手归档到"大概是这个方向"的文件夹，定期花半天重新整理

**② 多层网状结构**

- 路标系统是**多层语义网**（见第一章详述）
- **层级是分裂的自然产物**：不预定义层数。热门方向论文多→分裂多→自然长得更深；冷门方向保持浅层

**层级导航的效率分析**：

```
假设每个节点最多挂 20 篇论文，每次分裂成 3-5 个子节点：

  Layer 0:  1 个根节点（索引）
  Layer 1:  ~5 个大方向           → 覆盖 100 篇
  Layer 2:  ~25 个细分方向         → 覆盖 500 篇
  Layer 3:  ~125 个更细节点        → 覆盖 2500 篇
  Layer 4:  ~625 个节点            → 覆盖 12500 篇

3-4 层就能覆盖上万篇论文。
每层 ~500-800 tokens + ~50 tokens 输出
4 层总计 ~3500 tokens
```

延迟评估：4 层 × 每层 1-2 秒 = 4-8 秒。可通过合并层级读取、缓存热门路径、靠基座上下文增长自然优化。

**③ Inner Memory 与 Outer Knowledge 的关系**

- **组织方式复用，数据独立**——不共享知识地图，避免污染身份边界
- 推荐时 LLM 同时读两者：Inner Memory 指导导航方向，Outer Knowledge 提供导航空间

```
推荐 = f(Inner Memory × Outer Knowledge)
       ↑ 你是谁         ↑ 世界发生了什么
```

---

### 自生长机制

语义网的结构由 LLM 自生长，不预定义分类体系。每个子步骤（感知、判断、执行）都是 LLM 已经能做的基座能力，难点在**触发时机**。

#### 两阶段触发

```
阶段 1：日常入库时的"微感知"（轻量，每次入库都做）
──────────────────────────────────────────────────────
LLM 归类论文到节点时，顺便输出 side signal：
  {
    "归类到": "推荐系统",
    "归类置信度": "低",
    "感知信号": "这篇和节点下其他论文主题不太一样"
  }
成本：几乎为零——LLM 归类时多输出几个 token。

阶段 2：重整时的"全局审视"（重量，低频触发）
──────────────────────────────────────────────
触发条件（满足任一即可）：
  a) 某节点积累了超过 N 篇论文（简单阈值，如 20 篇）
  b) 某节点近期"低置信度归类"比例超过 30%
  c) 定时兜底（每月触发一次）
```

**分工**：感知和判断由 LLM 做（基座能力），触发调度由系统做（系统能力）。

#### 冷启动从零开始

```
第 0 天：语义网为空 → 第 1 篇论文入库，LLM 创建第 1 个节点
前 1-2 周：节点很少（1-3 个），归类简单，无需重整
积累到 ~20 篇：触发第一次重整，结构自然"长出来"
```

不用种子节点——冷启动期论文本来就少，归类粗糙的代价极低。

#### 完整的自生长生命周期

```
第 0 天：冷启动
  → LLM 创建 [推荐系统] 节点 → 论文 A 挂上

前 1-2 周（冷启动期）
  → 大部分论文挂在同一个节点下

积累到 ~20 篇
  → 置信度偏低，触发第一次重整

重整过程
  → LLM 读摘要卡 → "这些论文讲 3 件不同的事"
  → 分裂节点 + 建跨领域边 + 迁移论文

分裂后的日常
  → 新论文入库，归类更精准，置信度回升
  → 继续积累 → 下一次重整 → 循环
```

---

### 边的设计

**LLM 自由创建，不预定义类型。** 理由：预定义边类型 = 硬编码知识结构。边的关系描述完全由 LLM 生成和消费，基座越强描述越精准。

**稠密度控制**：节点分裂天然分散边——一个节点有 15 条边，说明它涵盖范围太广。分裂后边被分散到子节点，每个子节点 3-5 条边。极端枢纽概念（如"Transformer"）靠基座上下文能力承受。

**边的生命周期**：跟着重整统一处理——检查描述是否准确、是否还有必要、发现新关联、合并/分裂时迁移。

---

### 重整的具体机制

| 子问题 | 回答 |
|--------|------|
| **重整的输入** | 读触发节点下的所有摘要卡 |
| **重整的输出** | 结构变更 diff（新增/删除节点、边变更、论文迁移） |
| **重整的范围** | 默认增量（针对触发的节点），定时兜底时全局 |
| **重整的质量保证** | 暂不需要额外机制（数据量小、用户直接体感反馈、LLM 可自我 review） |

---

### 路标的自描述字段设计

> 路标节点不仅要描述外部世界，也要能描述自己的演进过程。

#### 设计动机

LLM 做重组时，光看"节点描述 + 挂了哪些论文"不够——还需要知道：
1. **这个路标为什么被建出来**（动机）
2. **当时是怎么推理到这个结构的**（规划思路）
3. **时间锚点**——判断路标是新建的还是已过时
4. **状态和依赖**——哪些路径活跃、收敛、被阻塞

#### 结构元信息

| 字段 | 说明 | 作用 |
|---|---|---|
| **ID** | 唯一标识（如 `Fix-R.5`） | 引用、依赖图构建 |
| **状态** | 🔴待做 / 🟡进行中 / ✅完成 / ⏸搁置 | 导航时跳过已完成/搁置的路径 |
| **优先级** | P0阻塞 / P1重要 / P2改善 | 排序和分流 |
| **创建日期** | 路标创建时间 | 时间锚点 |
| **预计/实际完成** | 目标和实际完成时间 | 节奏感知、复盘对比 |
| **前置依赖** | 依赖的其他路标 ID | 拓扑排序 |
| **相关人物** | `string[]` | **最强关联枢纽**（见下文） |

#### 推理上下文（LLM 消费的核心）

| 字段 | 说明 |
|---|---|
| **问题/动机** | 为什么要建这个路标（现象 + 影响） |
| **规划思路** | 从问题到方案的推理链（**最重要的字段**——路标的"建设理由"，LLM 重组时读它来还原设计意图） |
| **技术方案** | 具体做什么 |
| **验收标准** | 怎么判定完成（可量化） |

**规划思路的格式**：自然语言推理链——`观察到 X → 排查发现 Y 是根因 → 因为 Z 原理 → 所以方案是 W`

#### 路标自描述与知识路标的同构关系

| | 知识路标（Outer Knowledge） | 工程路标（Checklist） | 内部记忆卡片（Inner Memory） |
|---|---|---|---|
| 节点 | 知识概念 | 工作单元 | 记忆片段 |
| 节点描述 | 自然语言路标描述 | 问题/动机 + 规划思路 | section 标题 + 内容摘要 |
| 边 | 节点间语义关系 | 前置依赖 | 人物/项目/时间的共现关系 |
| 导航 | LLM 读路标 → 选方向 → 展开 | LLM 读路标 → 判断优先级 → 执行 | LLM 按人物/项目/时间维度检索 |
| 重组 | 分裂/合并/迁移 | 路标自我总结 → 迭代方案 | 日志合并为洞察、洞察升级为决策 |

**关键洞察**：工程路标的自描述字段，本质上就是"路标系统应用于自身"。

#### 人物作为最强关联枢纽

在内部记忆中，**人物是最重要的实体属性**：
1. **查询频率最高**：大量问题围绕人
2. **关联最密集**：跨多个项目、时间段出现，是天然的跨节点连接器
3. **记忆的本质是社交网络**：核心是"谁 + 什么时候 + 做了什么"

#### 实体关联属性的提取策略（2026-03-07 更新）

> **重大变更**：经讨论（见 `docs/discussions/entity-extraction-redesign.md`），`projects`、`tags`、`locations`、`qualitySignal`、`type` 等字段已从卡片 schema 中移除。关联关系统一由**图拓扑**表达。

**卡片上唯一保留的实体属性是 `people`**：

| 属性 | 提取方式 | 保留理由 |
|---|---|---|
| **人物** | 正则匹配已知人物 ID/姓名（`facts/work.md` 身份速查表） | 人名是稳定标识符；查询要求卡片维度检索；人物跨节点分布，图拓扑不适合表达 |

**设计原则**：卡片只承载**确定性字段**（事实性元数据 + LLM 语义摘要），所有关联关系交给图拓扑。

#### 支持自我总结迭代

时间字段 + 规划思路的组合，使 LLM 可以做路标级别的自我复盘：创建路标 → 记录推理链 → 执行更新状态 → 完成后对比预计 vs 实际 → 总结哪些推理准确、哪些假设被推翻 → 下一个路标引用复盘结论。

#### 实例模板

```markdown
#### {ID}: {标题} {状态}

| 字段 | 值 |
|---|---|
| 优先级 | P0/P1/P2 — 一句话说明 |
| 创建日期 | YYYY-MM-DD |
| 预计完成 | YYYY-MM-DD |
| 实际完成 | YYYY-MM-DD（完成后填写） |
| 前置依赖 | {依赖的 ID 列表} |
| 相关人物 | {人物 ID 列表}（parser 自动提取） |

**问题/动机**：{现象描述 + 对用户/系统的影响}

**规划思路**：
{观察到 X → 排查发现 Y 是根因 → 因为 Z 原理 → 所以方案是 W}

**技术方案**：{具体做什么}

**验收标准**：
- [ ] 标准 1（可量化）
- [ ] 标准 2
```

---

## 三、统一导航架构 — 数据分离，逻辑共享

> Plugin + Skill 混合架构，以及外部数据与内部数据的分离原则。

### 核心设计原则

#### 必须分离的层（铁律）

| 层面 | Outer Knowledge（论文） | Inner Memory（记忆） | 分离理由 |
|------|------------------------|---------------------|---------|
| **数据存储路径** | `personal-rec/knowledge/` | `memory/knowledge/` | 来源不同、生命周期不同 |
| **graph.json** | 各自独立 | 各自独立 | 节点语义完全不同 |
| **cards/** | 各自独立 | 各自独立 | 内容不应混排 |
| **写入管道** | Plugin 定时拉取 RSS | memory-manager Skill 用户主动写入 | 完全不同的触发机制 |

**为什么必须分离**：身份边界不能污染；生命周期完全不同；导航时不做跨源混合检索。

#### 可以共享的层

| 层面 | 共享内容 | 理由 |
|------|---------|------|
| **类型定义** | `ContentCard`、`GraphNode` | 代码复用 |
| **导航算法** | overview / explore / read 三步法 | 交互模式一致，通过 `--source` 切换 |
| **索引构建逻辑** | 分类、归类、重整算法 | 算法复用，各自操作各自的 graph |

---

### 架构设计：Plugin + Skill 职责分工

```
  ┌─────────────────────────────────┐
  │     Plugin (后台服务层)          │
  │                                 │
  │  只做"系统能力"：                │
  │  • 定时 RSS 拉取               │
  │  • 摘要卡生成 + 入库归类        │
  │  • 自动重整触发                 │
  │  • 主动检索调度（Phase 5）      │
  │  • 不注册 tool                  │
  │                                 │
  │  写入：personal-rec/knowledge/  │
  └─────────────┬───────────────────┘
                │ 写入数据
                ▼
  ┌─────────────────────────────────┐
  │     knowledge/ 数据层           │
  │                                 │
  │  论文: personal-rec/knowledge/  │  ← Plugin 写入
  │  记忆: memory-index/knowledge/  │  ← sync-cli / incremental-indexer 写入
  │                                 │
  │  各自独立的 graph.json + cards/  │
  └─────────────┬───────────────────┘
                │ 只读访问
                ▼
  ┌─────────────────────────────────┐
  │     Skill (交互层)              │
  │                                 │
  │  semantic-navigator:            │
  │  • navigate.ts --source X       │
  │    --action overview|explore|   │
  │           read                  │
  │  • 统一导航逻辑，分离数据路径    │
  └─────────────────────────────────┘
```

#### 实际数据路径（Phase R 实施后）

| 数据 | 路径 | 说明 |
|------|------|------|
| 论文知识图谱 | `~/.openclaw/personal-rec/knowledge/graph.json` | 70 节点，2925+ 论文 |
| 论文摘要卡 | `~/.openclaw/personal-rec/knowledge/cards/*.json` | 每篇论文一个 JSON |
| 记忆索引图谱 | `~/.openclaw/memory-index/knowledge/graph.json` | 19 节点，219+ 记忆实体 |
| 记忆摘要卡 | `~/.openclaw/memory-index/knowledge/cards/*.json` | 每个 section 一个 JSON |
| 同步状态 | `~/.openclaw/memory-index/sync-state.json` | 增量同步的 mtime 记录 |
| 关注方向快照 | `~/.openclaw/memory-index/snapshot/current-focus.json` | Phase 4 输出 |
| Skill 声明 | `~/.openclaw/workspace/skills/semantic-navigator/SKILL.md` | Agent 调用入口 |

> **注**：记忆索引路径从最初设计的 `memory/knowledge/` 调整为 `memory-index/knowledge/`，与源 `memory/` 目录完全隔离，确保索引操作不影响原始记忆文件。

---

### graph.ts 泛化设计

#### 命名映射

| 原命名（论文专属） | 新命名（通用） | 说明 |
|-------------------|---------------|------|
| `GraphNode.papers` | `GraphNode.items` | 节点下挂载的内容 ID 列表 |
| `SummaryCard` | `ContentCard` | 内容卡片类型 |
| — | `ContentCard.type` | 新增：`"paper"` \| `"memory"` |
| `hasPaper()` | `hasItem()` | 检查内容是否已在图中 |
| `addPaperToNode()` | `addItemToNode()` | 将内容挂到节点 |
| `movePapers()` | `moveItems()` | 重整时迁移内容 |
| `loadNodeCards()` | `loadNodeItems()` | 加载节点下的内容卡片 |

**向后兼容**：读取旧 `graph.json` 中的 `papers` 字段时自动映射为 `items`。

#### ContentCard 精简 schema（2026-03-07 更新）

> 经讨论（见 `discussions/entity-extraction-redesign.md`），memory 类型卡片大幅精简。

```typescript
// ContentCard — 统一卡片类型（论文 + 记忆共用）
interface ContentCard {
  id: string;           // arXiv ID（论文）或 "{filename}-{line}"（记忆）
  type: "paper" | "memory";
  title: string;        // LLM 精炼标题（memory: ≤20字）
  oneLiner: string;     // 一句话概括（memory: ≤40字）
  source: string;       // "arxiv:cs.IR" 或 "memory/decisions.md"
  date: string;         // ISO 日期

  // ── 仅 memory 使用 ──
  people?: string[];    // 相关人物（企微 ID），正则匹配人物词典
  sourceFile?: string;  // 源 markdown 文件路径

  // ── 仅 paper 使用（兼容现有论文系统） ──
  tags?: string[];
  qualitySignal?: string;
  url?: string;
  generatedAt?: string;
}
```

**设计原则**：memory 卡片只承载**确定性字段**（事实性元数据 + LLM 语义摘要），所有关联关系（项目、标签、场景）交给**图拓扑**表达。`people` 是唯一保留在卡片上的实体属性——人名是稳定标识符，且人物跨节点分布，图拓扑不适合表达。

---

### 记忆索引构建

Inner Memory 当前是散装 Markdown，需要构建结构化索引：

```
memory/ 下的 .md 文件
  → 按段落/section 拆分（parser.ts）
  → 为每个 section 生成 ContentCard（index-builder.ts）
  → 从源文件路径自动归类到 seed 节点
  → 输出到 memory-index/knowledge/{graph.json, cards/}
```

两种模式：全量构建（`sync-cli.ts --full`）、增量更新（`sync-cli.ts`，基于 mtime 检测变更文件）。

#### 实体拆分规则（parser.ts）

```typescript
// 中间态，不持久化
interface MemoryEntity {
  id: string;           // "{filename}-{line}"
  title: string;
  content: string;
  sourceFile: string;
  sourceLine: number;
  date?: string;        // 多层继承日期
  level: number;        // ## = 1, ### = 2, #### = 3
  people: string[];     // 从人物词典匹配
}
```

- **段落边界**：识别 Markdown 标题（`##`、`###`）作为 section 分割点
- **过滤规则**：跳过内容 < 50 字符的空段落；跳过纯列表段落（非列表行 < 3 行）

#### 日期提取三层优先级

```
优先级 1：Section 自身标题中的日期
  "## 2026-03-05：贴图流量重心" → 2026-03-05

优先级 2：从父标题继承日期（parentDates 栈）
  "### 理由" 继承 "## 2026-03-05：xxx" 的日期

优先级 3：文件名中的日期
  "2026-03-05.md" → 2026-03-05

Fallback：索引运行时间（仅对无时间概念的常设文档生效）
```

这解决了 `decisions.md`、`insights/*.md` 等非日期命名文件中 69% 卡片日期不准确的问题。修复后，有时间概念的内容 100% 准确。

#### 人物提取（正则匹配人物词典）

从 `facts/work.md` 身份速查表加载人物词典（企微 ID + 中文姓名），对每个 section 内容做正则扫描：

- **企微 ID**：带词边界的精确匹配（`(?<![a-zA-Z0-9])id(?![a-zA-Z0-9])`）
- **中文姓名**：`text.includes(name)` 精确匹配

当前覆盖度：27 人词典，219 张卡片中 43 张（19%）含 `people` 字段。比例合理——大量 insights / 方法论类卡片本身不提及人名。

#### Seed 节点与源文件路径映射

冷启动时通过源文件路径自动归类到 7 个 seed 节点：

| 源文件模式 | Seed 节点 | 描述 |
|-----------|-----------|------|
| `decisions.md` / `decisions/*` | `decisions` | 核心决策记录 |
| `insights/*` | `insights` | 个人洞察与方法论 |
| `YYYY-MM-DD.md` | `daily-log` | 日常工作日志 |
| `projects/*` | `projects` | 工作项目信息 |
| `facts/*` | `facts` | 人物档案与事实信息 |
| `conversations.md` / `conversations/*` | `conversations` | 对话与交流记录 |
| 其他 | `archive` | 未归类内容（fallback） |

这比之前的 `entityType` 映射更稳定——源文件路径是确定性信号，不依赖 LLM 分类。

#### LLM 增强（summarizer.ts）

索引构建后可选执行 LLM 增强，为每张 memory 卡片精炼 `title`（≤20 字）和 `oneLiner`（≤40 字）。通过 `llmEnhanced` 布尔标记实现幂等——再次运行自动跳过已增强卡片。

**不依赖 LLM 的 fallback**：未增强的卡片使用 section 标题作为 title，内容前 200 字作为 oneLiner。

---

### 统一导航 Skill：semantic-navigator

```
skills/semantic-navigator/
├── SKILL.md           # Skill 声明（部署到 ~/.openclaw/workspace/skills/）
└── scripts/
    └── navigate.ts    # 导航入口（编译后部署）
```

```
navigate.ts --source papers|memory --action overview|explore|read
            [--nodeId <id>] [--limit N] [--offset N] [--since YYYY-MM-DD]
```

| `--source` | graph.json 路径 | cards/ 路径 |
|------------|----------------|-------------|
| `papers` | `~/.openclaw/personal-rec/knowledge/graph.json` | `~/.openclaw/personal-rec/knowledge/cards/` |
| `memory` | `~/.openclaw/memory-index/knowledge/graph.json` | `~/.openclaw/memory-index/knowledge/cards/` |

#### 三种 Action 的行为

| Action | 输入 | 输出 | 典型场景 |
|--------|------|------|---------|
| `overview` | source | 顶层节点列表 + 统计（items 总数、活跃节点数） | "帮我看看有什么方向" |
| `explore` | source + nodeId | 指定节点的邻居、边关系、子节点列表 | "深入看看推荐系统" |
| `read` | source + nodeId + limit/offset/since | 节点下的 ContentCard 列表（Markdown 格式） | "最近一周有什么新论文" |

#### Agent 集成（AGENTS.md 配置）

- **优先级**：semantic-navigator Skill > MEMORY.md 快速导航索引 > 直接读文件
- Agent 在对话中根据自然语言请求，自动映射到 CLI 参数并调用 Skill
- Skill 不可用时，自动 fallback 到 MEMORY.md

**核心设计**：一套脚本，两个数据路径，零代码分叉。

---

## 四、双记忆架构 — 内部驱动外部

> 将语义路标重整扩充到内部记忆，同时与外部记忆隔离，内部记忆驱动外部记忆的检索与淘汰。

### 架构总览

```
┌─────────────────────────────────────────────────┐
│              语义路标引擎（共享）                   │
│  归类 · 导航 · 重整 · 自生长 — 同一套机制          │
└──────────┬──────────────────────┬────────────────┘
           │                      │
   ┌───────▼────────┐    ┌───────▼────────┐
   │  内部记忆 Store  │    │  外部记忆 Store  │
   │  （语义路标图）   │    │  （语义路标图）   │
   │                 │    │                 │
   │ 日志/决策/洞察   │    │ 论文/资料        │
   │ 人物/项目/事实   │    │                 │
   └───────┬─────────┘    └───────▲─────────┘
           │                      │
           │  ① 驱动检索           │
           │  生成精准 query ──────→│
           │                      │
           │  ③ 主动淘汰           │
           │  兴趣变化 → 清理 ────→│
           │                      │
           │  ④ 被动淘汰           │
           │  规模超限 → 降权清理 ─→│
           └──────────────────────┘
```

### 核心设计决策

**1. 内外不对称**：内部是需求侧，外部是供给侧。内部记忆重整产出**用户当前关注的方向图谱**，直接用来生成论文搜索 query、评估论文相关度、驱动淘汰决策。

**2. 同一套语义路标机制**：共享归类/重整/导航机制，隔离数据（各自独立的 graph.json、cards/、signals.json）、实体粒度（外部=论文，内部=决策/洞察/日志）、写入管道。

**3. 搜索论文先入库，后淘汰**：入库成本低，淘汰需要全局视角，先入库保证不遗漏。

---

### 淘汰机制

**主动淘汰**：内部记忆重整后，发现兴趣方向迁移 → 降权或标记旧方向论文为"过期"。

**被动淘汰**：外部记忆规模超限 → 按综合指标排序（与当前关注方向的相关度、导航命中次数、入库时间、是否被主动淘汰标记）→ 清理排名最低的论文。

**淘汰不是"删除"，而是"降低可达性"**：
1. 从导航热点路径移除
2. 摘要卡归档（释放 graph 空间，卡片保留）
3. 物理删除（可配置，默认不做）

---

### 内部记忆的语义路标

**实体粒度**按内容类型自然分层：

| 内容类型 | 实体粒度 | 来源 |
|----------|----------|------|
| 日志 | 一天的事件摘要 | `memory/YYYY-MM-DD.md` |
| 决策 | 一个决策记录 | `memory/decisions.md` |
| 洞察 | 一条洞察 | `memory/insights/*.md` |
| 人物 | 一个人物档案 | `memory/facts/work.md` |
| 项目 | 一个项目概要 | `memory/projects/*.md` |

**路标的语义层次**：不预定义分类体系，从零开始让 LLM 在重整时自然生长。现有目录结构可作为冷启动 seed hint，但不是硬约束。

---

### 内部记忆重整机制（Phase 4 实施）

> 复用外部论文的重整思路，适配内部记忆场景。

#### 两阶段 LLM 流程

```
Stage 1：定义子节点（轻量，每个待分裂节点调用 1 次 LLM）
──────────────────────────────────────────────────────────
输入：节点下所有卡片的样本（最多 30 个，按日期排序取最新）
      卡片字段：id, title, oneLiner, date, people
LLM 输出：
  {
    "shouldSplit": true,
    "newNodes": [
      { "id": "product-direction", "description": "产品方向讨论...", "keyTags": [...] }
    ],
    "newEdges": [
      { "from": "product-direction", "to": "scaling-strategy", "relation": "产品方向驱动技术选型" }
    ]
  }
规则：3-8 个子节点；<8 条记忆不分裂

Stage 2：批量归类（每批 40 条记忆，串行调用 LLM）
──────────────────────────────────────────────────
输入：Stage 1 定义的节点 + 卡片列表
LLM 输出：每条记忆的 { cardId, nodeId, secondary? } 归类
支持一条记忆归入两个节点（primary + secondary）
过滤：<2 条记忆的空节点合并回源节点
```

#### 命名风格

- **外部论文**：学术概念命名（`multi-objective-optimization`、`cold-start`）
- **内部记忆**：日常用语命名（`product-direction`、`team-collaboration`、`scaling-strategy`）

#### 实际重整结果（Phase 4.4 实施数据）

```
重整前：7 个 seed 节点
  daily-log(73)  archive(54)  projects(35)  decisions(19)  insights(17)
  conversations(11)  facts(10)

重整后：19 个节点（seed + LLM 分裂子节点）
  daily-log →
    team-collaboration(25)  recommendation-system(15)  scaling-up-tech(15)
    mcp-architecture(9)  experiment-data(5)  openclaw-dev(3)
  archive →
    memory-system-architecture(18)  technical-implementation(15)
    ai-project-management(6)  creator-tools(6)  market-competition-analysis(2)
```

---

### 关注方向图谱提取（Phase 4.5）

> 从重整后的路标图提取"当前活跃方向"快照，供 Phase 5 检索 query 生成器消费。

#### 快照类型定义

```typescript
interface FocusNode {
  id: string;               // 节点 ID
  description: string;      // 节点路标描述
  itemCount: number;        // 挂载的卡片总数
  recentItemCount: number;  // 最近 N 天的卡片数
  latestDate: string | null;
  topPeople: string[];      // 该节点下最常出现的人物（频率 top 5）
  sampleTitles: string[];   // 样本标题（最多 5 个）
}

interface FocusSnapshot {
  generatedAt: string;
  memoryIndexDir: string;
  totalNodes: number;
  totalItems: number;
  activeNodes: FocusNode[];  // 活跃方向
  inactiveNodes: Array<{     // 非活跃方向
    id: string; description: string; itemCount: number; reason: string;
  }>;
}
```

#### 活跃判定规则

节点同时满足以下条件即为活跃：
1. `itemCount >= minItems`（默认 3）
2. 最近 `recentDays`（默认 14 天）内有新增卡片

#### 快照数据示例（Phase 4 输出）

- **15 个活跃方向**，3 个非活跃（daily-log:1, archive:5, market-competition-analysis:2）
- 输出到 `~/.openclaw/memory-index/snapshot/current-focus.json`
- 快照字段已精简：只含 `topPeople` 和 `sampleTitles`，不含已移除的 `topTags` / `topProjects`

---

### 内部记忆重整如何驱动外部检索

```
① 内部记忆重整完成 → 产出"当前关注方向图谱"
② 从图谱提取检索意图 → 每个活跃节点生成 1-3 个检索 query
③ 用检索 query 搜索论文 → 结果入库到外部记忆 Store
④ 内部记忆变化触发主动淘汰 → 弱化不再活跃的方向
```

这个循环是持续的：内部记忆变 → 检索方向变 → 外部记忆更新 → 淘汰过期内容。

### 待细化的设计点

1. ~~**内部记忆重整的频率和触发条件**~~ — ✅ Phase 4 已实现
2. ~~**检索 query 生成的策略**~~ — ✅ 见第五章
3. ~~**淘汰指标的权重**~~ — ✅ 见第六章
4. ~~**主动淘汰的粒度**~~ — ✅ 见第六章（三级淘汰）
5. ~~**内部记忆实体的拆分规则**~~ — ✅ Phase 4 已实现（见第三章·记忆索引构建）

---

## 五、内部驱动外部检索 — 从关注方向到学术发现

> Phase 5 技术设计。核心命题：内部记忆的活跃方向 → 意图筛选 → 精准的学术检索 query → 搜索论文 → 去重入库。
>
> 依赖：Phase 4 的 `current-focus.json` + `semantic-navigator` + Phase 1-3 入库管道

### 设计动机

Phase 4 完成后，系统已经具备"知道用户在关注什么"的能力（`current-focus.json` 的 14+ 个活跃方向）。但外部论文库的扩充仍然依赖 RSS 被动拉取。**核心问题**：如何让系统**主动搜索**匹配的论文？

**问题 v2（Phase 5.1.1）**：并非所有活跃方向都适合学术检索。"团队协作机制"、"核心决策记录"、"人物档案"这类管理/日常节点不应该生成学术 query，否则 LLM 只会产出 "team collaboration mechanisms" 这种无意义的泛 query。**每个外部检索场景都有适合与不适合的边界，应利用 LLM 的判断能力做意图转换。**

**答案**：先让 LLM 判断哪些活跃节点有学术检索价值（意图筛选），再对通过筛选的节点提取底层技术概念生成 query。

### 架构总览

```
current-focus.json
  activeNodes[]
      │
      ▼
  🆕 query/generator.ts — filterSearchableNodes()
      LLM 一次调用：14 个方向 → 哪些适合搜论文？
      ├── ✓ recommendation-system, scaling-up-tech, memory-system-architecture ...
      └── ✗ team-collaboration, decisions, facts, conversations ...
      │
      ▼ （只保留 suitable=true 的节点）
  query/generator.ts — generateQueriesForNode()
      LLM 逐节点生成 1-3 个 query
      ⚠️ 强调"从工作笔记提取底层技术概念"而非翻译标题
      │
      ▼
  search/semantic-scholar.ts
      Semantic Scholar API 搜索
      │
      ▼
  search/deduplicator.ts
      基于 paperId/arxivId 去重
      │
      ▼
  search/pipeline.ts ─────────→ generateSummaryCards()
      编排以上步骤                classifyCards()
```

### 关键设计决策

#### 0. 意图筛选层（Phase 5.1.1 新增）

**问题**：活跃方向包含「技术研究」和「工作管理」两类节点，无差别生成 query 导致大量无效搜索。

**方案**：在 query 生成前，LLM 一次调用分类所有节点：

```
System: 你是搜索意图分类器。判断用户的关注方向是否适合在 Semantic Scholar 搜索学术论文。
        适合：技术研究方向（算法、架构、模型）、有学术文献的领域问题
        不适合：团队管理、决策记录、人事信息、工具配置、日常对话

Input: 14 个节点的 [id, description, sampleTitles]
Output: [{"nodeId": "xxx", "suitable": true/false, "reason": "..."}]
```

**特点**：
- **一次 LLM 调用**处理所有节点（不是逐节点，成本可控）
- **安全 fallback**：解析失败时保留所有节点（不丢失检索机会）
- 未被 LLM 提及的节点默认保留
- 筛选结果记录到 `latest.json` 的 `filteredOutNodes` 字段（可追溯）

#### 1. 搜索 API 选型：Semantic Scholar 为主

| | Semantic Scholar | arXiv API |
|---|---|---|
| 搜索质量 | **高**（语义搜索） | 一般（关键词匹配） |
| 摘要 | ✅ | ✅ |
| 速率限制 | 100 req/s（有 key），1 req/s（无 key） | 3 秒间隔 |
| 费用 | 免费 | 免费 |

不申请 API Key：每轮约 15-30 个 query，串行 15-30 秒，可接受。

#### 2. Query 生成策略（Phase 5.1.1 改进）

**核心改进**：输入是**工作笔记标题**（项目日志、会议记录、实验数据），不是论文标题。Prompt 必须引导 LLM **穿透表面描述，提取底层技术概念**。

**改进后的 Prompt 设计**：

```
System: 你是学术检索 query 助手。你会收到用户的工作笔记，你需要提取其中的底层技术概念，
        生成精准的学术搜索 query。
        关键：输入是工作笔记而非论文标题，你需要推测背后的学术研究兴趣。

User:
  技术领域：{node.id} — {node.description}
  近期工作笔记标题：
    - {sampleTitles (up to 5)}

  记住：这些是工作笔记，不是论文标题。提取底层技术概念。例如：
  - "TIGER vs OneRec 对比" → "generative retrieval recommendation" / "tokenized ID sequential recommendation"
  - "订阅号图片精排调平数据" → "multi-objective optimization ranking" / "image recommendation CTR"
  - "冷启动子池适配" → "cold start recommendation" / "user interest exploration"

Output: {"queries": ["query1", "query2"]}
```

**跨节点去重**：
1. 归一化：lowercase + trim
2. 精确去重：完全相同的 query 合并
3. 子串包含检测：query A 是 query B 的子串时，保留更长的 B
4. 每个 query 保留来源节点 ID（支持溯源）

#### 3. 去重策略

```
搜索结果 → 已有卡片去重（cards/ 目录扫描）→ 批次内去重 → 新论文

已有卡片匹配：
  优先 arxivId（现有论文卡片 ID 就是 arXiv ID 格式）
  fallback paperId（"ss:{paperId}" 前缀匹配）

批次内去重：
  多个 query 可能搜到同一篇论文 → 按 paperId 去重
```

#### 4. Semantic Scholar API 封装

```typescript
// API endpoint
GET https://api.semanticscholar.org/graph/v1/paper/search
  ?query={query}&limit=10&fields=title,abstract,authors,year,externalIds,url,citationCount

// 标准化返回类型
interface SearchResult {
  paperId: string;        // Semantic Scholar ID
  arxivId: string | null; // 从 externalIds.ArXiv 提取
  title: string;
  abstract: string;
  authors: string[];      // 作者姓名列表
  year: number;
  url: string;            // Semantic Scholar URL
  citationCount: number;
}
```

**速率限制处理**：
- 无 API Key：每次请求间插入 1s 延迟
- HTTP 429：指数退避重试（1s → 2s → 4s），最多 3 次
- HTTP 5xx：重试 1 次后 skip
- 网络超时：10s，超时后 skip

#### 5. SearchResult → FeedItem 转换

搜索结果转换为现有入库管道可消费的 `FeedItem` 格式：

| SearchResult 字段 | FeedItem 字段 | 转换规则 |
|-------------------|---------------|---------|
| `arxivId ?? "ss:" + paperId` | `id` | arxivId 优先，无则用 SS ID |
| `title` | `title` | 直接映射 |
| `abstract` | `summary` | 缺失时用 `"[abstract not available]"` |
| `authors` | `authors` | 直接映射 |
| `year` | `published` | `"{year}-01-01"`（SS 只返回年份） |
| `url` | `link` | 直接映射 |
| — | `source` | 固定 `"semantic-scholar"` |

#### 6. 入库复用

转换后的 FeedItem 直接进入现有管道：
- `generateSummaryCards()`：LLM 生成摘要卡（已有的自动 skip）
- `classifyCards()`：入库归类到语义图节点（已入库的自动 skip）

**零新代码**：复用 Phase 1-3 的全部入库逻辑。

#### 7. 调度集成

```
postFetchPipeline 末尾 / memory-manager Post-Write Pipeline 末尾新增：
  → proactiveSearch()
      ├── loadFocusSnapshot()
      ├── 🆕 filterSearchableNodes()  ← 意图筛选（1 次 LLM 调用）
      ├── generateQueries()            ← 只处理通过筛选的节点
      ├── 遍历 query，逐个 searchPapers()（串行，遵守速率限制）
      ├── deduplicateResults()
      ├── toFeedItems()
      ├── generateSummaryCards()  ← 复用
      └── classifyCards()         ← 复用
```

**节流机制**：
- 对比 `current-focus.json` 的 `generatedAt` 与 `search-state.json` 中的上次搜索时间
- 快照未更新则跳过（避免每次 RSS 拉取都触发搜索）
- 上次搜索时间持久化到 `~/.openclaw/memory-index/search-state.json`

**配置开关**：
- `ServiceOpts.enableProactiveSearch`（默认 true）
- `ServiceOpts.searchLimit`（每轮最多搜索的 query 数，默认 30）
- `ServiceOpts.searchPerQuery`（每个 query 返回的论文数，默认 10）
- `QueryGeneratorOpts.skipFilter`（跳过意图筛选，调试用）

**非阻塞设计**：`proactiveSearch()` 失败只 log 不中断（与现有 pipeline 错误处理一致），整体 5 分钟超时保护。

### 复杂度分析

一轮 proactiveSearch（14 个活跃节点，筛选后约 5-7 个进入 query 生成）：

| 阶段 | 耗时 | LLM 调用 | API 调用 |
|------|------|---------|---------|
| 快照加载 | ~0s | 0 | 0 |
| 🆕 意图筛选 | ~3s | **1** | 0 |
| Query 生成 | ~15s | ~6 | 0 |
| API 搜索 | ~15s | 0 | ~15 |
| 去重 | ~0.1s | 0 | 0 |
| 摘要卡生成 | ~90s | ~45 | 0 |
| 归类 | ~15s | ~15 | 0 |
| **总计** | **~2.3 分钟** | **~67** | **~15** |

> 相比 Phase 5.1（4.5 分钟/135 次 LLM 调用），筛选掉无效节点后 **LLM 调用减少 ~50%，耗时减半**。

### 新增文件清单

| 文件 | 职责 | 行数 |
|------|------|------|
| `src/query/generator.ts` | 意图筛选 + 读取快照 → LLM 生成检索 query → 跨节点去重 | ~400 |
| `src/search/semantic-scholar.ts` | 封装 Semantic Scholar API + 速率限制 | ~150 |
| `src/search/deduplicator.ts` | 基于 paperId/arxivId 去重 | ~80 |
| `src/search/pipeline.ts` | 编排 query→搜索→去重→入库的端到端管道 | ~260 |
| `src/search/search-cli.ts` | CLI 入口（`--dry-run` / `--limit` / `--query-only` / `--skip-filter`） | ~120 |

**零新 npm 依赖**：使用 Node.js 内置 `fetch`。

### 与第四章的关系

第四章描述了"内部驱动外部"的架构愿景。本章是"检索 → 入库"环节的具体实现。淘汰机制（Phase 6）待独立设计。

```
第四章愿景                       本章实现
──────────                      ──────────
① 内部重整 → 关注方向图谱       ✅ Phase 4 已完成
② 从图谱提取检索意图             ✅ query/generator.ts（含 5.1.1 意图筛选层）
③ 搜索论文 → 入库               ✅ search/pipeline.ts
④ 内部变化 → 淘汰               ⏳ Phase 6
```

---

## 六、淘汰机制 — 让外部记忆保持新鲜

> Phase 6 技术设计。核心命题：外部记忆规模增长 → 必须有机制清理过时/低相关论文 → 保持导航效率和信噪比。
>
> 依赖：Phase 4 的关注方向图谱 + Phase 5 的主动检索入库

### 设计动机

Phase 5 引入主动检索后，外部论文库将从"被动 RSS 拉取"扩展为"主动搜索 + 被动拉取"双通道。论文增速提升意味着必须有反向机制：**淘汰不再相关的论文，保持知识库聚焦。**

淘汰不是"删除"，而是"降低可达性"——分级处理，保留恢复路径。

### 两种淘汰模式

#### 主动淘汰：兴趣迁移驱动

```
内部记忆重整完成
  → 对比重整前后的 graph.json 差异
  → 识别弱化方向（卡片数减少 ≥ 50%）和消失方向（节点被删除/合并）
  → 弱化/消失方向下的论文生成淘汰建议
  → 按级别执行淘汰
```

**触发时机**：内部记忆重整（Phase 4.4）完成后自动执行。

#### 被动淘汰：规模超限驱动

```
外部论文库 > maxPapers（默认 10000）
  → 计算每篇论文的综合得分
  → 按得分升序排序
  → 清理排名最低的论文（清理数 = 超限数 + 10% buffer）
```

**综合得分计算**：

| 指标 | 权重 | 说明 |
|------|------|------|
| 与当前关注方向的相关度 | 0.5 | 论文所在节点是否在 `current-focus.json` 的活跃列表中 |
| 导航命中次数 | 0.3 | 从 `signals.json` 统计被 read action 访问的次数 |
| 入库时间衰减 | 0.2 | 越旧得分越低 |
| 主动淘汰标记 | -1.0 | 已被主动淘汰标记的论文直接降权 |

### 三级淘汰

| 级别 | 操作 | 效果 | 可逆性 |
|------|------|------|--------|
| **第一级** | 从 `graph.json` 节点的 `items[]` 移除 | 导航不可见，卡片文件保留 | ✅ 完全可逆 |
| **第二级** | 卡片文件移到 `cards/archive/` | 释放 graph 空间，卡片仍可恢复 | ✅ 可逆 |
| **第三级** | 物理删除 `cards/archive/` 中的文件 | 永久删除 | ❌ 不可逆 |

**默认策略**：第三级默认不执行，需用户显式配置开启。

### 淘汰建议的透明度

每条淘汰建议包含：
- 论文 ID 和标题
- 淘汰原因（"近 30 天未关注此方向"、"节点已合并"、"规模超限排名最低"）
- 建议级别（第一/二/三级）
- 可通过 `--dry-run` 预览淘汰列表，确认后再执行

### 新增文件清单

| 文件 | 职责 |
|------|------|
| `src/elimination/comparer.ts` | 对比重整前后图谱差异，识别弱化/消失方向 |
| `src/elimination/score.ts` | 计算论文综合得分 |
| `src/elimination/apply.ts` | 执行淘汰操作（三级分级 + undo 恢复） |

---

## 七、主动 Briefing — 从信息处理到信息推送

> Phase 7 技术设计。核心命题：系统不仅能按需导航，还能主动推送个性化论文推荐。
>
> 依赖：Phase 4 关注方向 + Phase 5 主动检索 + semantic-navigator 导航能力

### 设计动机

Phase 1-6 实现了完整的"信息入库 → 组织 → 导航 → 淘汰"循环，但用户仍需主动发起查询。**核心问题**：如何让系统**主动推送**匹配的论文？

**答案**：定时触发，读内部记忆（关注方向）+ 导航外部记忆（论文库）→ LLM 生成个性化推荐 → 推送到用户。

### 架构总览

```
cron 定时触发（每日一次）
  │
  ├── 读 current-focus.json（当前关注方向）
  ├── 对每个活跃方向，调用 semantic-navigator
  │     explore → read（最近论文，limit=20）
  │
  ├── LLM 生成推荐
  │     输入：关注方向 + 候选论文列表
  │     输出：3-5 篇推荐 + 推荐理由（每篇 2-3 句话）
  │
  ├── 格式化 → briefing/YYYY-MM-DD.md
  └── 推送 → OpenClaw 消息 API / 飞书 webhook
```

### 关键设计决策

#### 1. 推荐生成 Prompt

```
输入：
  - 用户当前关注方向（来自 current-focus.json）
  - 每个方向的近期论文候选集（按日期排序，最多 20 篇/方向）

输出：
  3-5 篇推荐论文，每篇包含：
  - 论文标题 + 链接
  - 推荐理由（2-3 句话，需关联具体的关注方向）
  - 核心贡献概述
```

**去重**：日间推荐去重——检查最近 7 天的 briefing 文件，跳过已推荐过的论文。

#### 2. 推送通道优先级

1. **OpenClaw 消息 API**（首选）：集成度最高，直接在对话中推送
2. **飞书 webhook**（备用）：如果 OpenClaw 不支持 Plugin 推送消息

#### 3. Briefing 格式

```markdown
# 论文日报 — 2026-03-08

## 推荐论文

### 1. {论文标题}
**推荐理由**: 因为你在关注 {关注方向}，这篇论文提出了...
**核心贡献**: ...
**链接**: {url}

### 2. ...

---
*基于你的 {N} 个关注方向生成 | 论文库 {M} 篇 | 生成时间: {timestamp}*
```

### 新增文件清单

| 文件 | 职责 |
|------|------|
| `src/briefing/generator.ts` | 读内部记忆 + 导航外部记忆 → LLM 生成推荐 |
| `src/briefing/pusher.ts` | 推送 briefing 到指定通道 |

### 与整体架构的关系

Briefing 是整个系统的**最终输出层**，汇聚了所有前序 Phase 的能力：

```
Phase 1-3: 论文入库管道（RSS → 摘要卡 → 归类）
Phase R:   统一导航（semantic-navigator）
Phase 4:   内部记忆 → 关注方向图谱
Phase 5:   主动检索（扩充论文库）
Phase 6:   淘汰（保持聚焦）
Phase 7:   主动推送（从导航到推荐）
           ↑ 汇聚以上所有能力
```

---

_最后更新: 2026-03-08_
