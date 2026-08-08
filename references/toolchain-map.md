# 工具链环节映射

> 来源：task-priority 计划 v7「工具链环节映射」表（原样落盘）。
> 用途：每个环节该调哪个工具、解决什么问题——phase 执行时按此表取用，不临场发明。

| 环节 | 工具 | 作用 |
|---|---|---|
| 调研期 | `codemap.mjs --full` / LSP findReferences | 反向依赖 = 影响面提前暴露：「你以为只改 A，实际波及 store/app」 |
| 调研期 | `git log --since=14d` 热区 + `gh issue/pr` 搜索 | 相邻未愈问题、撞车预警 |
| SC 提炼期 | sc-preflight 五态（隔离 worktree 内） | 拦编造命令、暴露空转 SC、把 infra 失败与真红分开 |
| 分组派工期 | waves-plan（union-find + 依赖边）+ capacity 现读 | 串并行机器裁决，lead 无裁量 |
| 执行后·提交前 | `size-gate.mjs`（真实 candidate） | 800 行闸最早判定点：goal 完成、送 submit-pr 前跑；**计划期无 candidate、`merge-base..HEAD` diff 为空，无法预跑、不构成门**——计划期只有人工规模估计（风险提示），由必备 pre-submit SC 组（kind=verify，尾波）落地 |
| 预演三审期 | `ui-paths/match.mjs`（预测态） | B 维度判据源（标注非真实 diff） |
| 执行后·提交前 | `pr-format-gate.mjs`（真实 candidate + 真实 PR 标题/正文） | 格式门在真实候选上判定（同属必备 pre-submit SC 组）；计划期只能人工起草 PR 标题/正文规避返工，机器门不提前开 |
| 释放期 | release-gate | 投递前重新消费落盘快照，堵住「验证后被改」窗口 |
| 执行期 | 自包含派工包段 | goal 场景C 四要素 + SC 原文 + 指令，worker 拿到即跑不反问 |
| 回流期 | gap-backfill（familyKeyOf + (repo,branch) 主关联 + 五道检查）+ ledger | 逃逸入账，下轮对抗质询弹药 |

## 调用边界（只调用不复制）

- 目标仓 `codemap.mjs`；pr-autopilot 的 `size-gate.mjs` / `ui-paths/match.mjs` / `pr-format-gate.mjs`、`verdict-validate.mjs` 导出（FACES / DEFAULT_REQUIREMENTS / familyKeyOf）、`consensus-gate.mjs` 导出（recomputeArtifactHash）、`lib/hardening-registry.mjs`（十类全量）、`config/orchestration.json`（capacity）；gh CLI；LSP；`git worktree`。
- 依赖降级：目标仓有 codemap 类工具时 probe 满血；否则降级 git+glob（标 degraded）。`git worktree` 不可用 → preflight 全标 `exists_not_run` 并声明降级。repo → registry 固定映射缺失 → B 维度 fail-closed 报缺配置，不许回落任意路径。
