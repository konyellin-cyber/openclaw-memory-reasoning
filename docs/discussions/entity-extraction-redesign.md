# 实体关联提取的设计讨论

> 起因：体验验收时发现 projects 提取存在两类误差（中英文重复、归属 vs 提及混淆）。  
> 核心质疑：之前提出的方案（canonical ID 去重、ownerProject 路径推导）都是规则补丁，不是基座可推理的优化。  
> 本文梳理当前流程，标注问题位置，讨论可能的改进方向。

---

## 一、当前完整流程图

```
                    ~/.openclaw/workspace/memory/*.md
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step A: 词典构建  (parser.ts → loadEntityDictionary)                 │
│                                                                      │
│  loadPeopleDictionary()                loadProjectDictionary()       │
│  ┌─────────────────────┐               ┌───────────────────────────┐ │
│  │ facts/work.md       │               │ projects/*.md             │ │
│  │                     │               │                           │ │
│  │ | 企微ID | 姓名 |   │               │ 文件名 → slug             │ │
│  │ | dreamtian | 田帅 | │               │   "communication-whitebox"│ │
│  │ | plancklin | 林康熠│               │                           │ │
│  │ → PersonEntry[]     │               │ 一级标题 → 中文名         │ │
│  └─────────────────────┘               │   "# 沟通白盒"            │ │
│                                        │ → string[]                │ │
│                                        │   ["communication-        │ │
│                                        │    whitebox",             │ │
│                                        │    "沟通白盒"]   ❌ 重复   │ │
│                                        └───────────────────────────┘ │
│  locationKeywords = ["周会","1v1","评审"...]  (硬编码)                │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                           EntityDictionary
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step B: 实体拆分  (parser.ts → parseMemoryFile)                      │
│                                                                      │
│  遍历 .md 文件，按 ##/###/#### 拆分 section                          │
│  ├─ detectEntityType(title, path)  → decision|insight|log|...        │
│  ├─ parseDateFromTitle()           → 日期提取                        │
│  └─ finalizeEntity()               → MemoryEntity                   │
│       ├─ extractTags()              → 高频中文词                     │
│       ├─ extractPeople(text, dict)  → 词典匹配企微ID/姓名           │
│       ├─ extractProjects(text, dict)→ text.includes(name) ❌ 不区分  │
│       │                                归属 vs 提及                  │
│       └─ extractLocations()         → 场景关键词匹配                │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                          MemoryEntity[]
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Step C: 全量构建索引  (index-builder.ts → buildMemoryIndex)           │
│                                                                      │
│  创建 seed 图: root → decisions|insights|daily-log|projects|...      │
│  遍历实体 → entityToCard(entity)                                     │
│    ├─ generateOneLiner()   → 截取前200字（非LLM）                    │
│    ├─ generateQualitySignal() → 按type硬编码标签                     │
│    └─ deriveRelatedEntities()                                        │
│         entity.people   → card.people   + relatedEntities["person:x"]│
│         entity.projects → card.projects + relatedEntities["project:x"]│
│  saveCard() → cards/{id}.json                                        │
│  saveGraph() → graph.json                                            │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                  memory-index/knowledge/
                  ├── graph.json
                  └── cards/*.json
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
┌──────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│ Step D: LLM 增强 │  │ Step E: LLM 重整   │  │ Step F: 快照/导航  │
│ (summarizer.ts)  │  │ (reorganizer.ts)   │  │ (export/navigate)  │
│                  │  │                    │  │                    │
│ 读卡片+原始.md   │  │ 读某节点下所有卡片  │  │ 聚合 topPeople/    │
│ → LLM 改写      │  │ → Stage1: LLM 定义 │  │   topProjects      │
│   title/oneLiner │  │   子节点           │  │ 导航时展示卡片     │
│   tags/quality   │  │ → Stage2: LLM 批量 │  │   的 projects 字段 │
│                  │  │   归类到子节点      │  │                    │
│ ⚠️ 不修改       │  │                    │  │ ⚠️ 直接消费        │
│   people/projects│  │ ⚠️ prompt 中展示   │  │   parser 的结果    │
│   字段           │  │   people 辅助归类   │  │                    │
└──────────────────┘  └────────────────────┘  └────────────────────┘
```

