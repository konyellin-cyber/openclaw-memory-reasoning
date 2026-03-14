# HiAgent — Hierarchical Working Memory Management

> **相关度: ★★☆☆☆** — 层次化记忆管理，但解决不同问题（单任务上下文压缩）

## 基本信息

- **标题**: HiAgent: Hierarchical Working Memory Management for Solving Long-Horizon Agent Tasks with Large Language Model
- **作者**: Mengkang Hu, Tianxing Chen, Qiguang Chen, Yao Mu, Wenqi Shao, Ping Luo
- **日期**: 2024-08
- **链接**: https://arxiv.org/abs/2408.09559
- **领域**: cs.AI
- **评估结果**: 2x 成功率提升，平均减少 3.8 步

## 核心方法

- 将工作记忆按**子目标**分层组织
- LLM 主动决定何时用摘要替换旧的子目标上下文
- 仅保留与当前子目标相关的动作-观察对
- 解决长视距任务中的上下文冗余问题

## 与语义路标的对比

| 维度 | HiAgent | 语义路标 |
|------|---------|---------|
| **解决的问题** | 单次任务内的上下文压缩 | **跨时间的知识组织** |
| **层次化** | 子目标层级 | 语义网层级 |
| **时间范围** | 单任务周期 | 长期持续增长 |
| **记忆类型** | 工作记忆（短期） | 知识记忆（长期） |
| **自生长** | ❌ | ✅ |

## 参考价值

- "层次化管理 + LLM 主动决策"的设计模式与语义路标有共鸣
- 验证了 LLM 能做好"何时压缩/何时保留"的判断 → 支持语义路标中 LLM 自主重整的可行性
- 但本质是任务执行优化，不是知识组织
