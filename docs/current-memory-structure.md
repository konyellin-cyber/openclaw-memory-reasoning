# 当前记忆结构分析

## 分析时间

2026-02-28

---

## 记忆组织结构

### 目录概览

```
workspace/
├── MEMORY.md                    # 主索引 — 导航 + 主题映射表
├── USER.md                      # 用户速查卡
├── SOUL.md                      # Agent 人格
├── memory/
│   ├── YYYY-MM-DD.md            # 每日日志（多个）
│   ├── insights/                # 洞察库（按领域分片）
│   │   ├── README.md            #   索引
│   │   ├── business-product.md  #   商业/产品/执行
│   │   ├── recsys-algorithm.md  #   推荐系统/算法
│   │   ├── management-org.md    #   组织管理/知识协作
│   │   └── creation-tools.md    #   创作/工具/AI分身
│   ├── projects/                # 项目追踪
│   │   ├── README.md
│   │   └── <project-name>.md    #   每项目独立文件
│   ├── facts/                   # 事实库
│   │   ├── README.md
│   │   ├── personal.md          #   个人信息（含兴趣/偏好/生活方式）
│   │   ├── work.md              #   职场信息
│   │   └── family.md            #   家庭信息
│   ├── decisions.md             # 决策记录
│   ├── conversations.md         # 讨论记录
│   ├── todo.md                  # 待办事项
│   └── archive/                 # 归档（旧日志 + 已废弃文件）
```

### 分层设计

| 层次 | 内容 | Token 估算 | 加载时机 |
|------|------|-----------|---------|
| **L0 索引** | MEMORY.md | ~1.5K | 每次 session |
| **L1 领域索引** | insights/README.md, facts/README.md, projects/README.md | ~0.5K 各 | 涉及对应领域时 |
| **L2 具体文件** | 各个 .md 文件 | 2K-8K 各 | 匹配到具体话题时 |
| **L3 日志** | YYYY-MM-DD.md | 4K-17K 各 | "上次讨论"相关时 |

---

## 已完成的优化（2026-02-28）

### 1. 游离文件合并
- 散落在根目录的分类文件 → 合并到 `facts/` 对应子文件
- 原文件归档到 `archive/`

### 2. insights 分片
- 旧 `insights.md`（单文件）→ 拆为 4 个领域文件
- 带 README.md 索引 + 加载策略

### 3. 索引更新
- MEMORY.md 新增完整的主题→文件映射表
- 各子目录 README.md 补全

---

## 记忆管理 Skill（memory-manager）

### 能力概述

| 能力 | 实现方式 |
|------|---------|
| 内容识别（是否值得记录） | 4 项检验：增量/回忆/行为改变/用户信号 |
| 归档路由（记录到哪里） | 按内容类型 → 对应文件的映射规则 |
| 主动询问（是否需要记录） | ≥2 个检验通过 → 询问用户 |
| 记忆检索 | 按标签搜索 + 跨文件关联 |

### 脚本工具

| 脚本 | 用途 | 现状 |
|------|------|------|
| `suggest_tags.py` | 标签推荐 | 硬编码关键词匹配，较原始 |
| `archive_memory.py` | 格式化写入 | 功能正常 |
| `find_related.py` | 关联搜索 | 正则 + stopwords，较原始 |

---

## 核心问题

记忆的**组织**已经做得很好，但记忆的**加载**还停留在粗放阶段：

1. **MEMORY.md 的映射表没有被系统级执行** — 只是作为文本被 Agent "看到"
2. **没有 Reasoning Gate** — 不存在"分析意图 → 决定加载什么"的预处理步骤
3. **搜索策略不对** — embedding/FTS 是"碎片式"搜索，而不是"领域→完整文件"的结构化加载