---

## 二、问题标注

### 问题 1: 项目词典的中英文重复（位于 Step A）

```
loadProjectDictionary()
  文件名: communication-whitebox.md → "communication-whitebox"
  一级标题: # 沟通白盒              → "沟通白盒"

两者是同一个项目的两个表面形式，但词典视为两个独立字符串。
```

**下游影响**：Step B 的 `extractProjects()` 分别命中两个字符串，输出 `projects: ["communication-whitebox", "沟通白盒"]`。

### 问题 2: 不区分"归属"与"提及"（位于 Step B）

```
extractProjects(title, content, dictionary)
  对每个项目名: text.toLowerCase().includes(name.toLowerCase())
  命中即加入 projects[]

"加热池机制门槛优化" 来源于 projects/sticker-author-satisfaction.md
  → 内容末尾有一行引用了"沟通白盒"的链接
  → 匹配到 ["communication-whitebox", "沟通白盒"]
  → 没匹配到 "sticker-author-satisfaction"（因为原文没有逐字出现这个slug）
```

**结果**：卡片关联到了"被提及的项目"而非"所属项目"。

### 设计原则审视

回到 technical-design.md 的判断标准：**谁在做决策？**

| 环节 | 当前实现 | 决策者 | 是否符合原则 |
|------|---------|--------|-------------|
| 词典构建 | 从文件名+标题提取 → string[] | 系统 | — （数据准备，不涉及判断） |
| 项目匹配 | `includes()` 命中即关联 | **系统**（字符串匹配） | ❌ 系统在做"关联判断" |
| 去重 | 不去重 | 系统（没做） | ❌ 系统缺失应有的规范化 |
| 归属 vs 提及 | 不区分 | 系统（没做） | ❌ 系统缺失应有的语义判断 |

---

## 三、之前提出的方案为什么不对

### 方案 A: canonical ID + alias 列表

```typescript
interface ProjectEntry {
  canonicalId: string;    // "communication-whitebox"
  aliases: string[];      // ["communication-whitebox", "沟通白盒"]
}
```

**问题**：这是用更精细的数据结构来让**系统**做去重。去重判断（"这两个是同一个项目"）仍然是硬编码规则（文件名=标题），不是基座推理。

### 方案 B: ownerProject 从路径推导

```
卡片来自 projects/sticker-author-satisfaction.md
  → ownerProject = "sticker-author-satisfaction"
```

**问题**：这是用路径规则让**系统**判断归属。"这张卡片属于这个项目"的判断来自文件路径，不是来自对内容的理解。

**两个方案的共同问题**：都是在 Step A / Step B 加规则，让系统做更多判断。但设计原则说的是：**匹配和判断应该由 LLM 做，系统只做数据导航。**

---

## 四、重新定位问题

核心矛盾：

```
实体关联提取（"这段内容和哪个项目相关"）
  = 语义理解任务
  = 应该由基座做

但当前在 parser 阶段（离线批处理几百个section）
  = 逐条调 LLM 成本太高
  = 所以用了规则 fallback
```

这不是"规则写得不好"的问题，是**这件事放错了位置**。

---

## 五、讨论方向

### 方向 1: parser 提取定位为"粗信号"，重整时 LLM 批量修正

```
当前:
  parser → projects[] (确定性标签) → 直接作为最终结果消费

改为:
  parser → candidateProjects[] (粗信号，可能有误) → 等重整时由 LLM 审视修正
```

**在流程图中的位置**：不改 Step A/B，在 Step E（重整）中增加"实体关联修正"环节。

