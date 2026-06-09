# 翡翠厅 — 项目规则

## SDD 优先工作流

SDD 文件位于 `openspec/changes/online-texas-holdem/`，包含 `design.md`（决策与场景）和 `tasks.md`（任务清单）。

**每次有设计决策、功能变更、功能取消时，必须按以下顺序执行：**

1. 先更新 `design.md` 和/或 `tasks.md`
2. 再写代码
3. commit 包含 SDD 更新

不等用户提醒，主动执行。

### 什么时候更新 SDD

| 变更类型 | 更新位置 |
|---|---|
| 取消/移除功能 | tasks.md 标 `~~cancelled~~` + 记原因；design.md 更新场景 |
| 设计决策变更 | design.md Decisions 节 |
| 新需求从对话浮现 | design.md Open Questions → 确认后加 tasks.md → 再写代码 |
| 任务完成 | tasks.md 勾选 `[x]` |
| 微调 UX（颜色/动画） | 不用更新，commit message 记录即可 |

## Git 规则

- 不经用户明确指令，不自动 push
- commit message 用英文，格式：`type: description`
