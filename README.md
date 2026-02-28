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
| 检索方式 | Embedding → 向量召回 → 排序模型 | **纯 LLM 推理** |
| 触发方式 | 被动推送 | **Agent 在对话中自主判断** |

---

## 工作原理

**没有任何外挂判断层**。Agent 在正常对话中自主决定是否调用 `search_feed` 工具，并将推荐自然融入回复：

```
用户消息 → Agent 正常推理
              ↓
        自主判断：当前话题和 feed 内容可能相关
              ↓
        调用 tool: search_feed → 检索本地 feed 数据
              ↓
        在回复中自然带出推荐 + 推荐理由
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

通过标准 RSS 协议拉取公开信息源，当前默认 arXiv cs.IR（Information Retrieval），后续可扩展至技术博客、社区等任意 RSS 源。

---

## 安装

### 方式一：本地开发安装

```bash
git clone https://github.com/nicepkg/openclaw-memory-reasoning.git
cd openclaw-memory-reasoning
npm install
npm run build
npm run deploy   # 编译并部署到 ~/.openclaw/extensions/personal-rec/
```

### 方式二：npm 安装（计划中）

```bash
npm install -g openclaw-plugin-personal-rec
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
│   ├── index.ts              # 插件入口：注册 service + tool
│   ├── feeds/
│   │   ├── service.ts        # 后台定时 RSS 拉取服务
│   │   ├── parser.ts         # arXiv RSS XML 解析器
│   │   └── storage.ts        # JSON 文件存储 + 去重 + 索引
│   └── tools/
│       └── search-feed.ts    # search_feed 工具：供 Agent 检索 feed
├── docs/
│   └── proposal.md           # 方案设计文档
├── openclaw.plugin.json      # 插件清单
├── package.json
└── tsconfig.json
```

---

## 设计原则

- **一切基于 LLM 基座** — 不做外挂检索/向量召回/路由层，Agent 自主推理和调用工具
- **模型越强越好** — 判断越准、推荐理由越深、融入对话越自然
- **零公司依赖** — 所有数据通过公开合法渠道获取（RSS）
- **管道通用、源可插拔** — 标准 RSS 协议，信息源随时增减
- **渐进式演进** — 先跑通单一信息源，再扩展

---

## 演进方向

当 feed 数据量增长到全量灌入不现实时，计划探索纯 LLM 推理检索方案：

| 方向 | 思路 |
|------|------|
| 分层推理 | LLM 做粗分类 → 只拉相关子集 → 精细推理 |
| 摘要压缩 | LLM 生成每日摘要 → Agent 先扫后细看 |
| 自主分页 | Agent 像人一样翻页浏览，自控检索深度 |
| 记忆化索引 | LLM 入库时打标签，检索时按标签过滤 |

每个方向都是"用 LLM 推理替代传统检索的某个环节"。

---

## License

MIT