```
Step E 重整时 LLM 的输入（已有）:
  - 节点下所有卡片的 title + tags + people + projects

新增 LLM 任务:
  - 审视每张卡片的 projects 是否合理
  - 发现同义项（"沟通白盒" = "communication-whitebox"）
  - 修正错误关联
```

**优点**：
- 符合"入库时粗归，重整时精调"的已有共识
- LLM 一次读几十张卡片做批量判断，成本可控（不是逐条调用）
- 修正质量随基座加强而加强

**缺点**：
- 在重整之前（首次构建后到第一次重整之间），关联数据是不准的
- 重整的频率可能不够快（当前是手动触发）

### 方向 2: 根本不在卡片上存 projects[]，让路标图的拓扑结构来表达关联

```
当前:
  卡片.projects = ["communication-whitebox", "沟通白盒"]
  → 通过卡片元数据来表达"和哪个项目相关"

改为:
  卡片没有 projects 字段
  卡片归属于图中的节点
  节点本身有语义描述（路标）
  "这张卡片和什么相关" = "这张卡片在哪个节点下" + "这个节点的路标描述是什么"
```

**在流程图中的位置**：去掉 Step A 中的 `loadProjectDictionary()`，去掉 Step B 中的 `extractProjects()`，卡片不再有 `projects` 字段。

**这和路标系统的核心设计一致**：
- 知识路标中，论文不需要单独标注"属于哪个研究领域"——它在哪个节点下，就和那个方向相关
- 内部记忆卡片也应如此——它在哪个节点下，就和那个主题相关
- 跨主题关联通过**节点的边**来表达，不需要在卡片上冗余存储

**但 people 不同**：
- 人物是**实体级别**的关联——"这段内容提到了谁"是内容本身的属性
- 人物查询模式是"给我某人相关的所有内容"——需要从卡片维度检索
- 节点拓扑不适合表达人物关联（一个人跨很多节点）

所以可能的分化是：
- **人物** → 保留卡片级 `people[]`，词典匹配足够准确（人名/企微ID是稳定的标识符）
- **项目** → 去掉卡片级 `projects[]`，由节点归属来表达

**优点**：
- 最"干净"，完全消除了系统做项目关联判断
- 和路标系统的设计哲学一致

**缺点**：
- 跨项目关联能力弱化（一张卡片只能在一个/少数几个节点）
- 但路标的多归属（同一卡片被多个节点引用）+ 边 可以部分弥补

### 方向 3: 保留 projects[] 但改为 LLM 生成（在 summarizer 中一并处理）

```
当前 summarizer 做的:
  LLM 生成增强版 {title, oneLiner, tags, qualitySignal}

扩展为:
  LLM 生成增强版 {title, oneLiner, tags, qualitySignal, projects, people}
```

**在流程图中的位置**：Step D（summarizer）扩展输出字段。

**优点**：
- projects 和 people 都由 LLM 从内容中推理，不依赖词典
- 已有 LLM 调用管道，增加字段不增加调用次数

**缺点**：
- 仍然是"对每张卡片逐一调 LLM"——规模大时成本高
- LLM 不一定知道项目词典（需要在 prompt 中提供项目列表作为 context）
- 本质上是"让 LLM 做规则本来该做的事"——如果词典匹配能准确做到，就不应该浪费 LLM

---

## 六、讨论结论

### 核心决策：大幅精简卡片 schema

讨论中发现原有卡片字段过多，大量字段含义模糊或由不可靠的规则系统填充。
核心原则：**卡片上每个字段都必须有明确的存在理由，否则不该存在。**

关联关系（项目、标签、场景）不在卡片上冗余——**交给图拓扑表达**。

### 砍掉的字段及理由

