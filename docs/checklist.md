# MVP Checklist

> 目标：聊天中聊到相关话题时，agent 自己调 `search_feed` 工具查 feed，在回复中自然带出论文推荐。

## 已完成

- [x] 项目脚手架（package.json、tsconfig.json、openclaw.plugin.json）
- [x] Plugin 入口（src/index.ts）— 注册 service + tool
- [x] RSS 拉取 Service（src/feeds/service.ts）— 后台定时拉取 arXiv RSS
- [x] RSS 解析器（src/feeds/parser.ts）— 解析 arXiv RSS XML 为结构化数据
- [x] Feed 存储（src/feeds/storage.ts）— JSON 文件存储 + 去重 + 索引
- [x] search_feed Tool（src/tools/search-feed.ts）— agent 可调用的检索工具
- [x] TypeScript 编译通过（零错误）
- [x] 本地调试配置（~/.openclaw/openclaw.json 中加了 plugins.load.paths + personal-rec entry）

## 待验证

- [ ] 重启 OpenClaw Gateway，确认 plugin 加载成功
- [ ] 确认 RSS 拉取 service 启动后能成功拉到 arXiv 数据
- [ ] 确认 feed 数据正确存储到 ~/.openclaw/state/personal-rec/feeds/
- [ ] 在对话中测试 agent 是否能自主调用 search_feed
- [ ] 验证推荐结果质量 — agent 能否从论文中选出和话题相关的并给出理由

## 待迭代（MVP 之后）

- [ ] 核心课题：LLM 推理做大规模检索（分层推理 / 摘要压缩 / 自主分页 / 记忆化索引）
- [ ] 多信息源支持（arXiv cs.AI、技术博客等）
- [ ] 反馈记录（点开/忽略/评价）
- [ ] 历史数据管理（过期清理、容量控制）
- [ ] 推荐效果评估
- [ ] npm 发布
