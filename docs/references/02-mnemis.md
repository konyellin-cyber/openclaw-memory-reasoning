# Mnemis — Dual-Route Retrieval on Hierarchical Graphs

> **相关度: ★★★★☆** — 层次图记忆 + System-1/System-2 双路径

## 基本信息

- **标题**: Mnemis: Dual-Route Retrieval on Hierarchical Graphs for Long-Term LLM Memory
- **作者**: Zihao Tang, Xin Yu, Ziyu Xiao 等 (12人)
- **日期**: 2026-02
- **链接**: https://arxiv.org/abs/2602.15313
- **领域**: cs.CL
- **评估结果**: LoCoMo 93.9, LongMemEval-S 91.6 (SOTA, GPT-4.1-mini)

## 核心方法

- **System-1 路径**（快思考）: 基于向量相似度的快速检索，操作基础图
- **System-2 路径**（慢思考）: 层级图上的全局选择，自上而下遍历，处理需要全局推理的复杂查询
- 结合两条路径，检索既语义相关又结构重要的记忆项
- 模仿认知科学中的双过程理论（Kahneman System 1 & 2）

## 与语义路标的对比

| 维度 | Mnemis | 语义路标 |
|------|--------|---------|
| **检索路径** | System-1（向量）+ System-2（层次遍历）双路径 | **仅 System-2 风格**——纯 LLM 推理导航 |
| **是否依赖 embedding** | ✅ System-1 路径需要 | ❌ 完全不用 |
| **层次图** | ✅ 有层级图组织 | ✅ 多层语义网 |
| **自生长** | 未强调 | LLM 自主重整 |
| **设计哲学** | 两条路互补，效率优先 | 基座够强就不需要 System-1 |
| **目标场景** | 长期对话记忆 | 知识组织 + 推荐导航 |

## 重叠点

- 层次图组织记忆 ✅
- 自上而下遍历检索 ✅
- 关注长期记忆管理 ✅

## 关键差异（哲学层面的分歧）

1. Mnemis 认为**需要两条路互补**（快速直觉 + 深度推理）
2. 语义路标认为**基座够强就不需要 System-1**——拒绝向量检索，全靠 LLM 推理
3. 这是对"当前 LLM 能力够不够"的不同判断：Mnemis 做工程妥协，语义路标赌基座进化