| 砍掉的字段 | 原来做什么 | 为什么砍 |
|---|---|---|
| `tags` | parser 粗提取 + summarizer LLM 再生成一版 | 语义模糊，两套来源谁也不精准；标签能力应由图拓扑和向量检索承担 |
| `projects` | 规则匹配项目名 | 规则匹配不可靠（中英文重复、归属 vs 提及混淆）；项目关联由卡片在图中的节点位置表达 |
| `locations` | 关键词匹配场景 | 实际几乎没用，场景太少 |
| `relatedEntities` | 由 people + projects 拼接 | 上游不准它也不准 |
| `qualitySignal` | LLM 生成的质量评分 | 下游未实际消费 |
| `type` / `entityType` | 硬编码类型分类 | 类型应由图拓扑的节点归属表达，不需要卡片自带 |
| `url` | 链接 | source 字段已承载溯源 |
| `generatedAt` | 摘要卡生成时间 | 非核心元数据 |

### 精简后的最小 schema

```typescript
// MemoryEntity（中间态，不持久化）
interface MemoryEntity {
  id: string;             // 唯一寻址，下游所有引用的锚点
  content: string;        // LLM summarizer 的输入原料
  sourceFile: string;     // 溯源：找到原始 markdown 位置
  sourceLine: number;     // 溯源：精确到行，支持跳转
  date?: string;          // 时间轴排序、衰减计算的依据
  level: number;          // 标题层级，决定拆分粒度和父子关系
}

// ContentCard（持久化）
interface ContentCard {
  id: string;             // 唯一寻址，图节点的 key
  title: string;          // LLM 生成，导航时的可读标识
  oneLiner: string;       // LLM 生成，检索命中后的快速预览，避免回读原文
  people: string[];       // 人物关联，支持"某人相关的所有记忆"查询
  source: string;         // 溯源：回到原始文件
  date: string;           // 时间轴排序、新旧判断、衰减权重
}
```

### 设计原则

1. **每个字段必须回答"它为什么必须存在"**——不能回答就不该留
2. **卡片只承载确定性字段**——事实性元数据（谁、何时、出处）+ LLM 语义摘要（说了什么）
3. **所有关联关系交给图拓扑**——项目归属、主题分类、标签等由卡片在图中的位置表达
4. **people 保留在卡片上的理由**：人物是明确实体，词典匹配准确率高（人名/企微ID 是稳定标识符），且查询模式要求从卡片维度检索（"某人相关的所有内容"），节点拓扑不适合表达人物关联（一个人跨很多节点）

### 实施 Checklist

**Step A: 词典构建**
- [ ] 删除 `loadProjectDictionary()`
- [ ] 删除 `locationKeywords` 硬编码列表
- [ ] `EntityDictionary` 类型精简——只保留 people 相关字段

**Step B: 实体拆分**
- [ ] 删除 `extractTags()`
- [ ] 删除 `extractProjects()`
- [ ] 删除 `extractLocations()`
- [ ] 删除 `detectEntityType()`
- [ ] `MemoryEntity` 接口精简为最小 schema（id / content / sourceFile / sourceLine / date / level）

**Step C: 索引构建**
- [ ] 删除 `deriveRelatedEntities()`
- [ ] 删除 `generateQualitySignal()`
- [ ] `entityToCard()` 只输出最小 ContentCard（id / title / oneLiner / people / source / date）

**Step D: LLM 增强 (summarizer)**
- [ ] prompt 精简——只要求生成 title + oneLiner
- [ ] 删除 tags / qualitySignal 的生成和解析逻辑

**Step F: 导航/快照**
- [ ] 删除 topProjects 聚合逻辑
- [ ] 确认 topPeople 聚合仍正常工作

**类型定义**
- [ ] 更新 `MemoryEntity` interface
- [ ] 更新 `ContentCard` interface
- [ ] 清理所有引用已删除字段的下游代码

### 结论已同步到 technical-design.md

第二章"实体关联属性的提取策略"和"路标自描述字段"已更新，反映精简后的 schema。

---

_创建时间: 2026-03-07_  
_状态: ✅ 已结论_
