# SC 颗粒度例句库

> 来源：2026-08 从 `~/.claude/.goal/` 75 份台账实测挖出的真实例句（标注来源文件名），非虚构。
> 用途：Phase 2 起草 SC 时按四层颗粒度对号入座；目标是「一条 SC 可被机器/worker 独立验证」，而不是「写得好看」。

## 四层颗粒度（从粗到细）

### 1. 目标级（一 PR 一条）

描述一个 PR 的整体行为变化，不展开内部细节。

> 「删除 gh pr merge,改为 pr-opened 输出,记录 mergeStateStatus」 — 来源：`changelog-merge-deadlock.md`

**适用**：PR 拆分预判、优先级清单顶层描述。目标级 SC 通常需要下挂结构断言级 SC 才可验证。

### 2. 结构断言级

断言改动后系统某条结构不变式成立，可 grep / 静态检查 / schema 校验验证。

> 「改 schema_version v3→v1 重算 hash → 三消费入口全部必拒」 — 来源：`i9-r2-core-fix.md`

**适用**：契约类、hash 类、消费入口类断言。特征是「不看运行结果，只看结构」。

### 3. file:line 锚点级

把验证锚点钉到具体文件行区间，worker 拿到即去核对，不靠描述猜位置。

> 「probe.mjs:59-61→probe.mjs:62-64(异常 catch→exit0)」 — 来源：`pr12-attempt2-b1-g1.md`

**适用**：修某个具体位置、把错误路径改成功路径的改动。锚点必须真实覆盖其声称的行为（见 gap-catalog 的 C1-D1 / f2 家族教训——文档引用的 file:line 必须与 candidate 树实际符号位置一致）。

### 4. 反向变异级

用「破坏后必须红」作为判据，验证守卫生效。

> 「挖空四个校验调用点→对应 SC 必须转红,失败模式互相隔离」 — 来源：`i9-r2-core-fix.md`

**适用**：门禁/守卫/校验类改动。判据 = 反向变异（或 mutation）下目标断言恰好红掉，且几种失败模式互相隔离（隔一种失败模式只红对应那条，不串红）。

### 5. 穷举覆盖级

矩阵本身即一条 SC——所有格子必须枚举，缺格即红。

> 矩阵本身即一条 SC — 来源：`mivo-561-w4-report.md` SC29（mivo-561 的 38 条 SC 中，覆盖矩阵以「整张矩阵完整」作为一条独立 SC）

**适用**：多维度组合（如 status × 路径 × 面）需要全覆盖时，把「矩阵无缺格」本身写成 SC，由 coverage-matrix 机器判。

## 实测规模

一个优先级对应 **4-15 条 SC**：

- `bd-disarm` 一包 **7 条**（bd-disarm 台账）
- `482-r2` 一 PR **14 条**（482-r2 台账）
- `mivo-561` 两轮扩容 **9 → 30 → 38 条**（mivo-561-w4-report.md / mivo-561-sc-final.md）

> 教训：SC 条数偏少（< 4）通常是颗粒度不足，执行期会炸出漏网返工；扩容两轮才到 38 条说明首轮就没把边界枚举完。

## 三段式硬规则

每一条 SC 必须能写出三段，写不出第三段的 SC 不合格：

1. **改什么**（change）：对哪个对象做什么改动
2. **什么该成立**（holds）：改动后哪个不变式/行为必须成立
3. **怎么验证**（verify）：可执行命令 + 期望输出（expect）——必须可观察、可复现、可由机器或 worker 独立判定

## 必备 pre-submit SC 组（模板，每个 priority 三条）

> 每个 `functional_pr=true` 的 priority 必须带这三条 `kind=verify` 的 SC（SKILL.md「必备 pre-submit SC 组」）。它们把 submit-pr 的三个机器闸搬到真实 candidate 上——这是 800 行闸最早可被真实判定的时点；计划期无 candidate 无法预跑，任何预演都只会假 PASS。`<prAutopilotRoot>` 本机 = `/Users/praise/AI-Agent/Claude/capabilities/source/pr-autopilot`（`config/defaults.json` 硬编码），其余 `<...>` 为执行期实参（候选仓路径 / PR 标题与正文文件）。

