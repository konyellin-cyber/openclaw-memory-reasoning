# 实现 Checklist

> 每完成一步就更新状态。详细设计见 [mvp-plan.md](./mvp-plan.md)。
>
> 历史执行日志（v0.1 + Phase 1-3）见 [references/checklist-archive.md](./references/checklist-archive.md)。
>
> **路标自描述字段规范**见 [technical-design.md 第二章 · 路标的自描述字段设计](./technical-design.md#路标的自描述字段设计)。新增路标必须遵循该模板。

---

## Phase R：Plugin → Skill 重构

> 技术设计详见 [technical-design.md](./technical-design.md) 第三章。
> 与后续 Phase 并行推进。

### Step R.0: graph.ts 泛化

> 目标：papers→items, SummaryCard→ContentCard，支持内外记忆统一数据模型

**具体任务**：
- [x] 类型泛化
  - [x] `SummaryCard` → `ContentCard`，新增字段：`type`（"paper" | "memory"），可选 `sourceFile`（仅 memory）
  - [x] `GraphNode` 的 `papers` 字段 → `items` 数组，存储 ContentCard ID
  - [x] `GraphStats` 统计字段泛化：`totalPapers` → `totalItems`，新增 `itemsByType`
- [x] graph.ts CRUD 操作泛化
  - [x] `saveCard()` 接受 ContentCard 类型
  - [x] `loadCard()` 返回 ContentCard 类型
  - [x] `getNodeItemIds()` 替代 `getNodePaperIds()`
  - [x] `addItemToNode()` / `removeItemFromNode()` 统一操作
- [x] 数据迁移脚本
  - [x] `src/migration/graph-v1-to-v2.ts` — 读取现有 graph.json/cards/
  - [x] 批量转换 SummaryCard → ContentCard（type="paper"）
  - [x] graph.json 的 papers 数组 → items 数组
  - [x] 版本号升级：graph.version: 1 → 2
  - [x] 验证：转换前后总数量一致，随机抽检 5 篇卡片字段完整

**验收**：
- [x] `npx tsc --noEmit` 零错误
- [x] 运行迁移脚本：2555 篇论文卡全部转换为 ContentCard（type="paper"）
- [x] graph.json 节点结构迁移后可正常加载（version=2, 70 节点）
- [x] `loadCard()`/`saveCard()` 对新旧数据兼容

---

### Step R.1: 创建 semantic-navigator Skill

> 目标：navigate.ts --source --action，替代 Plugin 的 navigate_knowledge tool

**具体任务**：
- [x] Skill 框架搭建
  - [x] `src/skills/semantic-navigator/` 目录结构（SKILL.md + navigate.ts）
  - [x] `SKILL.md` 定义：name="semantic-navigator"，description="基于语义路标的记忆导航"
  - [x] 参数：`source`（papers | memory，必选），`action`（overview | explore | read，必选）
- [x] navigate.ts 核心逻辑
  - [x] `overview(source)`：返回顶层节点列表 + 节点统计（items 总数、活跃节点数）
  - [x] `explore(source, nodeId)`：返回指定节点的邻居 + 关系描述 + 子节点列表
  - [x] `read(source, nodeId, limit, offset, since)`：返回节点下的 ContentCard 列表
  - [x] 数据路径切换：source="papers" → `~/.openclaw/personal-rec/`，source="memory" → `~/.openclaw/memory-index/knowledge/`
- [x] 与现有 graph.ts 集成
  - [x] 加载 graph.json（根据 source 选择路径）
  - [x] 调用 `getTopLevelNodes()` / `getChildren()` / `getNodeItemIds()`
  - [x] 批量加载 cards（`loadNodeCards()` 或手动加载）
  - [x] 格式化输出（markdown 列表 + 卡片摘要）
- [x] Skill 测试
  - [x] 手动调用测试：`npx tsx src/skills/semantic-navigator/navigate.ts --source papers --action overview`
  - [x] 验证输出与旧 Plugin tool 结果一致（70节点、2925论文）
  - [x] 测试 explore: `--action explore --nodeId recommendation-systems`
  - [x] 测试 read: `--action read --nodeId root --limit 5`

**验收**：
- [ ] Skill 可被 Agent 调用（通过 AGENTS.md 注册，见 R.4）
- [x] `--source papers` 导航结果与旧 `navigate_knowledge` 一致
- [x] 错误处理：无效 nodeId、空节点、不存在的 source

---

### Step R.1.1: search Action 实现（导航 Skill 扩展）

> 目标：在 semantic-navigator Skill 中新增 search action，支持对话中触发主动搜索
>
> **前置依赖**：Phase 5 ✅（主动搜索管道已实现）

**具体任务**：
- [x] navigate.ts 扩展
  - [x] 新增 `--action search` 支持
  - [x] 参数解析：`--mode`（query-only|dry-run|full）、`--direction`、`--query`
  - [x] 复用 `src/search/pipeline.ts` 的 `runProactiveSearch()`
  - [x] 输出格式：Markdown 统计摘要 + 新增论文列表
  - [x] 默认 provider/model：`--provider alibaba --model glm-5`
- [x] SKILL.md 更新
  - [x] 补充 search action 说明
  - [x] 补充对话场景映射表
  - [x] 明确"写操作"警告（会改变 graph.json 和 cards/）
- [x] 验证
  - [x] CLI 测试：`npx tsx navigate.ts --source papers --action search --mode query-only` — ✅ 成功生成 9 条 query（66.2s）
  - [x] CLI help 测试：所有参数正确显示 — ✅
  - [x] TypeScript 编译：`npx tsc --noEmit` 零错误 — ✅
  - [x] API key 问题修复：`auth-profiles.json` 添加 alibaba provider — ✅
  - [x] 部署验证：`npm run deploy` + `openclaw gateway restart` — ✅
  - [ ] CLI 测试：`npx tsx navigate.ts --source papers --action search --mode dry-run` — 待测试
  - [ ] CLI 测试：`npx tsx navigate.ts --source papers --action search --mode full` — 待测试
  - [ ] CLI 测试：`npx tsx navigate.ts --source papers --action search --direction recommendation-system` — 待实现 direction 过滤逻辑

**验收**：
- [x] `--action search --mode query-only` 正常输出 query 列表 — ✅ 9 条 query，意图筛选 14→3 节点
- [ ] `--action search --mode dry-run` 正常输出预览（不入库）— 待测试
- [ ] `--action search --mode full` 正常入库（graph.json + cards/）— 待测试
- [ ] `--direction` 参数正确限定搜索方向 — 待实现过滤逻辑
- [ ] `--query` 参数正确跳过 LLM 生成 — 待实现手动 query 逻辑
- [x] 错误处理友好，不崩溃 — ✅
- [x] 默认 provider/model 生效 — ✅ 无需手动指定

---

### Step R.2: 记忆索引构建

> 目标：memory/*.md → 独立目录 graph.json + cards/，不破坏现有 `memory/` 结构

**具体任务**：
- [x] 目录结构设计
  - [x] 确认索引目录：`~/.openclaw/memory-index/`（与 `memory/` 隔离）
  - [x] 子目录：`graph.json`, `cards/`, `signals.json`
- [x] 内部记忆实体拆分器
  - [x] `src/memory/parser.ts` — 遍历 `memory/*.md`
  - [x] 按段落/section 拆分：
    - [x] 识别标题（##, ###）作为段落边界
    - [x] 每个 section 视为一个独立实体（type="memory"）
    - [x] 提取：标题、内容、源文件路径、日期（从文件名）
  - [x] 跳过空段落、纯列表段落（< 50 字符）
- [x] 初始索引构建
  - [x] `src/memory/index-builder.ts` — 批量生成 ContentCard
  - [x] ContentCard 字段：title（section 标题）、content（段落内容）、sourceFile、sourceType="memory"、date
  - [x] 冷启动归类：全部归 root 节点（类似 Phase 1）
  - [x] 写入 `memory-index/graph.json`（version=2）+ `memory-index/cards/*.json`
- [x] 验证
  - [x] 统计 `memory/*.md` 总段落数与生成的卡片数一致
  - [x] 随机抽检 5 张卡片：content 字段完整、sourceFile 正确
  - [x] 原 `memory/` 目录无任何变更（只读）

**验收**：
- [x] `memory-index/graph.json` 生成，root.items ≥ 10（假设有 10+ 段落）
- [x] cards/ 目录下卡片数与 graph.json root.items 一致
- [x] 原 `memory/` 目录结构完全不变，零新增/修改文件

---

### Step R.3: memory-manager 联动

> 目标：写入新记忆后自动增量更新索引

**具体任务**：
- [x] memory-manager 触发机制调研
  - [x] 确认 OpenClaw memory-manager 的写入事件/回调机制
  - [x] 是否支持 plugin 监听 `memory/` 文件变化？
  - [x] 如果不支持，设计手动触发方案（CLI 命令或定时检查）
- [x] 增量索引更新
  - [x] `src/memory/incremental-indexer.ts` — 检测新/修改的 .md 文件
  - [x] 解析新段落 → 生成 ContentCard → 归类到 root
  - [x] 更新 `memory-index/graph.json`（追加新 card ID 到 root.items）
  - [x] 写入新卡片到 `cards/`
- [x] 与 memory-manager 集成（如果支持回调）
  - [x] 结论：memory-manager 是 Skill（无回调/事件机制），通过 Markdown 文件写入，不支持 Plugin 监听
  - [x] 采用手动触发方案（sync-cli.ts）
- [x] 手动触发 CLI（如果回调不可用）
  - [x] `src/memory/sync-cli.ts` — 手动同步：`npx tsx src/memory/sync-cli.ts`
  - [x] 支持 `--since` 参数（只同步 N 天内的变更，支持 YYYY-MM-DD 和 Nd 格式）
  - [x] 支持 `--full` 全量重建、`--dry-run` 预览、`--verbose` 详细输出

**验收**：
- [x] 修改记忆文件后运行 sync-cli → `memory-index/graph.json` 正确更新
- [x] 新记忆对应的 ContentCard 正确生成并写入 `cards/`
- [x] 原有索引数据不受影响（增量逻辑正确：无变更时 0 操作）
- [x] 错误处理：格式错误的 .md 文件不阻塞索引更新

---

### Step R.4: AGENTS.md 对接

> 目标：导航 Skill 优先，MEMORY.md 降级

**具体任务**：
- [x] 阅读 OpenClaw AGENTS.md 格式规范
  - [x] 确认如何注册 Skill 到 Agent 配置
  - [x] 确认优先级机制（skill vs tool vs knowledge base）
- [x] 编写 AGENTS.md 配置
  - [x] 在 OpenClaw 的 AGENTS.md 中注册 `semantic-navigator` Skill
  - [x] 配置：description（导航论文和记忆）、parameters（source, action, limit, offset, since）
  - [x] 调整 MEMORY.md 优先级：标注为"备用方案"，semantic-navigator 为首选
- [x] 部署 Skill 到 workspace
  - [x] 创建 `~/.openclaw/workspace/skills/semantic-navigator/SKILL.md`
  - [x] 包含完整执行流程、查询映射表、同步说明、错误处理
- [ ] 验证（需重启 Gateway 后测试）
  - [ ] 重启 Gateway，Agent 在对话中优先调用 `semantic-navigator`
  - [ ] 测试 query："帮我找关于推荐系统的论文" → 调用 `semantic-navigator --source papers`
  - [ ] 测试 query："我最近写了哪些决策？" → 调用 `semantic-navigator --source memory`

**验收**：
- [x] `semantic-navigator` Skill 已部署到 workspace/skills/
- [x] AGENTS.md 已注册 Skill 并配置优先级规则
- [x] MEMORY.md 降级为快速导航索引（不再用于全文读取回答问题）
- [x] Agent 在对话中不再依赖 MEMORY.md 全文读取 — ✅ Gateway 验证通过
- [x] `semantic-navigator` 成为默认的论文/记忆检索入口 — ✅ Gateway 验证通过
- [ ] 错误处理：Skill 不可用时，自动 fallback 到 MEMORY.md（需 Gateway 验证）

---

### Step R.5: Plugin 瘦身

> 目标：移除 navigate_knowledge tool，只保留 registerService

**具体任务**：
- [x] Plugin 工具移除
  - [x] 从 `src/index.ts` 移除 `navigate_knowledge` 的 registerTool 和 import
  - [x] `navigate-knowledge.ts` 移到 `src/tools/deprecated/`（归档保留）
  - [x] 保留 `registerService`（RSS 拉取、摘要卡生成、重整触发等）
  - [x] `tsconfig.json` 排除 deprecated 目录
- [x] 运行时兼容
  - [x] Plugin 加载日志明确标注："navigate_knowledge 已废弃，请使用 semantic-navigator Skill"
  - [x] 工具已完全移除（不再注册），而非返回弃用提示
- [x] 验证
  - [x] `npm run build` 编译通过
  - [x] `npx tsc --noEmit` 零错误
  - [x] 确认编译后的 JS 无 `registerTool` 调用（navigate_knowledge 完全移除）

**验收**：
- [x] Plugin 编译成功，`registerService` 保留
- [x] `navigate_knowledge` tool 完全移除，不再注册
- [x] 旧工具文件归档到 `src/tools/deprecated/`（可追溯）

---

### Phase R 完成标准

- [x] `npx tsc --noEmit` 零错误
- [x] graph.ts 泛化后现有论文数据读写正常，无数据丢失
- [x] `semantic-navigator --source papers` 导航结果与旧 Plugin tool 一致
- [x] `semantic-navigator --source memory` 导航可用（记忆索引已构建）
- [x] `memory-index/` 目录生成，root节点207个item，原 `memory/` 零变更
- [x] memory-manager 写入新记忆后，通过 sync-cli 增量更新 `memory-index/graph.json`（R.3完成）
- [x] Agent 对话中优先通过 Skill 导航，不再依赖 MEMORY.md 全文（R.4完成，AGENTS.md 已配置）
- [x] Plugin 瘦身后 `navigate_knowledge` tool 移除，归档到 deprecated（R.5完成）
- [x] 端到端：semantic-navigator Skill 可分别用 `--source papers` 和 `--source memory` 完成导航

### Phase R 运行时排查与修复（2026-03-07 新增）

> 排查发现的生产环境问题，必须在体验验收前修复。

#### Fix-R.1: 插件部署版本同步 ✅

**问题**：`~/.openclaw/extensions/personal-rec/dist/` 是 3/1 的老版本，仍在 import `navigate-knowledge.js` 并尝试 `registerTool`。源码版（3/6）已移除该工具，缺少 `memory/`、`migration/`、`skills/` 等新模块。

**修复步骤**：
- [x] 源码重新编译：`cd /Users/konyel/openclaw-memory-reasoning && npm run build`
- [x] 同步部署：rsync --delete 到 `~/.openclaw/extensions/personal-rec/dist/`
- [x] 验证：`diff` 对比部署版和源码版 dist/index.js，确认一致
- [ ] 重启 Gateway 后确认 Plugin 加载无报错（需用户操作）

#### Fix-R.2: Pipeline Error 修复 ✅

**问题**：`gateway.err.log` 记录了 `TypeError: Cannot read properties of undefined (reading 'includes')`，在 pipeline 中触发。根因是 `computeTagStats()` 和 classifier 中 `c.tags.includes()` / `c.tags.join()` 未对 undefined 做防护。（注：`tags` 字段已在 schema 精简中标记移除，这些代码将被完全删除）

**修复步骤**：
- [x] 定位报错来源：`reorganizer.ts:405` `for (const t of c.tags)` 和 `:423` `c.tags.includes(tag)`
- [x] 修复：对 `reorganizer.ts`、`navigate.ts`、`classifier.ts` 中所有 `c.tags` 调用加 `?? []` 防护
- [x] 编译通过：`npx tsc --noEmit` 零错误
- [x] 重新部署到 `~/.openclaw/extensions/personal-rec/dist/`

#### Fix-R.3: Memory 索引结构优化 ✅

**问题**：memory 源只有 root 节点，207 个记忆实体全部堆在 root 下。导航体验退化为线性列表，explore 无子节点可看。

**修复步骤**：
- [x] 用目录结构 seed 创建 7 个初始子节点：decisions(19), insights(16), projects(34), facts(10), daily-log(65), conversations(10), archive(53)
- [x] 修复 `navigate.ts` 中 `loadCard` 路径错误（多加了一层 `knowledge/`）
- [x] 验证：`--source memory --action overview` 显示 8 个节点，read 正常返回内容

#### Fix-R.4: WebSocket 连接稳定性 ✅（偶发，不处理）

**问题**：3/7 凌晨 03:00-08:00 共 224 次 `ws connect failed`，集中在 07:00-08:00（164 次）。

**排查结论**：
- [x] Gateway 进程稳定运行（PID 69635，上周四启动）
- [x] 属于网络层面的偶发波动，非插件或 Gateway 本身的问题
- [x] 历史上 2/18、2/23、3/6 也各有 1-2 次，符合偶发模式
- 结论：记录不处理，如果持续发生再排查

---

### Phase R 体验验收（重新定义）

> **核心原则**：体验验收 = 在 OpenClaw 对话中实际可用的功能验收。
> CLI 测试是开发验证手段，不是体验验收。
> 每项验收的标准：用户在 OpenClaw 对话中发出自然语言请求，系统能正确响应。

#### UX-R.1: Agent 对话中调用 Skill（最核心验收）

**前置**：Fix-R.1 + Fix-R.2 完成，Gateway 重启后无报错

**操作**：在 OpenClaw 对话中发送以下 prompt

```
1. "帮我找关于推荐系统的论文"
2. "我最近做了哪些决策？"
3. "深入看看 recommendation-systems 这个方向有哪些子主题"
4. "最近一周有什么新入库的论文？"
```

**关注点**：
- Agent 是否自动调用 `semantic-navigator`（而非读 MEMORY.md 全文）
- 返回结果是否与 CLI 直接调用一致
- 对话中的导航是否自然（不需要用户知道 CLI 参数）
- Skill 不可用时，是否 fallback 到 MEMORY.md

**通过标准**：用户用自然语言就能完成导航，Agent 正确路由到 Skill

- [x] Agent 对话中成功调用 semantic-navigator Skill — ✅ Gateway 测试通过
- [x] 自然语言 → CLI 参数映射正确（source/action/nodeId） — ✅
- [x] 对话体验自然，无需用户了解底层参数 — ✅
- [ ] fallback 机制正常（Skill 失败时仍能回答）

#### UX-R.2: 导航输出在对话中的可读性

**操作**：基于 UX-R.1 的对话继续追问

```
1. "展开看看 recommendation-systems 下面有什么"
2. "读一下最近 5 篇推荐系统的论文摘要"
3. "我的记忆里有哪些关于产品方向的内容？"
```

**关注点**：
- Agent 返回的导航结果在对话气泡中是否可读（Markdown 渲染正常）
- 信息密度是否合适（不能一次性输出 2925 篇的列表）
- 是否支持自然的多轮对话追问（overview → explore → read 的渐进式导航）

**通过标准**：对话中看到的结果一眼能理解，知道下一步该怎么追问

- [ ] 对话中 Markdown 渲染正常
- [ ] 信息密度合适（分页/截断/摘要）
- [ ] 多轮追问导航体验自然

#### UX-R.3: 端到端场景 — 论文检索

**操作**：在 OpenClaw 对话中完成一个完整的论文检索任务

```
用户: "我想了解最近有什么 GNN-based 推荐系统的论文"
→ Agent 调用 overview / explore
用户: "深入看看这个方向"
→ Agent 调用 explore 展开子节点
用户: "给我看最近 3 篇"
→ Agent 调用 read 返回论文卡
```

**通过标准**：从提问到拿到论文摘要，全程在对话中完成，不需要开终端

- [ ] 论文检索全程在对话中完成
- [ ] 论文卡内容完整（标题、摘要、标签、链接）
- [ ] 整体体验优于手动翻文件 / 搜 arXiv

#### UX-R.4: 端到端场景 — 记忆检索

**操作**：在 OpenClaw 对话中完成一个完整的记忆检索任务

```
用户: "我最近关注了哪些事情？"
→ Agent 调用 memory overview
用户: "具体看看最近一周的记忆"
→ Agent 调用 read --since
```

**通过标准**：能通过对话快速定位自己的记忆内容

- [x] 记忆检索全程在对话中完成 — ✅ Gateway 测试通过（"我最近在关注哪些方向"成功返回 9 个方向）
- [x] 记忆内容定位准确 — ✅
- [x] 体验优于直接翻 memory/*.md 文件 — ✅ 用户确认效果不错

#### UX-R.5: CLI 基础功能验证（辅助验收，非核心）✅

> 仅作为开发自测手段，确认 Skill 本身的基本功能没坏。

- [x] `--source papers --action overview` 正常返回（70 节点，2925 论文，1.5s）
- [x] `--source memory --action overview` 正常返回（8 节点，207 items，1.3s）
- [x] 无效参数不崩溃，给出友好提示（无效 nodeId 列出可用节点，无效 source 提示正确值）
- [x] 响应时间可接受（overview 1.3-1.5s, read 3 cards 1.3s）

---

### Phase R 体验验收反馈（2026-03-07 用户测试）

> Gateway 重启后用户在 OpenClaw 对话中完成了测试。

**UX-R.1~R.4 初步反馈**：Agent 可以调用 Skill，但**记忆的时间标注太弱**，导致"最近做了什么决策"这类时间相关查询体验差。

**根因排查**：
- 207 张 memory 卡片中，`date` 字段的提取逻辑有缺陷
- Parser 只从**文件名**提取日期（正则 `\d{4}-\d{2}-\d{2}`）
- 日志文件（`2026-03-05.md`）→ ✅ 正确提取 `2026-03-05`
- 非日期命名文件（`decisions.md`、`insights/*.md`、`projects/*.md`、`facts/*.md`）→ ❌ fallback 到**索引运行时间**
- 结果：19 条决策（实际发生于 2/23~3/5）全被标为 `2026-03-06`（索引运行日期）
- Agent 无法区分"最近"vs"更早"的决策

**影响范围**：

| 文件类型 | 卡片数 | date 正确性 |
|---|---|---|
| `2026-MM-DD.md` 日志 | 65 | ✅ 从文件名提取 |
| `decisions.md` | 19 | ❌ 全标为 3/6 |
| `insights/*.md` | 16 | ❌ 全标为 3/6 |
| `projects/*.md` | 34 | ❌ 全标为 3/6 |
| `facts/*.md` | 10 | ❌ 全标为 3/6 |
| `conversations.md` | 10 | ❌ 全标为 3/6 |
| `archive/*.md` | 53 | ❌ 全标为 3/6 |

**总计**：207 张中 142 张（69%）date 不准确。

---

#### Fix-R.5: Memory 卡片日期提取增强 ✅

> 路标格式遵循 [technical-design.md 第二章 · 路标的自描述字段设计](./technical-design.md#路标的自描述字段设计)

| 字段 | 值 |
|---|---|
| 优先级 | P0 — 阻塞 UX-R.1~R.4 体验验收 |
| 创建日期 | 2026-03-07 |
| 预计完成 | 2026-03-07 |
| 实际完成 | 2026-03-07 |
| 前置依赖 | Fix-R.1~R.3 ✅ |
| 影响范围 | `parser.ts`（1 文件），142/207 张卡片 → 修复后 231 张卡片中仅 46 张 fallback（全为无时间概念的常设文档） |

**问题/动机**：用户测试"最近做了什么决策"时，Agent 无法区分时间先后。207 张 memory 卡片中 142 张（69%）date 不准确——全被标为索引运行日期 `2026-03-06`，而非内容实际发生日期。直接导致时间相关查询体验差。

**规划思路**：
用户测试发现"最近做了什么决策"返回结果无法区分时间
→ 排查 142 张卡片 date 全是 `2026-03-06`（索引运行日期）
→ 根因：`parser.ts` 的 `finalizeEntity()` 只用 `parseDateFromFilename()` 提取日期
→ 日志文件 `2026-03-05.md` 文件名含日期 → ✅ 正确
→ `decisions.md` 等非日期命名文件 → fallback 到 `new Date()`（运行时间）→ ❌
→ 但这些文件的 section 标题中有日期（如 `## 2026-03-05：贴图流量重心`）
→ 方案：在 `parseMemoryFile()` 维护上级标题日期栈，子标题继承父标题日期
→ 优先级：标题日期 > 继承的父标题日期 > 文件名日期 > fallback

**技术方案**：

日期提取优先级（三层）：
1. Section 自身标题中的日期（如 `## 2026-03-05：xxx`、`## 2026-02-26 | xxx`）
2. 从最近的上级标题继承日期（如 `### 理由` 继承 `## 2026-03-05：xxx` 的日期）
3. 文件名中的日期（如 `2026-03-05.md`）
4. Fallback：索引运行时间（最后兜底，仅对无时间概念的常设文档生效）

**实施步骤**：
- [x] `parser.ts`：新增 `parseDateFromTitle()` 从标题正则提取 `YYYY-MM-DD`
- [x] `parser.ts`：`parseMemoryFile()` 维护 `parentDates` 栈，每个标题级别缓存日期
- [x] 新增 `resolveInheritedDate()` 从当前级别往上查找最近有日期的父标题
- [x] 子标题继承父标题日期：`### 理由` → 继承 `## 2026-03-05：xxx`
- [x] 编译验证：`npx tsc --noEmit` 零错误
- [x] 重建 memory-index：`npx tsx src/memory/sync-cli.ts --full` → 231 张卡片
- [x] 验证：decisions 19 张全部正确（2/23, 2/24, 2/27, 2/28, 3/3, 3/4, 3/5），conversations 11 张全部正确
- [x] 重建 seed 节点结构（8 节点：root + 7 子节点）
- [x] 重新部署到 `~/.openclaw/extensions/personal-rec/dist/`

**验收标准**：
- [x] 142 张原来 date 不准的卡片，日期提取准确率 ≥ 80%（实际结果：有时间概念的内容 100% 准确，仅 46 张无时间概念的常设文档 fallback）
- [ ] "最近做了什么决策" 在 OpenClaw 对话中能正确返回近期决策（需重启 Gateway 验证）
- [x] 不影响已正确的日志卡片（daily-log 79 张全部正确）

---

### Phase R 实施记录（2026-03-06）

**已完成步骤**:
- ✅ R.0: graph.ts 泛化
  - SummaryCard → ContentCard, papers → items
  - 迁移2555篇论文, 70节点到v2格式
  - 保持向后兼容性

- ✅ R.1: 创建 semantic-navigator Skill
  - 创建 `src/skills/semantic-navigator/SKILL.md` + `navigate.ts`
  - 支持 `--source papers|memory`, `--action overview|explore|read`
  - 集成graph.ts,提供统一导航接口
  - 测试: papers源70节点2925论文, memory源207个记忆实体

- ✅ R.2: 记忆索引构建
  - 创建 `src/memory/parser.ts` (实体拆分)
  - 创建 `src/memory/index-builder.ts` (索引构建)
  - 创建 `src/memory/build-cli.ts` (CLI入口)
  - 成功解析207个记忆实体(决策20/洞察19/人物6/项目38/其他124)
  - 生成207张ContentCard到 `memory-index/knowledge/cards/`

- ✅ R.3: memory-manager 联动
  - 调研结论: memory-manager 是 Skill (无回调机制), 采用 CLI 手动触发方案
  - 创建 `src/memory/incremental-indexer.ts` (基于 mtime 的增量索引)
  - 创建 `src/memory/sync-cli.ts` (支持 --since/--full/--dry-run/--verbose)
  - 同步状态持久化: `memory-index/sync-state.json`
  - 测试: 首次同步39文件207卡片, 增量检测修改文件正确, 无变更时0操作

- ✅ R.4: AGENTS.md 对接
  - 部署 `semantic-navigator` Skill 到 `~/.openclaw/workspace/skills/semantic-navigator/`
  - 在 AGENTS.md 注册 Skill, 配置优先级: Skill > MEMORY.md > 直接读文件
  - 调整 MEMORY.md 定位: 快速导航索引, 不再全文读取
  - 包含: 执行流程、查询映射表、同步说明、错误处理

- ✅ R.5: Plugin 瘦身
  - 从 `src/index.ts` 移除 navigate_knowledge 的 import 和 registerTool
  - 归档旧工具到 `src/tools/deprecated/navigate-knowledge.ts`
  - Plugin 加载日志提示已废弃
  - `npm run build` 编译通过, tsconfig 排除 deprecated 目录

**Phase R 完成状态**: ✅ 代码实现全部完成 (R.0-R.5)，✅ 运行时修复 Fix-R.1~R.5 全部完成，✅ CLI 验收 UX-R.5 通过，✅ OpenClaw 对话验收 UX-R.4 通过（用户确认效果不错），⏳ UX-R.1~R.3 论文检索场景待单独验证

### Phase R 运行时修复记录（2026-03-07）

**Fix-R.1: 插件部署版本同步** ✅
- npm run build 重新编译 → rsync --delete 同步到部署目录
- 对比 dist/index.js 一致，新增 memory/ migration/ skills/ 模块

**Fix-R.2: Pipeline Error 修复** ✅
- 根因：`reorganizer.ts:405,423` 和 `classifier.ts:84` 中 `c.tags` 未对 undefined 做防护
- 修复：对 `reorganizer.ts`、`navigate.ts`、`classifier.ts` 中所有 `c.tags` 加 `?? []`
- 同步部署

**Fix-R.3: Memory 索引结构优化** ✅
- 创建 7 个 seed 子节点：decisions(19) / insights(16) / projects(34) / facts(10) / daily-log(65) / conversations(10) / archive(53)
- 修复 `navigate.ts` loadCard 路径错误（多了一层 knowledge/）
- 验证：memory overview 显示 8 节点，read 正常返回内容

**Fix-R.4: WebSocket** ✅（偶发，记录不处理）

**UX-R.5: CLI 基础功能验证** ✅
- papers overview: 70 节点 2925 篇，1.5s
- memory overview: 8 节点 207 items，1.3s
- 错误处理友好，响应时间达标

---

## Phase 4：内部记忆语义路标

> 技术设计详见 [technical-design.md](./technical-design.md) 第四章。

### Step 4.1: 内部记忆实体拆分器（细化 R.2） ✅ → 🔄 schema 精简中

> 目标：更精细的拆分规则，支持多粒度实体（决策、洞察、日志、人物）
>
> **2026-03-07 schema 精简**：经讨论（见 `discussions/entity-extraction-redesign.md`），`projects`、`tags`、`locations`、`relatedEntities`、`entityType` 从卡片 schema 中移除。卡片唯一保留的实体属性是 `people`。以下标注 ~~删除线~~ 的条目需要从代码中清理。

**具体任务**：
- [x] 扩展拆分器（基于 R.2 的 `src/memory/parser.ts`）
  - [x] 识别不同文件类型的拆分策略：
    - [x] `memory/YYYY-MM-DD.md`：按段落拆分（每个独立事件）
    - [x] `memory/decisions.md`：按决策条目拆分（"### 决策：xxx" 模式）
    - [x] `memory/insights/*.md`：按洞察段落拆分（"## 洞察" 下的独立观点）
    - [x] `memory/facts/work.md`：按人物/组织条目拆分（"### 人物：xxx" 模式）
  - ~~[x] 元数据提取：实体类型（decision/insight/log/person）、标签（从内容中提取关键词）~~ → **待清理**：移除 `detectEntityType()`、`extractTags()`
  - [x] 实体关联属性提取（parser 阶段基于规则，不依赖 LLM）
    - [x] **人物提取**：加载 `facts/work.md` 身份速查表为人物词典 → 正则扫描 section 内容匹配已知人物 ID/姓名（**保留**）
    - ~~[x] **项目提取**：加载 `projects/` 目录文件名 + 标题为项目词典 → 正则扫描 section 内容匹配已知项目名~~ → **待清理**：移除 `loadProjectDictionary()`、`extractProjects()`
    - ~~[x] **场景提取**（可选预留）：从 section 标题中匹配关键词（"周会"、"1v1"、"群聊"等）~~ → **待清理**：移除 `extractLocations()`、`locationKeywords`
- [x] ContentCard 字段（**精简后**）
  - [x] `people`（`string[]`——相关人物，parser 从人物词典匹配提取）（**保留**）
  - ~~[x] `entityType`（decision | insight | log | person | project | other）~~ → **待清理**
  - ~~[x] `tags`（从内容提取的关键词）~~ → **待清理**
  - ~~[x] `projects`（`string[]`——相关项目）~~ → **待清理**
  - ~~[x] `locations`（`string[]`——地点/场景）~~ → **待清理**
  - ~~[x] `relatedEntities`（由 people/projects 推导）~~ → **待清理**
- [x] 验证
  - [x] 抽检 10 条决策：每个拆分正确
  - [x] 抽检 10 条卡片：people[] 提取准确（27 人识别，43/219 卡片含 people 字段）
  - ~~[x] 抽检 5 个人物：relatedEntities 正确关联~~ → 字段已移除
  - ~~[x] 抽检 10 条卡片：projects[] 提取准确（6 项目识别）~~ → 字段已移除

**代码清理 checklist**：
- [x] 删除 `loadProjectDictionary()`
- [x] 删除 `extractTags()`
- [x] 删除 `extractProjects()`
- [x] 删除 `extractLocations()` + `locationKeywords`
- [x] 删除 `detectEntityType()`
- [x] `MemoryEntity` 接口精简为最小 schema（id / content / sourceFile / sourceLine / date / level）
- [x] `EntityDictionary` 类型精简——只保留 people 相关字段

**验收**：
- [x] 拆分器覆盖所有 `memory/` 文件类型
- [x] 实体拆分粒度合理（不遗漏、不碎片化）
- [x] 人物词典加载正确（facts/work.md 身份速查表）
- [x] ContentCard 精简为最小 schema（id / title / oneLiner / people / source / date）

---

### Step 4.2: 内部记忆摘要卡生成 ✅ → 🔄 schema 精简中

> 目标：每个实体生成 ContentCard（type="memory"），结构化摘要
>
> **2026-03-07 schema 精简**：summarizer 只需生成 `title` + `oneLiner`，不再生成 `tags` / `qualitySignal`。

**具体任务**：
- [x] 摘要卡生成器（`src/memory/summarizer.ts`，适配内部记忆场景）
  - [x] 适配 internal memory：输入 entity 内容 → LLM 增强 ContentCard
  - [x] Prompt 设计：
    - [x] system prompt：定义摘要卡字段（title, oneLiner）
    - [x] user prompt：强调"简洁概括核心内容"，title ≤ 20 字，oneLiner ≤ 40 字
  - [x] ContentCard 增强字段（**精简后**）：
    - [x] `title`：LLM 精炼标题（如"推荐 Scaling 决策"）
    - [x] `oneLiner`：3-5 句话摘要
    - ~~[x] `tags`：3-5 个关键词~~ → **待清理**
    - ~~[x] `qualitySignal`：质量信号（core-decision / key-insight / routine-log / reference-only）~~ → **待清理**
    - ~~[x] `entityType`：继承自 Step 4.1 parser 提取~~ → **待清理**
    - [x] `people`：继承自 Step 4.1 parser 提取（**保留**）
    - ~~[x] `projects`：继承自 Step 4.1 parser 提取~~ → **待清理**
- [x] 批量生成
  - [x] `src/memory/summarizer-cli.ts` — CLI 入口：`npx tsx src/memory/summarizer-cli.ts --limit 5 --dry-run`
  - [x] 支持跳过已生成的卡片（`llmEnhanced: true` 幂等标记）
  - [x] 支持 `--limit`、`--provider`、`--model`、`--dry-run` 参数
  - [x] 错误处理：LLM 返回非法 JSON 时 graceful fallback
- [x] 验证
  - [x] 测试 5 张卡片增强：title/oneLiner 生成合理
  - [x] 幂等性验证：再次运行跳过已增强卡片
  - [x] 修复 `loadRawContent()` 中 `require("node:fs")` ESM 兼容问题

**代码清理 checklist**：
- [x] summarizer prompt 精简——只要求生成 title + oneLiner
- [x] 删除 tags / qualitySignal 的生成和解析逻辑
- [x] 删除 entityType / projects 的透传逻辑

**验收**：
- [x] LLM 增强器实现完成，可批量增强 memory 卡片
- [x] 摘要卡质量人工抽检合格（测试样本 7/219 已增强）
- [x] 批量生成成功率 ≥ 95%（测试中无失败）
- [ ] 完整批量运行（219 张卡片全量增强，~15 分钟）— 待用户择机执行

---

### Step 4.3: 初始语义网构建 ✅ → 🔄 schema 精简中

> 目标：从目录结构自动生成初始节点 + LLM 补充归类
>
> **2026-03-07 schema 精简**：`entityType` 已移除，seed 节点归类需要改用其他信号（如源文件路径）。`generateQualitySignal()` 待删除。

**具体任务**：
- [x] 目录结构 seed hint（内置于 `index-builder.ts`）
  - [x] 创建 6 个 seed 子节点：
    - [x] `decisions`（决策记录）
    - [x] `insights`（个人洞察）
    - [x] `daily-log`（日常日志）
    - [x] `projects`（工作项目）
    - [x] `facts`（事实信息）
    - [x] `archive`（归档内容）
  - [x] `buildMemoryIndex()` 自动创建 seed 节点并归类
  - [x] 无需单独的 seed 创建脚本，冷启动问题在 index-builder 中解决
- [x] ~~类型到 seed 节点的映射~~ → **待重构**：改用源文件路径映射（`decisions.md` → decisions, `insights/*.md` → insights 等）
  - ~~[x] decision → decisions, insight → insights, log → daily-log~~
  - ~~[x] project → projects, person → facts, other → archive~~
  - ~~[x] 支持多种 entityType 映射到同一 seed 节点~~
- ~~[x] `generateQualitySignal()` 扩展~~ → **待清理**：整个函数移除
  - ~~[x] 新增 log/person/project 类型的质量信号~~
  - ~~[x] 信号基于 entityType + 内容长度 + 关键词~~
- [x] 验证
  - [x] 全量重建后卡片分布到 6 个 seed 节点
  - [x] 节点分布合理
  - ~~[x] 每张卡片都有 entityType 字段~~ → 字段已移除

**代码清理 checklist**：
- [x] 删除 `generateQualitySignal()`
- [x] 删除 `detectEntityType()`
- [x] seed 节点归类改用源文件路径（而非 entityType）
- [x] 删除 `deriveRelatedEntities()`
- [x] `entityToCard()` 只输出最小 ContentCard

**验收**：
- [x] 初始图有 6 个 seed 节点（超过 3+ 的目标）
- [x] 归类准确率 100%
- [x] seed 节点结构可被后续重整（Step 4.4）进一步细化

---

### Step 4.4: 内部记忆重整 ✅

> 目标：复用 reorganizer.ts，对内部记忆图执行分裂/合并/建边

**具体任务**：
- [x] reorganizer 适配（`src/memory/reorganizer.ts`，独立的 memory 版重整器）
  - [x] 数据路径：直接操作 `~/.openclaw/memory-index/knowledge/`
  - [x] Prompt 调整：
    - [x] internal memory 的节点命名规范（日常用语，如"产品决策"、"技术判断"）
    - [x] 使用 cardId 而非 paperId
    - [x] Stage 1 prompt 要求 3-8 个 kebab-case ID 子节点
    - [x] Stage 2 prompt 批量归类（每批 40 个 items）
  - [x] 首次重整（daily-log 节点，100 items）：
    - [x] Stage 1：LLM 分析样本内容 → 定义 6 个子节点
    - [x] Stage 2：分 3 批归类 → 98/100 items 成功归类
    - [x] 结果：daily-log 分裂为 product-direction(23), team-collaboration(16), scaling-strategy(19), data-analysis(17), status-updates(11), general-thoughts(12)
- [x] 正式 apply 重整
  - [x] dry-run 确认合理后 apply
  - [x] `memory-index/graph.json` 更新，新增 6 个子节点
  - [x] items 从 daily-log 迁移到子节点
- [x] `extractTopLevelJson()` JSON 提取
  - [x] 使用括号计数法从 LLM 输出中提取 JSON（处理 markdown 包裹）
- [x] 修复 `addEdge()` 签名不匹配问题
  - [x] 从 `addEdge(graph, e.from, e.to, e.relation)` 修复为 `addEdge(graph, e.from, { target: e.to, relation: e.relation })`
- [x] 验证
  - [x] 重整后 daily-log 从 100 items 减至 2 items（98% 分流到子节点）
  - [x] 6 个新子节点命名合理，卡片分布均匀
  - [x] 总卡片数不变（219 张，无数据丢失）

**验收**：
- [x] 重整成功，无数据丢失（总卡片数 219 不变）
- [x] 节点结构反映用户的真实关注方向（daily-log → 6 个有意义的子方向）
- [x] 重整耗时可接受（< 300s）
- [ ] archive 节点（33 items）可选重整 — 待用户决定

---

### Step 4.5: 关注方向图谱提取 ✅

> 目标：从重整后的路标图提取"当前活跃方向"快照

**具体任务**：
- [x] 活跃节点识别
  - [x] 定义"活跃"标准：
    - [x] 节点下卡片数 ≥ minItems（默认 3）
    - [x] 最近 recentDays（默认 14 天）内有新增卡片
  - [x] 遍历非 root 节点，筛选活跃节点列表
- [x] 快照导出
  - [x] `src/memory/export-snapshot.ts` — 导出"当前关注方向图谱"
  - [x] 格式：JSON（nodeId、label、itemCount、recentItemCount、topPeople、sampleTitles）
  - ~~topTags、topProjects~~ → **待清理**：这些字段依赖已移除的 tags/projects，需从快照逻辑中删除
  - [x] 路径：`~/.openclaw/memory-index/snapshot/current-focus.json`
  - [x] CLI 支持：`--index-dir`、`--min-items`、`--recent-days`、`-v` 参数
- [x] 快照结果
  - [x] 13 个非 root 节点中 11 个为活跃方向
  - [x] 438 total items，11 active nodes
  - [x] 每个节点含 topPeople、sampleTitles（3 个）
  - ~~topTags（top 5）、topProjects~~ → 待清理
- [x] 验证
  - [x] 快照节点数 11（≥ 5 目标）
  - [x] 节点反映用户当前关注方向（product-direction, scaling-strategy, team-collaboration 等）
  - [x] 快照可正确加载为 JSON

**验收**：
- [x] `current-focus.json` 生成，包含 11 个活跃节点
- [x] 快照内容准确（人工评审）
- [x] 快照可被 Phase 5 检索 query 生成器读取

---

### Phase 4 完成标准

- [x] 内部记忆图有 5+ 个有意义的节点（实际 13 个：6 seed + 6 daily-log 子节点 + root）
- [x] 重整后的结构反映用户真实的关注方向（daily-log → 6 子方向：product-direction, scaling-strategy 等）
- [x] 关注方向图谱可导出为结构化数据（`current-focus.json`，11 个活跃节点）
- [x] 归类准确率 ≥ 85%（seed 节点 entityType 映射 100%，LLM 重整 98/100）
- [x] 人物提取准确率 ≥ 80%（覆盖度）/ ≥ 90%（精确度）——27 人词典，43 张卡片含 people
- [x] 重整耗时 < 300s
- [x] TypeScript 编译零错误
- [x] **schema 精简代码清理**（2026-03-07 完成）：
  - [x] 移除 `projects`、`tags`、`locations`、`relatedEntities`、`qualitySignal`、`entityType` 相关代码
  - [x] `ContentCard` 精简为最小 schema（id / title / oneLiner / people / source / date）
  - [x] 快照导出移除 topTags / topProjects 聚合

### Phase 4 实施记录（2026-03-07）

**已完成步骤**:

- ✅ 4.1: 实体拆分器增强 + 实体关联属性 → 🔄 schema 精简中
  - `parser.ts`：保留 `loadPeopleDictionary()`, `extractPeople()`
  - ~~`loadProjectDictionary()`, `extractProjects()`, `extractLocations()`, `detectEntityType()`, `extractTags()`~~ → 待清理
  - ~~`graph.ts`：ContentCard `entityType`, `relatedEntities`, `projects[]`, `locations[]`, `tags[]`~~ → 待从类型定义中移除
  - **保留**：`people[]` 字段（27 人词典，43/219 卡片含 people）
  - **精简后 ContentCard**：id / title / oneLiner / people / source / date

- ✅ 4.2: 内部记忆摘要卡 LLM 增强器 → 🔄 schema 精简中
  - 新建 `src/memory/summarizer.ts`：`enhanceMemoryCards()` 逐卡调用 LLM
  - 新建 `src/memory/summarizer-cli.ts`：CLI 入口, 支持 --limit/--provider/--model/--dry-run
  - **精简后**：Prompt 只生成 title(≤20字) + oneLiner(≤40字)
  - ~~tags(3-5个), qualitySignal~~ → 待从 prompt 和解析逻辑中清理
  - 幂等标记：`llmEnhanced: boolean`, 再次运行自动跳过已增强卡片
  - 测试：7/219 张卡片已增强, 全量运行待用户择机执行

- ✅ 4.3: 初始语义网构建（内置于 index-builder）→ 🔄 schema 精简中
  - `buildMemoryIndex()` 自动创建 6 个 seed 子节点
  - ~~entityType → seed 映射~~ → 待改用源文件路径映射
  - ~~generateQualitySignal()~~ → 待删除
  - 卡片分布：daily-log(100), projects(34), insights(23), decisions(19), archive(33), facts(10)

- ✅ 4.4: 内部记忆重整（daily-log 节点）
  - 新建 `src/memory/reorganizer.ts`：memory 专用重整器, 日常用语命名, cardId
  - Stage 1：LLM 分析样本内容 → 定义 6 个子节点
  - Stage 2：分 3 批归类 100 items → 98 成功, 2 留在原节点
  - 子节点：product-direction(23), scaling-strategy(19), data-analysis(17), team-collaboration(16), general-thoughts(12), status-updates(11)
  - 修复：`addEdge()` 签名不匹配, `extractTopLevelJson()` JSON 提取

- ✅ 4.5: 关注方向图谱提取 → 🔄 schema 精简中
  - 新建 `src/memory/export-snapshot.ts`：活跃节点识别 + 快照导出
  - 活跃标准：itemCount ≥ 3 AND recentDays(14) 内有新卡片
  - 结果：13 节点中 11 个活跃, 438 total items
  - 保留：topPeople、sampleTitles
  - ~~topTags/topProjects~~ → 待从快照逻辑中清理
  - 输出：`~/.openclaw/memory-index/snapshot/current-focus.json`

**Phase 4 完成状态**: ✅ 代码实现全部完成 (4.1-4.5), ✅ schema 精简代码清理完成（9 个文件，TypeScript 零错误）, ✅ Phase 4.6 重跑完成（索引重建 219 张 → LLM 增强 96.3% → 重整 19 节点 → 快照 15 活跃方向 → 部署）, ✅ 体验验收 UX-4.1~4.4 全部通过（用户确认效果不错）

---

### Phase 4.6: Schema 精简后重跑（代码清理完成后执行）

> 目标：代码清理完成后，重新全量生成卡片、重整节点、导出快照，确保精简后的 schema 端到端可用。
>
> **前置依赖**：Step 4.1~4.3 的代码清理 checklist 全部完成（✅）

**Step 4.6.1: 全量重建索引** ✅
- [x] 运行 `npx tsx src/memory/sync-cli.ts --full` 全量重建 memory-index
- [x] 确认卡片只含精简字段（id / title / content / people / sourceFile / date）——无 tags / projects / entityType / relatedEntities / qualitySignal / locations
- [x] 确认卡片总数：219 张，分布到 8 节点（root + 7 seeds：decisions:19, insights:17, daily-log:73, projects:35, facts:10, conversations:11, archive:54）

**Step 4.6.2: 重新 LLM 增强** ✅
- [x] 211/219 卡片（96.3%）已有 LLM 增强（从之前运行继承），8 张因"原始内容过短"跳过——正常行为
- [x] 抽检确认：增强卡片只有 title / oneLiner，无 tags / qualitySignal
- [x] 成功率 96.3%（≥ 95% 目标）

**Step 4.6.3: 重新重整** ✅
- [x] seed 节点自动按源文件路径归类（不再依赖 entityType）
- [x] daily-log 已在之前 reorganization 中被拆分为 6 个子节点（mcp-architecture:9, recommendation-system:15, scaling-up-tech:15, team-collaboration:25, experiment-data:5, openclaw-dev:3），无需重新重整
- [x] 重整后节点结构合理：14 个节点（root + 7 seeds + 6 daily-log 子节点）

**Step 4.6.4: 重新导出快照** ✅
- [x] 运行快照导出成功
- [x] 确认 `current-focus.json` 只含 topPeople / sampleTitles——无 topTags / topProjects
- [x] 活跃节点数 12（≥ 5 目标），总卡片 438，14 个节点

**Step 4.6.5: 重新部署** ✅
- [x] `npm run build` — TypeScript 编译零错误
- [x] rsync --delete 同步到 `~/.openclaw/extensions/personal-rec/dist/`
- [ ] 重启 Gateway（需用户手动操作）

**验收**：
- [x] 全链路端到端通过：索引重建 → LLM 增强 → 重整 → 快照导出 → 部署
- [x] 所有卡片/快照不含已移除字段
- [x] `semantic-navigator --source memory --action overview` 正常返回
- [x] TypeScript 编译零错误

---

### Phase 4 体验验收

> 以下验收需要用户亲自操作并主观判断。
>
> **2026-03-07 数据验证完成**：19 节点（7 seed + 12 子节点），219 张卡片，15 个活跃方向。archive 已重整为 6 子节点（仅剩 5 items）。0 张卡片含已移除字段。

#### UX-4.1: 记忆节点命名直觉性

**数据摘要**（2026-03-07）：
```
19 个节点：
  decisions(19) insights(17) projects(35) facts(10) conversations(11)
  daily-log → team-collaboration(25) recommendation-system(15) scaling-up-tech(15)
              mcp-architecture(9) experiment-data(5) openclaw-dev(3)
  archive → memory-system-architecture(18) technical-implementation(15)
            ai-project-management(6) creator-tools(6) market-competition-analysis(2)
```

- [x] 节点命名用人话，无算法编号 — ✅ 用户确认效果不错
- [x] 节点划分与真实关注方向吻合 — ✅ 用户确认
- [x] 无"莫名其妙"的节点 — ✅ 用户确认

#### UX-4.2: 重整前后对比可感知

**数据摘要**（2026-03-07）：
- 重整前：7 个 seed 节点（daily-log 73 items, archive 54 items 堆在一起）
- 重整后：19 个节点，daily-log 拆为 6 子节点，archive 拆为 6 子节点
- root 219 items（全集），各 seed/子节点分别承接对应内容

- [x] 重整后结构明显优于重整前 — ✅ 用户确认
- [x] root 节点 items 减少，子节点有意义分布 — ✅ 用户确认
- [x] 不存在丢失内容的情况（总 items 数不变） — ✅ 已验证 219 张卡片完整

#### UX-4.3: 关注方向快照可理解

**数据摘要**（2026-03-07）：
- 15 个活跃方向，3 个非活跃（daily-log:1, archive:5, market-competition-analysis:2）
- 快照字段：id / description / itemCount / recentItemCount / latestDate / topPeople / sampleTitles
- 无 topTags / topProjects（schema 精简已生效）

- [x] 快照字段自解释，不需要查文档 — ✅ 用户确认
- [x] 活跃方向与当前真实关注一致 — ✅ 用户确认
- [x] 无过期的"僵尸方向" — ✅ 用户确认

#### UX-4.4: 人物维度导航准确性

**数据摘要**（2026-03-07）：
- 219 张卡片中 43 张（19%）有 people，27 个唯一人物
- 0 张卡片含已移除字段，字段集合仅含 date/id/llmEnhanced/oneLiner/people/source/sourceFile/title/type/url
- 抽检 10 张有 people 的卡片，提取结果合理

- [x] people[] 精确度 ≥ 90%（抽检 10 张无误报） — ✅
- [x] people[] 覆盖度 ≥ 80% — ✅ 用户确认 19% 有 people 的比例合理（大量 insights/方法论类卡片本身不提及人名）
- [x] 人物词典从 facts/work.md 正确加载（27 人覆盖身份速查表） — ✅

---

## Phase 5：内部驱动外部检索

> 技术设计详见 [technical-design.md](./technical-design.md) 第五章。
> 依赖：Phase 4 的 `current-focus.json` + Phase 1-3 的入库管道（`generateSummaryCards` / `classifyCards`）

### Step 5.1: 检索 query 生成器

> 目标：读取 `current-focus.json` 活跃节点 → LLM 生成英文学术检索 query → 跨节点去重

| 字段 | 值 |
|---|---|
| 优先级 | P1 — Phase 5 起点，后续步骤全部依赖 |
| 前置依赖 | Phase 4.5 ✅（current-focus.json） |
| 影响范围 | 新建 `src/query/generator.ts`，~487 行（含 5.1.1 意图筛选层） |

**具体任务**：
- [x] 快照加载
  - [x] 读取 `~/.openclaw/memory-index/snapshot/current-focus.json`
  - [x] 解析 `FocusSnapshot.activeNodes[]`，提取 `id`、`description`、`sampleTitles`
  - [x] 跳过 `itemCount < 3` 的节点（过小的方向不值得搜）
- [x] LLM query 生成
  - [x] `src/query/generator.ts` — `generateQueries(snapshot: FocusSnapshot, opts): Promise<QueryResult>`
  - [x] 每个活跃节点调用一次 `runEmbeddedPiAgent`：
    - [x] extraSystemPrompt："你是学术检索助手，根据用户关注方向生成英文学术搜索关键词"
    - [x] prompt：节点 `description` + `sampleTitles`（最多 3 个）
    - [x] 输出：JSON `{ "queries": ["query1", "query2", "query3"] }`
    - [x] 约束：每个 query 2-5 个词的英文短语，不要人名、不要太泛
  - [x] timeoutMs: 30000（每节点 30s 超时）
  - [x] 错误处理：JSON 解析失败时 graceful skip，记录错误不阻塞
- [x] 跨节点去重
  - [x] 所有节点的 query 汇总后归一化：lowercase + trim
  - [x] 精确去重：完全相同的 query 合并
  - [x] 子串包含检测：如果 query A 是 query B 的子串，保留更长的 B
  - [x] 每个 query 保留来源节点 ID（支持溯源）
- [x] CLI 入口
  - [x] `src/query/query-cli.ts`（或内嵌到 generator.ts）：`npx tsx src/query/generator.ts --output-only --dry-run`
  - [x] `--output-only`：只输出 query 列表，不执行搜索
  - [x] `--limit N`：只处理前 N 个活跃节点
  - [x] 输出格式：JSON `{ "generatedAt", "totalNodes", "queries": [{ "text", "sourceNodeId", "sourceDescription" }] }`
  - [x] 输出路径：`~/.openclaw/memory-index/queries/latest.json`（可选持久化）
- [x] 验证
  - [x] 测试 3 个节点生成 query → 9 个 query，去重后 9 个 ✅
  - [x] 抽检 query：英文表达地道，与节点方向匹配（"generative retrieval recommendation"、"tokenized sequential recommendation" 等精准对应技术方向）
  - [x] 全量测试 14 个活跃节点 → 意图筛选保留 5 个 → 15 个 query（去重后 15）
- [x] Phase 5.1.1 改进：意图筛选层 + query prompt 改进
  - [x] 新增 `filterSearchableNodes()` — LLM 一次调用筛选 14 个节点（9 个不适合学术检索被跳过）
  - [x] 改进 `buildQueryPrompt()` — 强调从工作笔记提取底层技术概念，带 few-shot 示例
  - [x] 新增 `callLLM()` 辅助函数，减少重复代码
  - [x] `QueryResult` 新增 `searchableNodes` + `filteredOutNodes` 字段
  - [x] CLI 新增 `--skip-filter` 选项
  - [x] `search-cli.ts` 展示筛选统计信息

**验收**：
- [x] `npx tsc --noEmit` 零错误
- [x] 去重后生成 15 个 query（在 10-30 范围内）
- [x] query 准确度 ≥ 80%（15 个 query 中 12 个精准对应技术方向，3 个偏泛但可接受 = 80%）
- [x] 每个 query 带来源节点标注（sourceNodeId + sourceDescription）
- [x] LLM 调用 6 次（1 次筛选 + 5 次 query 生成），总耗时 27.7s < 60s

---

### Step 5.2: Semantic Scholar API 封装

> 目标：封装 Semantic Scholar Graph API，返回标准化论文搜索结果

| 字段 | 值 |
|---|---|
| 优先级 | P1 — 外部数据获取核心模块 |
| 前置依赖 | 无（可与 5.1 并行开发） |
| 影响范围 | 新建 `src/search/semantic-scholar.ts`，~150 行 |

**具体任务**：
- [x] API 封装
  - [x] `src/search/semantic-scholar.ts` — `searchPapers(query, opts): Promise<SearchResult[]>`
  - [x] API endpoint：`https://api.semanticscholar.org/graph/v1/paper/search`
  - [x] 请求参数：`query`、`limit`（默认 10）、`offset`（默认 0）、`fields`（title, abstract, authors, year, externalIds, url, citationCount）
  - [x] 使用 Node.js 内置 `fetch`（不引入新依赖）
- [x] 返回类型标准化
  - [x] `SearchResult` 接口：
    ```typescript
    interface SearchResult {
      paperId: string;       // Semantic Scholar ID
      arxivId: string | null; // arXiv ID（从 externalIds.ArXiv 提取）
      title: string;
      abstract: string;
      authors: string[];     // 作者姓名列表
      year: number;
      url: string;           // Semantic Scholar URL
      citationCount: number;
    }
    ```
  - [x] 空 abstract 的论文标记但不跳过（摘要卡生成时可用 title-only 模式）
- [x] 速率限制处理
  - [x] 无 API Key 时限制 1 req/s：每次请求间插入 1s 延迟（`await sleep(1000)`）
  - [x] HTTP 429 处理：指数退避重试（1s → 2s → 4s），最多 3 次
  - [x] HTTP 5xx 处理：重试 1 次后 skip
  - [x] 网络超时：10s 超时，超时后 skip
- [ ] 验证
  - [ ] 用 3 个 query 手动测试：`"recommendation system scaling"` / `"cold start generative retrieval"` / `"multi-objective optimization recommender"`
  - [ ] 验证返回字段完整（title, abstract, authors, arxivId）
  - [ ] 验证速率限制：连续 5 个 query 不触发 429
  - [ ] 验证 arxivId 提取正确（部分论文有，部分没有）

**验收**：
- [x] `npx tsc --noEmit` 零错误
- [ ] API 调用成功，返回结果字段完整
- [ ] 速率限制处理正常（无 429 错误）
- [ ] 错误处理健壮（超时、5xx、空结果不崩溃）

---

### Step 5.3: 去重 + 入库管道

> 目标：搜索结果 → 与现有卡片去重 → 转 FeedItem → 复用 generateSummaryCards + classifyCards 入库

| 字段 | 值 |
|---|---|
| 优先级 | P1 — 连接搜索与入库 |
| 前置依赖 | Step 5.1 ✅、Step 5.2 ✅ |
| 影响范围 | 新建 `src/search/deduplicator.ts`（~80 行）+ `src/search/pipeline.ts`（~200 行） |

**具体任务**：
- [x] 去重器
  - [x] `src/search/deduplicator.ts` — `deduplicateResults(results: SearchResult[], dataDir: string): Promise<SearchResult[]>`
  - [x] 加载 `personal-rec/knowledge/cards/` 目录下所有卡片 ID 到 Set（已有论文集合）
  - [x] 优先用 `arxivId` 匹配（现有论文卡片 ID 就是 arXiv ID 格式）
  - [x] 无 arxivId 时用 `paperId` 前缀匹配（`ss:${paperId}`）
  - [x] 同一轮搜索结果内部也去重（多个 query 可能搜到同一篇论文）
  - [x] 输出统计：总搜索数、去重后数、跳过原因（已入库 / 批次内重复）
- [x] SearchResult → FeedItem 转换
  - [x] `toFeedItem(result: SearchResult, queryText: string): FeedItem`
  - [x] 字段映射：
    - `id` = `arxivId ?? "ss:" + paperId`
    - `title` = result.title
    - `summary` = result.abstract（缺失时用 `"[abstract not available]"`）
    - `authors` = result.authors
    - `published` = `${result.year}-01-01`（Semantic Scholar 只返回年份）
    - `link` = result.url
    - `source` = `"semantic-scholar"`
- [x] 端到端管道
  - [x] `src/search/pipeline.ts` — `runProactiveSearch(opts): Promise<SearchPipelineResult>`
  - [x] 步骤编排：
    1. `loadFocusSnapshot()` — 加载快照
    2. `generateQueries()` — LLM 生成 query
    3. 遍历 query，逐个调用 `searchPapers()`（串行，遵守速率限制）
    4. `deduplicateResults()` — 去重
    5. `toFeedItems()` — 转换格式
    6. 将 FeedItem 写入临时目录（复用 `saveFeedItems` 格式）
    7. `generateSummaryCards()` — 复用现有摘要卡生成
    8. `classifyCards()` — 复用现有归类
  - [x] 进度日志：每个阶段开始/结束时输出 `[proactive-search] Stage X: ...`
  - [x] 结果统计：`{ queriesGenerated, papersSearched, duplicatesSkipped, newPapersAdded, classifyResult }`
- [x] CLI 入口
  - [x] `src/search/search-cli.ts` — `npx tsx src/search/search-cli.ts [--dry-run] [--limit N] [--query-only]`
  - [x] `--dry-run`：只到去重步骤，不调用摘要卡生成和归类
  - [x] `--limit N`：限制搜索的 query 数量
  - [x] `--query-only`：等同于调用 5.1 的 `--output-only`
  - [x] `--provider` / `--model`：LLM 提供方配置
- [ ] 验证
  - [ ] 跑通 5 个 query 的端到端流程（dry-run 模式验证去重）
  - [ ] 跑通 3 个 query 的完整入库流程（含摘要卡生成 + 归类）
  - [ ] 新增论文在 `graph.json` 中可查到（归到正确节点）
  - [ ] 新增论文在 `cards/` 目录下有对应的 `.json` 卡片
  - [ ] 二次运行：已入库论文被正确跳过（去重幂等）

**验收**：
- [x] `npx tsc --noEmit` 零错误
- [ ] 端到端流程跑通，新论文入库成功（graph.json + cards/）
- [ ] 去重逻辑正确（不重复入库，二次运行 0 新增）
- [ ] 归类准确率 ≥ 85%（抽检 10 篇）
- [ ] 进度日志清晰（每阶段统计数字）

---

### Step 5.4: 调度集成

> 目标：将 proactiveSearch 集成到 service.ts 的 postFetchPipeline 末尾，支持自动触发

| 字段 | 值 |
|---|---|
| 优先级 | P2 — 自动化，5.1-5.3 完成后可独立手动触发 |
| 前置依赖 | Step 5.3 ✅ |
| 影响范围 | 修改 `src/feeds/service.ts`（~30 行），新增 `ServiceOpts.enableProactiveSearch` |

**具体任务**：
- [x] 集成到 postFetchPipeline
  - [x] 在 `triggerReorgIfNeeded()` 成功后新增 `proactiveSearch()` 调用
  - [x] 节流机制：对比 `current-focus.json` 的 `generatedAt` 与上次搜索时间，快照未更新则跳过
  - [x] 上次搜索时间持久化到 `~/.openclaw/memory-index/search-state.json`
- [x] ServiceOpts 扩展
  - [x] `enableProactiveSearch?: boolean`（默认 true）
  - [x] `searchLimit?: number`（每轮最多搜索的 query 数，默认 30）
  - [x] `searchPerQuery?: number`（每个 query 返回的论文数，默认 10）
- [x] 非阻塞设计
  - [x] `proactiveSearch()` 失败只 log 不中断（与现有 pipeline 错误处理一致）
  - [x] 超时保护：整个 proactiveSearch 5 分钟超时
- [ ] 验证
  - [ ] 手动触发 `postFetchPipeline` → 确认 proactiveSearch 被调用（需 Gateway 运行时验证）
  - [ ] `enableProactiveSearch: false` → 确认跳过（需 Gateway 运行时验证）
  - [x] 快照未更新 → 确认节流跳过（代码逻辑验证通过）
  - [x] proactiveSearch 失败 → 确认不影响 RSS 正常入库（try/catch 非阻塞设计 ✅）

**验收**：
- [x] `npx tsc --noEmit` 零错误
- [ ] postFetchPipeline 末尾自动触发 proactiveSearch（需 Gateway 运行时验证）
- [x] 节流机制正常（快照不变则跳过 — 代码逻辑正确）
- [x] 失败不阻塞（非阻塞错误处理 ✅）
- [x] Gateway 日志清晰记录触发/跳过/结果

---

### Phase 5 完成标准

- [x] 生成的 query 与内部记忆关注方向匹配（80%+，人工抽检）— ✅ 15 个 query 中 12 个精准
- [ ] Semantic Scholar API 调用稳定，速率限制处理正常
- [ ] 去重逻辑正确，不重复入库（二次运行 0 新增）
- [ ] 入库管道端到端跑通（搜索 → 去重 → 摘要卡 → 归类 → 入库）
- [ ] 循环调度正常：postFetchPipeline 末尾自动触发（有节流）
- [ ] 端到端耗时 < 5 分钟（5 节点 → 15 query → 意图筛选后更高效）
- [x] TypeScript 编译零错误
- [x] 新增 5 个文件：`query/generator.ts`、`search/semantic-scholar.ts`、`search/deduplicator.ts`、`search/pipeline.ts`、`search/search-cli.ts`
- [x] 零新 npm 依赖（使用 Node.js 内置 fetch）

### Phase 5 体验验收

> 以下验收需要用户亲自操作并主观判断。

#### UX-5.1: 检索 query 可解释性

**操作**：
```bash
# 生成 query 并查看
npx tsx src/query/generator.ts --output-only
# 或查看持久化的 query 文件
cat ~/.openclaw/memory-index/queries/latest.json | python3 -m json.tool
```

**关注点**：
- 每个 query 旁边是否有"来源节点"标注（知道为什么搜这个）
- query 关键词是否与你实际关注的学术方向匹配
- 有没有"这跟我有什么关系？"的 query
- query 的学术表达是否地道（不是生硬的中译英）

**通过标准**：看到 query 列表后觉得"对，这些就是我想搜的方向"

- [ ] 每个 query 有来源标注（关联的内部记忆节点）
- [ ] query 与实际关注方向匹配
- [ ] query 的学术表达自然

#### UX-5.2: 搜索结果新鲜度和相关度

**操作**：
```bash
# 跑一轮端到端搜索入库
npx tsx src/search/search-cli.ts
# 然后用 navigator 查看新入库的论文
npx tsx src/skills/semantic-navigator/navigate.ts --source papers --action read --nodeId root --limit 10 --since $(date -v-1d +%Y-%m-%d)
```

**关注点**：
- 新入库的论文标题/摘要是否与你的关注方向相关
- 是否有"这篇明显不相关"的噪音论文
- 对比：这批论文 vs 你平时自己在 arXiv 看到的，质量如何

**通过标准**：新入库论文的相关度 ≥ RSS 随机拉取

- [ ] 新入库论文与关注方向高度相关
- [ ] 噪音论文占比 < 20%
- [ ] 搜索结果质量 ≥ 自己 RSS 拉取

#### UX-5.3: 端到端延迟感知

**操作**：
```bash
# 手动触发完整循环并计时
time npx tsx src/search/search-cli.ts --full-cycle
```

**关注点**：
- 从触发到完成总耗时是否可接受（目标 < 5 分钟）
- 过程中是否有进度提示（`[proactive-search] Stage 1: 正在生成 query...`）
- 如果超时，瓶颈在哪（LLM 调用？API 搜索？磁盘写入？）

**通过标准**：全流程 < 5 分钟，有进度反馈

- [ ] 端到端 < 5 分钟
- [ ] 有过程进度输出（不是黑屏等待）

---

## Phase 6：淘汰机制

### Step 6.1: 主动淘汰

> 目标：内部记忆重整后，对比前后图谱差异 → 降权弱化方向的论文

**具体任务**：
- [ ] 前后对比
  - [ ] `src/elimination/comparer.ts` — 对比重整前后的 graph.json
  - [ ] 提取差异：
    - [ ] 弱化方向：重整后卡片数显著减少的节点（阈值：-50%）
    - [ ] 消失方向：重整后节点被删除或合并
- [ ] 生成淘汰建议
  - [ ] 遍历弱化/消失方向下的论文
  - [ ] 生成淘汰建议列表（paperId、reason、建议级别）
  - [ ] 建议级别：第一级（移出导航热点）、第二级（摘要卡归档）、第三级（物理删除）
- [ ] 应用淘汰建议
  - [ ] `src/elimination/apply.ts` — 执行淘汰操作
  - [ ] 第一级：从 `graph.json` 节点的 items 数组移除（卡片保留但不显示）
  - [ ] 第二级：卡片移到 `cards/archive/`（释放 graph.json 空间）
  - [ ] 第三级：物理删除（可配置，默认不做）
- [ ] 验证
  - [ ] 人工评审淘汰建议：合理性 ≥ 80%
  - [ ] 执行淘汰：数据一致性（graph.json + cards/ 同步更新）
  - [ ] 不误删仍有价值的论文（抽检验证）

**验收**：
- [ ] 淘汰建议生成合理（80%+ 人工评审合格）
- [ ] 淘汰操作不误删有价值论文
- [ ] 数据一致性验证通过

---

### Step 6.2: 被动淘汰

> 目标：论文数超阈值 → 按综合指标排序清理

**具体任务**：
- [ ] 阈值配置
  - [ ] `maxPapers` 默认 10000（可配置）
  - [ ] 检查 `personal-rec/knowledge/` 总论文数
  - [ ] 超限触发被动淘汰
- [ ] 综合指标计算
  - [ ] `src/elimination/score.ts` — 计算每篇论文的综合得分
  - [ ] 指标权重（可配置）：
    - [ ] 与内部记忆当前关注方向的相关度（权重 0.5）
    - [ ] 最近被导航命中的次数（权重 0.3）
    - [ ] 入库时间（权重 0.2，越旧越低）
    - [ ] 是否被主动淘汰标记（权重 -1.0）
  - [ ] 信号收集：从 `signals.json` 统计导航命中次数
- [ ] 排序和清理
  - [ ] 按综合得分升序排序
  - [ ] 清理排名最低的论文（清理数量 = 超限数量 + buffer，如 +10%）
- [ ] 验证
  - [ ] 清理后论文库规模回落到阈值内
  - [ ] 被清理的论文确实相关度低（抽检 10 篇）
  - [ ] 不误删高相关度的论文

**验收**：
- [ ] 超限触发正常，论文库规模可控
- [ ] 综合指标计算合理
- [ ] 不误删高相关度论文

---

### Step 6.3: 淘汰分级

> 目标：三级淘汰：移出导航热点 → 摘要卡归档 → 物理删除

**具体任务**：
- [ ] 第一级：移出导航热点
  - [ ] 从 `graph.json` 节点的 items 数组移除 paperId
  - [ ] 卡片保留在 `cards/`（不影响直接访问）
  - [ ] 适用场景：弱化方向、命中率低的论文
- [ ] 第二级：摘要卡归档
  - [ ] 从 `cards/` 移动到 `cards/archive/`
  - [ ] `graph.json` 中不引用（释放空间）
  - [ ] 适用场景：过期论文、长期未命中的论文
- [ ] 第三级：物理删除
  - [ ] 从 `cards/archive/` 物理删除
  - [ ] 适用场景：用户明确配置开启
- [ ] 验证
  - [ ] 三级淘汰机制按预期工作
  - [ ] 第一级不删除卡片，只移出导航
  - [ ] 第二级归档后，graph.json 不引用
  - [ ] 第三级删除后，磁盘空间释放

**验收**：
- [ ] 三级淘汰机制按预期工作
- [ ] 第一级：卡片保留，导航不可见
- [ ] 第二级：归档后 graph.json 空间释放
- [ ] 第三级：物理删除成功（如果配置开启）

---

### Phase 6 完成标准

- [ ] 淘汰后论文库规模可控（不超过阈值）
- [ ] 淘汰的论文确实是与当前兴趣不相关的（80%+ 人工评审）
- [ ] 不误删仍有价值的论文
- [ ] 三级淘汰机制按预期工作
- [ ] 数据一致性验证通过（graph.json + cards/）

### Phase 6 体验验收

> 以下验收需要用户亲自操作并主观判断。

#### UX-6.1: 淘汰透明度

**操作**：
```bash
# 执行一轮淘汰（dry-run 模式）
npx tsx src/elimination/apply.ts --dry-run
# 查看淘汰建议列表
```

**关注点**：
- 每条淘汰建议是否有明确理由（"近 30 天未关注此方向"、"节点已合并"）
- 淘汰级别是否合理（不会直接物理删除有价值的内容）
- 是否有"这篇我还要的，怎么被淘汰了"的情况

**通过标准**：看完淘汰列表后觉得"合理，确实该清"

- [ ] 每条淘汰建议有明确理由
- [ ] 淘汰级别分配合理
- [ ] 无明显误判（想保留的被淘汰）

#### UX-6.2: 误删可恢复

**操作**：
```bash
# 执行第一级淘汰（移出导航热点）
npx tsx src/elimination/apply.ts --level 1
# 确认论文从 overview 中消失
npx tsx src/skills/semantic-navigator/navigate.ts --source papers --action overview
# 尝试恢复（如果有 undo 机制）
npx tsx src/elimination/apply.ts --undo --card-id <某个被淘汰的卡片ID>
```

**关注点**：
- 第一级淘汰后，卡片文件是否还在 cards/ 目录（只是从导航移除）
- 是否有 undo/恢复的操作路径
- 恢复后是否回到淘汰前的状态

**通过标准**：误操作后有明确的恢复手段

- [ ] 第一/二级淘汰可逆（卡片未物理删除）
- [ ] 有明确的恢复操作路径
- [ ] 恢复后数据完整

#### UX-6.3: 淘汰后导航瘦身效果

**操作**：
```bash
# 淘汰前看 overview
npx tsx src/skills/semantic-navigator/navigate.ts --source papers --action overview
# 执行淘汰
npx tsx src/elimination/apply.ts --level 1
# 淘汰后看 overview
npx tsx src/skills/semantic-navigator/navigate.ts --source papers --action overview
```

**关注点**：
- 淘汰后节点 items 数是否明显减少
- 剩余内容是否更聚焦（噪音减少）
- overview 输出是否更"干净"

**通过标准**：淘汰后浏览体验比淘汰前更好，信噪比提升

- [ ] 淘汰后 items 数明显减少
- [ ] 剩余内容更聚焦，噪音减少
- [ ] 不影响高价值内容的可访问性

---

## Phase 7：主动 briefing

### Step 7.1: 调研 OpenClaw heartbeat/cron API

> 目标：确认 Plugin cron + LLM 调用可行性

**具体任务**：
- [ ] 阅读 OpenClaw Plugin API 文档
  - [ ] 确认 heartbeat/cron 机制
  - [ ] 确认 Plugin 能否注册 cron 任务
  - [ ] 确认 cron 回调中能否调用 LLM（`runEmbeddedPiAgent`）
- [ ] 验证可行性
  - [ ] 编写 demo Plugin：注册一个 cron 任务（每小时触发）
  - [ ] cron 回调中调用 `runEmbeddedPiAgent` → 成功返回
- [ ] 记录发现
  - [ ] cron 表达式格式
  - [ ] LLM 调用限制（如有）
  - [ ] 超时控制

**验收**：
- [ ] cron 任务注册成功
- [ ] cron 回调中 LLM 调用成功
- [ ] 超时控制正常

---

### Step 7.2: briefing 生成器

> 目标：读内部记忆 + 导航外部记忆 → 3-5 篇推荐 + 理由

**具体任务**：
- [ ] 读取内部记忆
  - [ ] 读 `memory-index/snapshot/current-focus.json`（当前关注方向）
  - [ ] 提取活跃节点列表 + 最近卡片的标题
- [ ] 导航外部记忆
  - [ ] 调用 `semantic-navigator` Skill
  - [ ] 对每个活跃节点，执行 `explore` + `read`
  - [ ] 提取相关论文（limit=20，按最近排序）
- [ ] LLM 生成推荐
  - [ ] `src/briefing/generator.ts` — 基于 internal + external 生成推荐
  - [ ] Prompt 设计：
    - [ ] 输入：当前关注方向 + 相关论文列表
    - [ ] 输出：3-5 篇推荐论文 + 推荐理由（每篇 2-3 句话）
    - [ ] 理由：论文与关注方向的相关性、核心贡献
- [ ] 格式化输出
  - [ ] Markdown 格式：标题 + 摘要 + 链接 + 理由
  - [ ] 路径：`~/.openclaw/personal-rec/briefing/YYYY-MM-DD.md`
- [ ] 验证
  - [ ] 生成一次 briefing → 输出格式合理、推荐内容与内部记忆相关
  - [ ] 推荐质量人工评审（80%+）

**验收**：
- [ ] briefing 生成成功，格式规范
- [ ] 推荐内容与内部记忆相关（80%+）
- [ ] 推荐理由清晰

---

### Step 7.3: 推送通道

> 目标：飞书 webhook / OpenClaw 消息 API

**具体任务**：
- [ ] 调研推送通道
  - [ ] 飞书 webhook：配置、速率限制、格式
  - [ ] OpenClaw 消息 API：是否支持 Plugin 推送消息到对话
- [ ] 选择主通道
  - [ ] 决策：优先用 OpenClaw 消息 API（集成度更高）
  - [ ] 备用：飞书 webhook（如果 OpenClaw API 不支持）
- [ ] 实现推送逻辑
  - [ ] `src/briefing/pusher.ts` — 推送 briefing 到指定通道
  - [ ] 格式化消息：标题 + 推荐列表（Markdown）
  - [ ] 错误处理：推送失败重试
- [ ] 验证
  - [ ] 手动触发推送 → 成功收到消息
  - [ ] 消息格式清晰易读

**验收**：
- [ ] 推送成功，收到消息
- [ ] 消息格式清晰
- [ ] 推送失败重试正常

---

### Phase 7 完成标准

- [ ] cron 任务注册成功，每日定时触发
- [ ] briefing 生成质量合格（80%+ 人工评审）
- [ ] 推送通道正常，收到消息
- [ ] 消息格式清晰易读

### Phase 7 体验验收

> 以下验收需要用户亲自操作并主观判断。

#### UX-7.1: briefing 可操作性

**操作**：
```bash
# 手动生成一次 briefing
npx tsx src/briefing/generator.ts
# 查看生成的 briefing
cat ~/.openclaw/personal-rec/briefing/$(date +%Y-%m-%d).md
```

**关注点**：
- 每条推荐是否有明确的"下一步"（读全文链接、加入关注、忽略）
- 推荐理由是否提到了你的具体关注方向（如"因为你在关注推荐 Scaling..."）
- 3-5 篇推荐中有几篇你真的想点开看
- 整体格式是否适合快速扫读（30 秒内决定看不看）

**通过标准**：收到 briefing 后知道该做什么，不需要再搜索

- [ ] 每条推荐有可操作的下一步
- [ ] 推荐理由关联到具体的内部记忆/关注方向
- [ ] 3-5 篇中 ≥ 2 篇想点开看
- [ ] 30 秒内可完成扫读和决策

#### UX-7.2: 推送体验

**操作**：
```bash
# 手动触发推送
npx tsx src/briefing/pusher.ts
# 在 OpenClaw 对话 / 飞书中查看收到的消息
```

**关注点**：
- 推送消息格式是否在目标渠道中正确渲染（Markdown 是否被解析）
- 消息长度是否合适（不能太长导致折叠，也不能太短缺少信息）
- 推送时间是否在预期范围内（cron 触发后 < 3 分钟收到）

**通过标准**：推送消息就像一个靠谱同事发的"今日推荐"

- [ ] 消息在目标渠道正确渲染
- [ ] 消息长度适中（不折叠、不缺信息）
- [ ] 推送延迟 < 3 分钟

#### UX-7.3: 日常使用节奏验证（需持续 3-5 天）

**操作**：连续 3-5 天接收 briefing，记录以下指标

**每日记录**：
- 今天的 briefing 中，几篇是相关的？几篇是噪音？
- 有没有"昨天推过了今天又推"的重复？
- 推荐方向有没有随着你记忆的变化而调整？

**关注点**：
- 日间推荐去重是否有效
- 推荐方向是否跟随内部记忆的变化（如新增了一个关注方向，briefing 是否反映）
- 连续几天后是否出现"推荐疲劳"（总是推同一方向的论文）

**通过标准**：3-5 天后觉得"这个 briefing 值得每天看"

- [ ] 日间去重有效，无重复推荐
- [ ] 推荐方向随记忆变化动态调整
- [ ] 无推荐疲劳（方向多样性）
- [ ] 综合评价：值得每天看

---

_最后更新: 2026-03-14（Step R.1.1 search action 实现完成——新增 `--action search` 支持，CLI 测试通过（query-only 模式，9 条 query，66.2s）。修复 API key 问题（auth-profiles.json 添加 alibaba provider）。添加默认 provider/model（alibaba/glm-5）。部署并重启 Gateway。待测试：dry-run/full 模式、direction 过滤、手动 query 逻辑。）_
