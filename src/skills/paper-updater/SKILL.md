---
name: paper-updater
description: 手动触发个人推荐系统的论文更新管道。当用户说"更新论文""拉取论文""跑一下论文管道""paper update""更新推荐系统"等时使用。支持：拉取新论文、生成摘要卡、归类入库、检查自动重整触发条件。默认使用分批模式避免超时。
---

# Paper Updater

## Overview

这个 skill 用于手动触发 personal-rec 插件的论文更新管道，替代等待 6 小时自动周期。

## 使用场景

- 用户说"更新论文"、"拉取新论文"、"跑一下论文管道"
- 用户想立即看到新增订阅源的效果
- 用户想检查当前论文库状态

## 前置条件

- personal-rec 插件已部署到 `~/.openclaw/extensions/personal-rec/`
- 项目源码在 `~/openclaw-memory-reasoning/`

## 执行流程

### Step 1: 检查当前状态

先运行状态检查脚本，了解当前论文库情况：

```bash
cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/check-status.js
```

这会输出：
- 各 feed 文件数量和论文数
- 摘要卡总数
- graph 节点分布
- 最近的归类信号

### Step 2: 执行更新管道（默认分批模式）

**默认使用分批模式**，每批处理 80 篇，避免长时间运行被系统终止：

```bash
cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/run-pipeline-batch.js 2>&1
```

**分批脚本特性**：
- 每批默认处理 80 篇（约 4-6 分钟），不会触发系统超时
- 自动跳过已有摘要卡的论文（断点续跑）
- 运行完会显示剩余待处理数量，**重复运行即可处理下一批**
- 所有批次完成后会显示 "所有论文摘要卡已完成"

**可选参数**：
- `--batch N` — 调整每批数量（默认 80，建议 50-100）
- `--skip-fetch` — 跳过 fetch 步骤（已有 feed 数据时加速）
- `--skip-classify` — 只生成摘要卡，跳过归类

示例：
```bash
# 小批量测试
cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/run-pipeline-batch.js --batch 20 2>&1

# 跳过 fetch 直接处理
cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/run-pipeline-batch.js --skip-fetch 2>&1
```

**当待处理论文较多时的工作流**：

1. 第一次运行：fetch + 处理前 80 篇
2. 后续运行：加 `--skip-fetch`，每次处理下一批 80 篇
3. 重复直到输出 "所有论文摘要卡已完成"

### Step 2（备选）: 完整模式（本地使用）

如果在本地运行且不担心超时，可使用完整管道一次性处理所有论文：

```bash
cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/run-pipeline.js 2>&1
```

⚠️ 大量新论文时（>100 篇）可能耗时数十分钟，**飞书等有超时限制的环境请用分批模式**。

### Step 3: 确认结果

管道完成后再次运行状态检查，对比前后变化：

```bash
cd ~/openclaw-memory-reasoning && npx tsx dist/skills/paper-updater/check-status.js
```

## 配置

论文源配置在两个地方（优先级从高到低）：

1. `~/.openclaw/openclaw.json` → `plugins.entries.personal-rec.config.feeds`（运行时覆盖）
2. 代码 `src/index.ts` → `DEFAULT_FEEDS`（兜底默认值）

当前订阅的 6 个 arXiv 分类：

| 分类 | 方向 |
|---|---|
| cs.IR | 信息检索 |
| cs.AI | 人工智能 |
| cs.LG | 机器学习 |
| cs.SI | 社交网络与信息网络 |
| cs.CL | NLP/计算语言学 |
| cs.CV | 计算机视觉 |

## 故障排查

| 问题 | 原因 | 解决 |
|---|---|---|
| 进程被 SIGKILL 终止 | 运行时间超出系统限制 | 改用分批模式 `run-pipeline-batch.js` |
| "No available auth profile" | LLM provider rate limit | 等几分钟后重跑 |
| 摘要卡生成 0 张 | 所有论文已有卡片 | 正常，无需处理 |
| 归类跳过全部 | 所有卡片已入库 | 正常，无需处理 |
| fetch 返回 0 篇 | arXiv API 暂时不可用 | 稍后重试 |
