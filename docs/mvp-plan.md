# 语义路标记忆系统 — 实现计划

> 项目愿景见 [proposal.md](./proposal.md)，技术架构见 [technical-design.md](./technical-design.md)，文档索引见 [INDEX.md](./INDEX.md)

**日期**: 2026-03-05

---

## 当前位置

```
已完成                                    当前 / 待实现
─────────                                ──────────────
✅ RSS 拉取 + 存储 + search_feed         ⬅ 你在这里
✅ 摘要卡生成 + 入库归类                  ⏳ Phase R: Plugin → Skill 重构
✅ 语义网分裂（10 子节点 + 边）           ⏳ Phase 4: 内部记忆语义路标
✅ 导航式检索（省 96% token）             ⏳ Phase 5: 内部驱动外部检索
✅ 多节点归类 + 微感知信号                ⏳ Phase 6: 淘汰机制
✅ 自生长触发器（代码完成）               ⏳ Phase 7: 主动 briefing
✅ 设计方案收敛（第十至十三章）
```

---

## 总体节奏

```
Phase R:  Plugin → Skill 重构（~1-2 周）
  → graph.ts 泛化 + semantic-navigator Skill + Plugin 瘦身

Phase 4:  内部记忆语义路标（~2 周）
  → 内部记忆实体拆分 + 摘要卡生成 + 语义网构建 + 重整

Phase 5:  内部驱动外部检索（~1-2 周）
  → 从内部记忆图谱生成检索 query + 自动搜索论文入库

Phase 6:  淘汰机制（~1-2 周）
  → 主动淘汰（内部变化驱动）+ 被动淘汰（规模超限）

Phase 7:  主动 briefing（~1 周）
  → 每日自动：读内部记忆 + 导航外部记忆 → 推荐摘要
```

---

## 已完成阶段摘要

### Phase 1：摘要卡 + 单节点归类 ✅

- 7268 篇论文数据积累（cs.IR + cs.AI + cs.LG）
- LLM 自动生成摘要卡（压缩比 2.9x，2.9s/篇）
- 冷启动归类（全部归 root，588 篇入库验证通过）
- search_feed 升级为摘要卡格式

### Phase 2：多节点语义网 + LLM 导航 ✅

- 两阶段分裂：root → 10 子节点 + 7 边，81% 论文分出
- 导航式检索：token 消耗省 96.3%（1,174 vs 31,387）
- 多节点归类：6/6 正确，支持多归属
- navigate_knowledge 成为唯一对外工具

### Phase 3：自生长触发器 ✅（代码完成，待真实触发验证）

- 三个触发条件实现：论文数阈值 / 低置信度比例 / 定时兜底
- Service Pipeline 集成：fetch → summarize → classify → trigger → (reorg)
- 单元测试 17/17 通过

> 详细执行日志见 [references/checklist-archive.md](./references/checklist-archive.md)

---

## Phase R：Plugin → Skill 重构

> 与后续 Phase 并行推进。技术设计详见 [technical-design.md](./technical-design.md) 第三章。

**目标**：将交互层从 Plugin tool 迁移到 Skill，为双记忆架构打基础。

| 步骤 | 内容 | 依赖 |
|------|------|------|
| R.0 | graph.ts 泛化（papers→items, SummaryCard→ContentCard） | 无 |
| R.1 | 创建 semantic-navigator Skill（navigate.ts --source --action） | R.0 |
| R.2 | 记忆索引构建（memory/ → graph.json + cards/） | R.0 |
| R.3 | memory-manager 联动（写入新记忆后增量更新索引） | R.2 |
| R.4 | AGENTS.md 对接（导航 Skill 优先，MEMORY.md 降级） | R.1 |
| R.5 | Plugin 瘦身（移除 navigate_knowledge tool，只保留 registerService） | R.1 |

**验证点**：

| 步骤 | 验证标准 |
|------|---------|
| R.0 | `npx tsc --noEmit` 零错误；现有论文数据（graph.json + cards/）在泛化后读写正常，无数据丢失 |
| R.1 | Agent 调用 `semantic-navigator --source papers` 导航论文，结果与旧 Plugin tool 一致 |
| R.2 | `memory/*.md` 全量索引到独立目录（如 `memory-index/`）；生成的 graph.json 节点数 ≥ 3；原 `memory/` 目录零变更 |
| R.3 | 通过 memory-manager 写入一条新记忆后，索引目录中 graph.json 和对应 card 自动更新 |
| R.4 | Agent 在对话中优先通过 Skill 导航，不再依赖 MEMORY.md 全文读取 |
| R.5 | Plugin 中 `navigate_knowledge` tool 移除后，`registerService` 正常运行；旧 tool 调用返回明确的弃用提示 |
| 整体 | 端到端：Agent 分别用 `--source papers` 和 `--source memory` 完成一次完整导航，返回相关内容 |