```json
[
  {
    "id": "presubmit-size-<priority_id>",
    "priority_id": "<priority_id>",
    "kind": "verify",
    "granularity": "assertion",
    "change": "在真实 candidate（goal 实现完成后的候选分支）上运行 submit-pr 的 size-gate",
    "holds": "size-gate 对 candidate 的 merge-base..HEAD 真实 diff 判 PASS（result ≠ STOP），输出 head_sha 与候选分支 HEAD 一致；判 STOP 时拆 PR 是唯一出路（800 行闸硬红线，不许豁免/游说）",
    "verify": {
      "cmd": "node",
      "args": ["<prAutopilotRoot>/scripts/size-gate.mjs", "--repo-dir", "<候选仓>", "--base", "origin/main"]
    },
    "expect": "exit 0 且 JSON 输出 result ≠ STOP；head_sha == git rev-parse HEAD（先记录候选 SHA 再跑，绑定同一次 candidate）",
    "anchor_paths": [],
    "faces": ["G"],
    "depends_on": []
  },
  {
    "id": "presubmit-format-<priority_id>",
    "priority_id": "<priority_id>",
    "kind": "verify",
    "granularity": "assertion",
    "change": "在真实 candidate 上运行 submit-pr 的 pr-format-gate（真实 PR 标题/正文）",
    "holds": "pr-format-gate 双读（base 树 + 候选树）判 result ≠ FAIL；候选树收紧规则当场生效、放宽方向被 base 侧拦截",
    "verify": {
      "cmd": "node",
      "args": ["<prAutopilotRoot>/scripts/pr-format-gate.mjs", "--repo-dir", "<候选仓>", "--base", "origin/main", "--title", "<PR 标题>", "--body-file", "<PR 正文文件>"]
    },
    "expect": "exit 0 且 JSON 输出 result ≠ FAIL；执行报告记录本次候选 HEAD SHA 并绑定闸结果",
    "anchor_paths": [],
    "faces": ["G"],
    "depends_on": []
  },
  {
    "id": "presubmit-intent-<priority_id>",
    "priority_id": "<priority_id>",
    "kind": "verify",
    "granularity": "assertion",
    "change": "在真实 candidate 上运行 submit-pr 的 intent-check（PR body marker ↔ .pr-intent.md 双副本一致）",
    "holds": "intent-check 两副本 digest 一致（OK/REBUILT 均 exit 0）；MARKER_MISSING/FALLBACK（exit 2）是 action-required 不是通过——marker 落 PR body 后重跑至 exit 0",
    "verify": {
      "cmd": "node",
      "args": ["<prAutopilotRoot>/scripts/intent-check.mjs", "--pr-body", "<PR 正文文件>"]
    },
    "expect": "exit 0 且 JSON 输出 status ∈ {OK, REBUILT}；执行报告记录本次候选 HEAD SHA 并绑定闸结果",
    "anchor_paths": [],
    "faces": ["G"],
    "depends_on": []
  }
]
```

**使用注意**：
- 三条 SC 的 `kind=verify` → waves-plan 自动排尾波（恒在 fix 之后），goal 实现完成后、送 submit-pr 前执行；`anchor_paths` 留空（闸不碰文件，独立一组自由并行）。
- 计划期 sc-preflight 对 `cmd=node` 恒判 `exists_not_run`（node ∈ existsOnly 清单，只验存在性）——**不得当绿采信**，这正是「计划期跑不了真实闸」的机器表达。
- coverage 建议挂 `face G`（声称核实）与 `gate format-gate` 维度；机器层对「必备」无断言，由 lead 起草时执行。

## 坏例句（禁止）

- 「优化代码质量」 — 改什么？什么算好？怎么验证？三段全缺
- 「确保测试通过」 — 没指定哪个测试、什么命令、期望输出
- 「修复 reviewer 提到的问题」 — 没列出 reviewer 的问题原文、没有验证锚点
