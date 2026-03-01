# 实现 Checklist

> 每完成一步就更新状态。详细设计见 [mvp-plan.md](./mvp-plan.md)。

---

## v0.1 — RSS + search_feed 基线（✅ 已完成 2026-02-28）

- [x] 项目脚手架（package.json、tsconfig.json、openclaw.plugin.json）
- [x] Plugin 入口（src/index.ts）— 注册 service + tool
- [x] RSS 拉取 Service（src/feeds/service.ts）— 后台定时拉取 arXiv RSS
- [x] RSS 解析器（src/feeds/parser.ts）— 解析 arXiv RSS XML 为结构化数据
- [x] Feed 存储（src/feeds/storage.ts）— JSON 文件存储 + 去重 + 索引
- [x] search_feed Tool（src/tools/search-feed.ts）— agent 可调用的检索工具
- [x] TypeScript 编译通过（零错误）
- [x] 本地调试配置（~/.openclaw/openclaw.json）
- [x] Gateway 加载成功 + RSS 拉取跑通 + agent 自主调用 search_feed
- [x] 验证推荐质量 — 能推荐但质量一般（基线水平，符合预期）

---

## Phase 1 — 摘要卡 + 单节点归类

### Step 0: 技术验证

- [x] 验证 `runEmbeddedPiAgent` 在 Plugin 中可用性
  - ✅ 可用：通过 dynamic import 加载 OpenClaw 内部模块（参考 `llm-task` extension）
  - 详见 [mvp-plan.md #技术验证记录](./mvp-plan.md#技术验证记录)
- [x] 验证外部 Plugin 能否 resolve `openclaw` 内部模块路径
  - ✅ 2026-03-01 验证通过
  - 方法：`createRequire(import.meta.url).resolve("openclaw")` 拿到 OpenClaw dist 路径 → `import(extensionApiPath)` 加载 `extensionAPI.js`
  - `extensionAPI.js` 是 OpenClaw 专门给 extension 用的 API 模块，正式导出了 `runEmbeddedPiAgent`
  - Gateway 日志确认：`[personal-rec] ✅ runEmbeddedPiAgent loaded (typeof=function)`
  - 实现：`src/llm/loader.ts`（3 级 fallback 策略）

### Step 1: 数据积累 — backfill 历史数据

> 目标：拉 cs.IR 过去 30 天历史数据，积累到 300+ 篇

- [x] 实现 `src/feeds/backfill.ts` — arXiv API 分页拉取（按日期范围，每页 200，3s 间隔）
- [x] 按日期分组存储 + 去重，输出格式与日常拉取一致
- [x] 运行 backfill，确认数据落盘到 `~/.openclaw/personal-rec/feeds/`
- [x] 验证：cs.IR 30 天 = 385 篇（去重后 366 新增），总量 397 篇 ✅ 超 300+ 目标
  - 日期范围 2026-01-30 → 2026-02-26，覆盖 28 天

### Step 2: 数据积累 — 加源

> 目标：新增 cs.AI / cs.LG，多领域覆盖

- [x] `openclaw.plugin.json` + `index.ts` 默认 feeds 增加 cs.AI、cs.LG
- [x] backfill cs.AI (4176 篇) + cs.LG (4572 篇)，数据格式统一
- [x] 验证：总数据量 **7268 篇**，覆盖 3 个分类 ✅ 远超 500+ 目标
  - cs.IR 与 cs.AI/cs.LG 有交叉论文，自动去重

### Step 3: 语义网数据结构

> 目标：定义 knowledge/ 目录结构 + graph.json + cards/ 数据格式

- [x] 实现 `src/knowledge/graph.ts` — 完整 CRUD（graph/cards/signals）
  - 类型：`SemanticGraph`, `GraphNode`, `SummaryCard`, `ClassificationSignal`
  - 操作：load/save graph, save/load card, append signal, getStats
- [x] 初始化 `~/.openclaw/personal-rec/knowledge/` 目录结构（knowledge/ + cards/）
- [x] 创建 root 节点（冷启动 graph.json，version=1）
- [x] 验证：写入→读回一致（graph.json、cards/*.json、signals.json 全部通过）

### Step 4: 摘要卡生成器（核心）

> 目标：LLM 读取论文 title+abstract，输出结构化摘要卡 JSON

- [x] 实现 LLM 调用封装（dynamic import `runEmbeddedPiAgent` 或 fallback）
  - ✅ 2026-03-01 `src/llm/loader.ts` — 3 级 fallback 加载 `runEmbeddedPiAgent`
  - ✅ `collectText` + `stripCodeFences` 工具函数封装
- [x] 设计摘要卡生成 prompt（输入：title+abstract → 输出：JSON schema）
  - ✅ system prompt 约束 JSON 格式：`{tags, oneLiner, qualitySignal}`
  - ✅ user prompt 双重强调"直接输出JSON，不要工具调用"
- [x] 实现 `src/summarizer/generator.ts` — 单篇生成 + 批量生成
  - ✅ `generateSummaryCards()` 批量串行 + `callLLMForCard()` 单篇调用
  - ✅ 支持 `provider/model/config/agentDir` 参数，兼容自定义 provider
  - ✅ 正确的 JSONL session header（version: 2）
  - ✅ `src/summarizer/cli.ts` — CLI 入口，支持 `--limit/--days/--provider/--model`
- [x] 实现错误处理 + 重试（LLM 返回非法 JSON 时重试）
  - ✅ `maxRetries` 可配置（默认 1 次重试）
  - ✅ JSON 提取兼容额外文本（regex 提取 + stripCodeFences）
  - ✅ 跳过无 abstract 或 abstract 过短的论文
- [x] 人工抽检 10 篇摘要卡质量（标签准不准、一句话概括到不到位）
  - ✅ 10/10 全部成功，0 失败
  - ✅ 质量评估：tags 准确覆盖核心技术、oneLiner 精炼、qualitySignal 切中要点
  - 模型：`alibaba/qwen3-coder-plus`（DashScope Coding 端点）
- [x] 记录：信息压缩比（原始 ~200 tokens → 摘要卡 ~30 tokens）
  - ✅ 实测 100 篇：平均 abstract 1370 chars (~343 tokens) → 摘要卡 470 chars (~118 tokens)
  - ✅ **压缩比 2.91x**（注：摘要卡包含结构化 JSON 元数据，纯内容压缩比更高）
  - ✅ 原始估算偏乐观（200→30 约 6.7x），实际因摘要卡保留了 title/url/source 等字段
- [x] 记录：批量生成耗时和成本
  - ✅ 100 篇批量测试：90 篇新生成 + 10 篇跳过（已有），**0 失败**
  - ✅ 总耗时 261s（~4.4 min），平均 **2.9s/篇**
  - ✅ 模型：`alibaba/qwen3-coder-plus`（DashScope Coding 端点）
  - ✅ 成本估算：DashScope coding 端点免费额度内（SP key）
  - ✅ 外推全量：7268 篇 × 2.9s ≈ 5.8 小时（串行），可优化为并发

#### 技术踩坑记录

| 问题 | 原因 | 解决方案 |
|---|---|---|
| `zhipu` provider 不识别 | OpenClaw 内置的是 `zai`（Z.AI） | auth-profiles.json 改为 `provider: "zai"` |
| auth-profiles 不生效 | 旧格式缺少 `type`/`provider` | 转为 v1 格式（type: "api_key"） |
| DashScope 400 空 tools | `disableTools:true` → 空 `tools:[]` → coding 端点拒绝 | 不传 `disableTools`，强 prompt 约束 |
| 通用端点 401 | `sk-sp-` key 只能用 coding 端点 | 使用 coding 端点 + coder 系列模型 |
| session header 无效 | 写了 `{"entries":[]}` | 改为 JSONL header `{type:"session",version:2,...}` |

### Step 5: 入库归类（冷启动版）

> 目标：生成摘要卡 → 归到 root 节点 → 输出微感知信号

- [x] 实现 `src/summarizer/classifier.ts` — 归类 + 微感知信号输出
  - ✅ Phase 1 冷启动：全部归 root，confidence = "high"，perception = null
  - ✅ 幂等：`hasPaper()` 检查，重复执行全部 skip
  - ✅ `src/summarizer/classify-cli.ts` — CLI 入口
- [x] 摘要卡存储到 `knowledge/cards/`，paper ID 加到 `graph.json` root.papers
  - ✅ 100 篇论文全部挂到 root.papers，graph.json 已更新
- [x] 信号存储到 `knowledge/signals.json`
  - ✅ 100 条 ClassificationSignal 写入 signals.json
- [x] 验证：入库流程端到端跑通（RSS 拉取 → 摘要卡 → 归类 → 存储）
  - ✅ 100/100 成功，0 失败
  - ✅ 幂等验证：重复运行 → 100 skipped，signals 不重复
  - ✅ 数据一致性：root.papers(100) = cards/(100) = signals(100)

### Step 6: service 串联 + search_feed 升级

> 目标：拉取后自动生成摘要卡；search_feed 返回摘要卡而非原始 abstract

- [x] 改造 `src/feeds/service.ts`：拉取完成后触发摘要卡生成 + 入库归类
  - ✅ `postFetchPipeline()`：fetchAll → generateSummaryCards → classifyCards（串行、非阻塞）
  - ✅ ServiceOpts 新增 `provider/model/agentDir/config` 透传 LLM 参数
  - ✅ 已有摘要卡/已入库的自动 skip（幂等）
- [x] 升级 `src/tools/search-feed.ts`：优先返回摘要卡（token 更省），无摘要卡时 fallback 原始数据
  - ✅ `formatItemsWithCards()`：有 card → 精简格式（tags + oneLiner + qualitySignal），无 card → 原始 abstract
  - ✅ 返回值增加 `withCard`/`withoutCard` 统计
  - ✅ description 更新反映新能力
- [x] 端到端验证：重启 Gateway → 自动拉取 → 自动生成摘要卡 → agent 调 search_feed 拿到摘要卡
  - ✅ Gateway 重启成功（PID 92090），plugin 加载 + runEmbeddedPiAgent 可用
  - ✅ RSS 拉取 19 篇 cs.IR → pipeline 执行（已有摘要卡全部 skip，幂等正确）
  - ✅ search_feed 输出摘要卡格式：Tags + Summary + Signal（对比验证前 5 篇）
  - ✅ 117/6813 篇有摘要卡、6701 篇 fallback 原始 abstract
  - 踩坑：`openclaw.json` 的 plugin config 有 JSON Schema 校验，不接受自定义字段 → 改为环境变量 + 硬编码默认值
- [x] TypeScript 编译通过（零错误）
  - ✅ `npx tsc --noEmit` 零错误
- [x] `src/index.ts` 透传 LLM 参数
  - ✅ 环境变量 `PERSONAL_REC_PROVIDER`/`PERSONAL_REC_MODEL`，默认 `alibaba/qwen3-coder-plus`
  - ✅ 自动读取 `~/.openclaw/openclaw.json` 作为 config（custom provider apiKey）
  - 注：openclaw.json plugin config 有 schema 校验，自定义字段会被拒绝

### Phase 1 完成标准（✅ 全部通过 2026-03-01）

#### 标准 1：500+ 篇论文有摘要卡 + 归类到 root 节点

- [x] 批量生成摘要卡：`npx tsx src/summarizer/cli.ts --limit 600`
  - ✅ 483 篇新生成 + 117 篇跳过（已有），0 失败
  - 修复：cli.ts 未传 provider/model 默认值 → 回退 Anthropic 401。改为默认 `alibaba/qwen3-coder-plus`
  - 修复：共享 workspaceDir 导致 Gateway bootstrap 干扰 → 改为每次调用创建独立子目录
- [x] 批量归类入库：`npx tsx src/summarizer/classify-cli.ts`
  - ✅ 488 篇新归类 + 100 篇跳过，0 失败
- [x] 验证数据一致性：cards(588) = graph.json root.papers(588) = signals(588) ✅

#### 标准 2：数据全部持久化到 `~/.openclaw/personal-rec/knowledge/`

- [x] 目录结构完整：knowledge/graph.json + knowledge/cards/(588 files) + knowledge/signals.json
- [x] 数据可读回：graph version=1，随机 5 篇 card 字段完整，signals 588 条无重复

#### 标准 3：search_feed 返回摘要卡，体感推荐质量优于 v0.1 基线

- [x] Gateway 运行中（PID 45887），search_feed 可用
- [x] 检索 "recommendation" 10 篇全部返回摘要卡格式（Tags + Summary + Signal）
- [x] 体感对比：摘要卡精简（Tags 2-3 个 + 一句话概括 + 核心贡献），可读性远优于原始 abstract

#### 标准 4：微感知信号正常输出（为 Phase 2 重整做数据准备）

- [x] signals.json 信号数 588 ≥ 500，格式统一（assignedNode=root/confidence=high/perception=null）
- [x] 信号按 paperId 查询，588 unique，0 重复

---

## Phase 2 — 多节点语义网 + LLM 导航

> 详见 [mvp-plan.md Phase 2](./mvp-plan.md#phase-2多节点语义网--llm-导航)

### Step 1: 扩展 graph.ts CRUD

> 目标：支撑多节点操作（分裂、迁移、导航）

- [x] `addNode` / `removeNode` — 节点增删（removeNode 自动清理边和 parent 引用）
- [x] `addEdge` / `removeEdge` — 有向边增删（幂等，不重复添加）
- [x] `movePapers` — 批量论文迁移（从 A 节点移到 B，支持去重）
- [x] `getChildren` / `getNeighbors` — 子节点和边邻居查询
- [x] `getTopLevelNodes` / `loadNodeCards` — 顶层节点列表 + 批量加载摘要卡
- [x] 单元测试 38/38 通过（`src/knowledge/__test__/graph-crud.test.ts`）

### Step 2: 重整器（手动触发版）

> 目标：LLM 驱动 root 分裂为多个子节点 + 建边

- [x] 实现 `src/knowledge/reorganizer.ts` — LLM 推理 diff + applyDiff
- [x] 实现 `src/knowledge/reorganize-cli.ts` — CLI 入口（`--node`/`--dry-run`/`--provider`/`--model`）
- [x] JSON 解析修复：括号计数法 `extractTopLevelJson` 替代正则（支持嵌套 JSON）
- [x] JSON 解析单测 8/8 通过（`src/knowledge/__test__/json-extract.test.ts`）
- [x] 首次 dry-run 成功（588 卡 → 6 节点 + 4 边，47s）
- [x] **优化分裂效果**：V1 仅 76/588（13%），V2 两阶段策略大幅改进
  - [x] A. 修复 Paper ID 问题 — 去除序号，Stage 2 验证真实 arXiv ID
  - [x] B. 两阶段分裂策略 — Stage 1 从 tag 统计定义节点 + Stage 2 分批归类
  - ✅ V2 dry-run 结果：10 节点 + 5 边，475/588（81%）分出，113 留 root（19%）
  - ✅ 耗时：Stage 1 22s + Stage 2 241s（12 批 × ~20s），总 263s
  - ⚠️ `large-language-models` 节点有 201 篇（34%），可能需要未来二次分裂
- [x] 正式 apply 分裂 diff → graph.json 产生多层节点
  - ✅ 11 节点（root + 10 子节点），14 条边（7 双向），root 仅剩 24 篇（4%）
  - ✅ 节点分布：large-language-models(164), deep-learning-foundations(139), multimodal-learning(91), reinforcement-learning(37), agentic-ai(33), medical-ai(30), explainable-ai(24), recommendation-systems(18), robustness-security(15), federated-learning(13)
- [x] 验证分裂质量（节点命名合理、论文归属准确、边描述有意义）
  - ✅ 抽检 30 篇（每节点 3 篇），28/30 准确（93%），2 篇为合理的跨领域边界情况

### Step 3: 导航式检索

> 目标：路标导航替代全量返回，每步只看当前层级的节点描述

- [x] 实现 `src/tools/navigate-knowledge.ts` — overview/explore/read_papers 三步导航
- [x] 注册 `navigate_knowledge` 工具到 `src/index.ts`
- [x] 在多层节点上验证导航流程
  - ✅ overview → 10 节点 + 论文数 + 边关系，清晰呈现
  - ✅ explore → 节点邻居 + 关系描述，支持深入
  - ✅ read_papers → 摘要卡精准，格式规范
- [x] A/B 对比：`search_feed`（全量）vs `navigate_knowledge`（导航）
  - [x] a) token 消耗：导航 ~1,174 tokens vs 全量 ~31,387 tokens = **省 96.3%（26.7x）**
  - ~~b) 推荐精准度~~ — 不再需要（`search_feed` 将降级，见 Step 5）
  - ~~c) 推荐理由质量~~ — 不再需要
  - ~~d) 延迟对比~~ — 不再需要

### Step 4: 入库归类升级（多节点版）

> 目标：新论文入库时 LLM 选择最匹配的节点（不再全归 root）

- [x] 升级 `src/summarizer/classifier.ts` — Phase 2 分支：LLM 读节点描述 → 选择归类目标
- [x] 支持多归属（同时归到 2 个节点）+ 微感知信号（confidence + perception）
- [x] `service.ts` 透传 provider/model 参数
- [x] 在多层节点上验证归类效果
  - ✅ 6 篇测试论文（recommendation-systems / medical-ai / agentic-ai 各 2 篇）全部正确归回原节点
  - ✅ 多归属工作正常：跨领域论文同时归到 2 个节点（如 medical-ai + explainable-ai）
- [x] 人工抽检归类准确率：6/6 = 100%（样本较小，但覆盖 3 个节点 + 多归属场景）
- ~~验证低置信度信号是否合理~~ — 推迟到 Phase 3（signals.json 数据需先修复，见 Step 5 问题表）

### Step 5: 工具收敛 — navigate_knowledge 成为唯一对外工具

> 目标：`search_feed` 降级为内部兜底，`navigate_knowledge` 承担所有论文推荐场景
>
> 背景：2026-03-01 端到端体验测试发现 `search_feed` 定位尴尬（无关键词搜索，只做全量 dump，588 篇 ≈ 31K tokens），
> 有了多节点图后应该统一走 `navigate_knowledge` 导航路径。

- [x] `search_feed` 取消对外注册（从 `index.ts` 移除 registerTool，保留代码作为内部工具/冷启动兜底）
  - ✅ `index.ts` 仅注册 `navigate_knowledge`，`search_feed` 代码保留但不对外暴露
- [x] `navigate_knowledge` 的 `read_papers` 增加 `limit` 参数 — 防止节点积累 100+ 篇时 token 爆炸
  - ✅ `limit`（默认 20，最大 200）+ `offset`（分页）参数已添加
- [x] `navigate_knowledge` 的 `read_papers` 增加 `since` 参数 — 支持"最近 N 天新增论文"的时间维度过滤
  - ✅ `since` ISO date 字符串过滤，cards 按日期降序排序（最新优先）
- [x] `navigate_knowledge` 冷启动兜底 — overview 检测到只有 root 时，自动 fallback 调用 search_feed 逻辑
  - ✅ 冷启动时引导 agent 用 `read_papers` + `nodeId='root'` 浏览论文（统一路径，无需额外工具）
- [x] 更新 `navigate_knowledge` 的 tool description — 体现"唯一入口"定位
  - ✅ description 重写：标注 "primary tool"，说明 limit/offset/since 用法
- [x] 重新 deploy + restart Gateway，验证 agent 只看到 `navigate_knowledge` 一个工具
  - ✅ Gateway 重启成功，确认编译后 JS 仅有一个 `registerTool` 调用
- [x] TypeScript 编译零错误
  - ✅ `npx tsc --noEmit` 零错误

#### 体验测试发现的其他问题（记录，非本步骤解决）

| 问题 | 严重度 | 说明 | 计划解决阶段 |
|---|---|---|---|
| 多归属为 0 | 🟡 | 历史 588 篇单归属分裂，新论文才走 Phase 2 Classifier 多归属 | Phase 3（积累后重整） |
| 推荐系统节点准确率 72% | 🟡 | 18 篇中 5 篇（交通预测、社区检测、社交机器人等）和推荐关系弱 | Phase 3（重整优化） |
| 2 个超大节点 >100 篇 | 🟡 | large-language-models(164)、deep-learning-foundations(139) 太泛 | Phase 3 Step 1（自动触发二次分裂） |
| signals.json 仅 1 条 | 🟡 | 分裂操作可能覆盖了旧信号，影响 Phase 3 触发条件统计 | Step 5 后排查 |

### Phase 2 完成标准

- [x] 语义网有 5+ 个子节点 + 边，论文分布合理（root remaining < 20%）
  - ✅ 10 子节点 + 7 边，root 仅 24 篇（4%）
- [x] `navigate_knowledge` 在多层节点上可用，agent 对话验证导航流程
  - ✅ 三步导航 overview/explore/read_papers 全部可用
- [x] token 对比完成：导航 ~1,174 tokens vs 全量 ~31,387 tokens = 省 96.3%
  - 注：A/B 精准度/延迟对比不再需要（`search_feed` 已降级，不再有对比对象）
- [x] 新论文自动归到正确子节点（不再全归 root）
  - ✅ Classifier Phase 2: 6/6 正确，多归属正常
- [x] TypeScript 编译零错误
- [x] `navigate_knowledge` 成为唯一对外工具（Step 5）
  - ✅ 2026-03-01 完成：search_feed 降级 + limit/offset/since 参数 + 冷启动兜底 + description 更新

---

## Phase 3 — 自生长 + 自动重整（待开始）

> 详见 [mvp-plan.md Phase 3](./mvp-plan.md#phase-3自生长--自动重整)
> 
> 注：重整器（reorganizer.ts）已在 Phase 2 实现，Phase 3 只新增自动触发逻辑。

### Step 1: 自动触发机制

- [ ] 实现 `src/knowledge/trigger.ts` — 入库后检查触发条件
  - [ ] 条件 a: 某节点论文数 > 阈值（默认 20）
  - [ ] 条件 b: 某节点近期低置信度归类 > 30%
  - [ ] 条件 c: 定时兜底（配置项，默认每月）
- [ ] 触发后自动调用 `reorganizer.ts`，diff 自动应用

### Step 2: 完整自生长闭环

- [ ] 端到端验证：RSS 拉取 → 摘要卡 → 归类 → 触发重整 → 导航使用新结构
- [ ] 经过 1 个月积累，语义网结构合理性评估

### Step 3: 主动 briefing

- [ ] 利用 OpenClaw heartbeat/cron 机制
- [ ] 每日自动：导航 Outer Knowledge → 生成推荐 briefing
- [ ] 推送到飞书/对话