**风险点 — 记忆存储兼容性**：
- 现有 `memory/` 目录是 OpenClaw memory-manager 的写入目标，正在线上使用
- 语义路标体系（graph.json、cards/、signals.json）**必须放在独立目录**（如 `memory-index/` 或 `semantic-store/`），不能混入现有 `memory/` 结构
- 原则：**只读引用 `memory/`，索引产物写到新目录**。原有记忆的读写流程不受任何影响
- R.2 步骤中"记忆索引构建"需要明确：输入源是 `memory/*.md`（只读），输出目标是新目录

---

## Phase 4：内部记忆语义路标

> 技术设计详见 [technical-design.md](./technical-design.md) 第四章。

**目标**：用语义路标重整内部记忆，产出"用户当前关注方向图谱"。

| 步骤 | 内容 | 说明 |
|------|------|------|
| 4.1 | 内部记忆实体拆分器 | memory/*.md → 按段落/section 拆分为独立实体 |
| 4.2 | 内部记忆摘要卡生成 | 每个实体生成 ContentCard（type: "memory"） |
| 4.3 | 初始语义网构建 | 从目录结构自动生成初始节点 + LLM 补充归类 |
| 4.4 | 内部记忆重整 | 复用 reorganizer.ts，对内部记忆图执行分裂/合并/建边 |
| 4.5 | 关注方向图谱提取 | 从重整后的路标图提取"当前活跃方向"快照 |

**验证点**：
- 内部记忆图有 5+ 个有意义的节点
- 重整后的结构反映用户真实的关注方向
- 关注方向图谱可导出为结构化数据

---

## Phase 5：内部驱动外部检索

**目标**：从内部记忆图谱自动生成检索 query，搜索论文入库。

| 步骤 | 内容 | 说明 |
|------|------|------|
| 5.1 | 检索 query 生成器 | 从活跃节点提取关键词/问题 → 生成搜索 query |
| 5.2 | 论文搜索 API 对接 | arXiv API / Semantic Scholar API |
| 5.3 | 搜索结果入库管道 | 搜索 → 去重 → 摘要卡 → 归类 → 入库 |
| 5.4 | 循环调度 | 内部记忆重整后自动触发一轮外部检索 |

**验证点**：
- 生成的 query 与内部记忆关注方向匹配
- 搜索到的论文质量高于随机 RSS 拉取
- 入库管道端到端跑通

---

## Phase 6：淘汰机制

**目标**：控制外部记忆规模，保持论文库与用户兴趣同步。

| 步骤 | 内容 | 说明 |
|------|------|------|
| 6.1 | 主动淘汰 | 内部记忆重整后，对比前后图谱差异 → 降权弱化方向的论文 |
| 6.2 | 被动淘汰 | 论文数超阈值 → 按综合指标（相关度+命中次数+时间）排序清理 |
| 6.3 | 淘汰分级 | 三级淘汰：移出导航热点 → 摘要卡归档 → 物理删除（可配置） |

**验证点**：
- 淘汰后论文库规模可控
- 淘汰的论文确实是与当前兴趣不相关的
- 不误删仍有价值的论文

---

## Phase 7：主动 briefing

**目标**：每日自动生成推荐摘要，推送到飞书/对话。

| 步骤 | 内容 | 说明 |
|------|------|------|
| 7.1 | 调研 OpenClaw heartbeat/cron API | 确认 Plugin cron + LLM 调用可行性 |
| 7.2 | briefing 生成器 | 读内部记忆 + 导航外部记忆 → 3-5 篇推荐 + 理由 |
| 7.3 | 推送通道 | 飞书 webhook / OpenClaw 消息 API |

---

## 时间线和风险

| 阶段 | 耗时估计 | 核心验证 | 风险 |
|------|---------|---------|------|
| **Phase R** | ~1-2 周 | graph.ts 泛化零错误、Skill 导航可用 | 低-中（需确保不破坏现有 `memory/` 存储；新记忆体系应独立目录） |
| **Phase 4** | ~2 周 | 内部记忆重整质量、关注方向图谱准确度 | 中（内部记忆粒度和结构的设计挑战） |
| **Phase 5** | ~1-2 周 | 检索 query 质量、论文搜索 API 对接 | 低-中（API 对接是成熟工作） |
| **Phase 6** | ~1-2 周 | 淘汰策略的准确性、不误删有价值论文 | 中（需要积累数据验证） |
| **Phase 7** | ~1 周 | briefing 质量、推送通道稳定性 | 低 |

**关键里程碑**：Phase 4 是双记忆架构的核心验证点——内部记忆的语义路标重整质量，直接决定后续所有阶段的效果。

---

## 已确认决策

1. **LLM 调用方式**：`runEmbeddedPiAgent` 通过 `extensionAPI.js` 加载，已验证可用
2. **默认模型**：`alibaba/qwen3-coder-plus`（DashScope Coding 端点），先跑通再优化
3. **内外记忆用同一套重整机制**：共享 reorganizer.ts，通过数据路径切换
4. **搜索论文先入库后淘汰**：不做预筛，入库成本低，淘汰需要全局视角
5. **淘汰是双驱动**：内部记忆变化→主动淘汰，规模超限→被动淘汰

---

_最后更新: 2026-03-05（项目进入双记忆架构阶段，重新定义实现计划）_
