---
name: task-priority
description: 汇总任务优先级 / 汇总问题优先级（task priority / SC 提炼 / 优先级清单）。在「任务目标」与「goal 派工执行」之间插入前置工序：把任务拆成完整优先级清单 + 多颗粒度 SC（Success Criteria），用本地三审七面维度反推补全，经对抗质询 + 机器预验证后出 final 双产物（人读 priority-plan.md + 机器 task-manifest.json），让 goal 精准消费、让三审不再是遗漏的第一发现者。触发词：汇总任务优先级、汇总问题优先级。
---

# task-priority — 汇总任务优先级 + SC 提炼

> 定位：在「任务目标（+deep research）」和「goal 派 worker 执行」之间的一道前置工序。
> 产出：完整优先级清单 + 多颗粒度 SC → 对抗质询 + 机器预验证 → final 双产物（priority-plan.md + task-manifest.json）。
> 不做：修复执行（归 goal）、三审 verdict（归 submit-pr）、自动派工/自动对外 push。

## 为什么需要本 skill（近 7 天实测，不是推测）

- goal 调用 120 次 vs submit-pr 41 次（≈3:1）——大量执行轮消耗在返修。
- mivo-canvas 近 7 天 165 个 PR：`fix(` 前缀 43 个（26%）、带「后续修复/回归/收口」14 个（8%）、事后拆分列车 20 个（12%）。
- SC 台账挖掘（`~/.claude/.goal/` 75 份）：mivo-561 的 SC 从 9 → 30 → 38 条两轮扩容；bd-disarm 第 17 轮才发现「永久饥饿」（前 10 轮全过）；review-pr-r1-prescan 的 v1 架构假设整版被推翻重写。**全是「前期遗漏、到三审/执行期才暴露」的返工。**
- 三审 verdict 挖掘（15 份）：最常 fail 是 **D 文档（5 次）> G 声称核实（4 次）**；12 条 major finding 实为 **6 个反复复发的 invariant 家族**——审查拦的是少数几类反复犯的问题，可前置预测。

**经济账**：本 skill 单次成本约 50-150k token。成立的前提是省下一轮三审返工——因此**只用于多 PR / 跨模块 / 影响面不明的任务**；单文件小修不要触发（见 Phase 0 适用边界）。

## 核心机制 A：两阶段契约（消除 Phase 3 死锁）

`manifest-validate.mjs --stage=draft|final` 两份**显式契约**，**禁止用可选字段静默兼容**。

**通用 exact 规则**：每阶段定义三个键集 —— **必备**（缺即拒）、**允许可选**（可有可无）、**其余一律拒**（`additionalProperties: false`）。任何顶层字段必须显式落在前两类之一，否则视为契约漏洞。

| stage | 必备 | 允许可选 | 其余（出现即拒） |
|---|---|---|---|
| `draft`（Phase 3 调用） | `schema_version` / `slug` / `goal` / `context_refs`（数组，可为空数组——任务可能无调研来源，但键必须在场，表明「已考虑过上下文来源」）/ `priorities` / `scs`（三段式非空、anchor_paths 路径安全、faces 枚举、`kind=fix` 的 `predicted_invariant`+`predicted_primary_face` 非空）/ `coverage`（域/枚举/唯一性/引用完整性） | 无 | `waves` / `dispatch` / `receipts` / `manifest_core_hash` / `scs[].preflight` / 任何未列键 |
| `final`（Phase 6a 后、final-gate 内调用） | draft 全部必备 **+** `scs[].preflight` / `waves` / `dispatch`（capacity + packets 自包含全项）/ `manifest_core_hash` | `receipts`（final-gate 后写，validator 不要求也不拒） | 任何未列键 |

## 核心机制 B：三个 hash + release-gate（时序不可交换）

**hash 定义（排除键为黑名单，非字段白名单——新增字段自动纳入，防漏算）**：

| hash | 覆盖 | 排除键（递归剔除后规范化） |
|---|---|---|
| `manifest_core_hash` | manifest **全部字段**（含 `schema_version` / `slug`） | `manifest_core_hash`、`receipts`、`dispatch.packets[].manifest_core_hash` |
| `plan_hash` | priority-plan.md 正文 | 尾部 receipts 区块 |
| `artifact_hash` | — | 由 authority 的 `recomputeArtifactHash` 产出，不自算 |

排除键清单为 `lib/hashing.mjs` **单一实现**，禁各脚本各自剔除。

**时序（不可交换，含 release-gate 消除 TOCTOU）**：

```
Phase 4 末   对抗质询后写 review-receipt.json（存在性 + 谱系由 final-gate 校验，见核心机制 G）
Phase 5 末   packets 全部生成完毕（此后不新增/不修改）
Phase 6a     算 manifest_core_hash → 回填顶层与各 packet 的绑定字段（排除键使其成为不动点，无环）
Phase 6b     渲染 priority-plan.md（含 marker 包夹的机器投影区）→ 算 plan_hash
Phase 6c     写盘双产物 → final-gate 回读重算 + 逐闸定序回放 + 最终检查（投影区逐字节比对 +
             review-receipt 谱系）→ 写 receipts（绑 slug+双 hash）
Phase 6d     ★release-gate（投递前强制）★
             ① 从磁盘取同一次快照回读 plan + manifest（不用内存副本）
             ② 用 lib/hashing 重算双 hash，与 receipts 内值逐字比对
             ③ 校验 manifest.slug == 调用方 `--slug`（身份绑定；实现见 final-gate.mjs 的
               SLUG_MISMATCH。**不绑目录名**——目录名只是容器，绑它属额外约束，2026-08-09
               e2e 实测确认当前只绑 --slug。跨 slug 误配仍被拦：拿 A 的 slug 指向 B 的目录，
               B 的 manifest.slug=B ≠ A → 拒）
             ④ 全部匹配 → 从该已验证快照读取 packet 文本投递；任一漂移 → 回 Phase 2/5 重走
             用户拍板 = 释放，不是变更：拍板不新增/改任何 packet 或 SC；要改内容就回炉，
             hash 重算，旧 receipts 依漂移自动失效
Phase 6d 附  release-gate 通过时写 release-receipt：
             {slug, manifest_core_hash, plan_hash,
              canonical_repo,    ← 主关联键之一：离线派生——git remote get-url origin
                                   经 lib/repo-identity.mjs 确定性规范化得 owner/name，不依赖 gh
              branch,            ← 主关联键之一：git rev-parse --abbrev-ref HEAD，释放时必然可得
              pr_number,         ← 辅助键：有 draft PR 时经 gh 探测或 --pr-number 显式传，否则 null
              binding_strength,  ← 'strong'(pr_number 非 null 且 gh 可用) | 'weak'(报告须标注)
              base_sha,          ← 仅诊断，不做等值检查（rebase 后合法变化）
              released_at}
```

## 核心机制 G：双产物语义绑定（机器投影区 + 对抗质询 receipt）

**背景（P1-A/P1-B，2026-08-09 实测）**：manifestCoreHash 与 planHash 是两个互不引用的函数——
final-gate 只分别校验「各自与自己的 receipt 相符」，没有任何跨产物语义比对；且 Phase 4 对抗质询
没有可消费工件，跳过它直接填结构合法的 manifest 也能七闸全过。

**① 机器投影区（P1-A）**：priority-plan.md 保留人读的自由散文，其中一段由 manifest **确定性渲染**
并用 marker 包夹（`<!-- task-priority:projection:start -->` … `<!-- task-priority:projection:end -->`）。
渲染内容至少含 SC 清单（id + 三段式 change/holds/verify）、派工组（waves 分组）、残余风险
（coverage 的 n_a 格——manifest 无独立 residual_risks 字段，机器可判的残余即 n_a 格）。final-gate
最终检查从 manifest **现渲染**投影、与 plan 内 marker 区块逐字节比对，不等即拒
（PLAN_PROJECTION_MISMATCH / 缺 marker → PLAN_PROJECTION_MISSING）；marker 区外的自由散文
不受约束——人话归人，事实归机器。渲染/提取的单一实现：`scripts/lib/plan-projection.mjs`。

**② Phase 4 review receipt（P1-B，最小形态）**：对抗质询后写 `review-receipt.json` 进产物目录。
最小字段：被审草稿的 `draft_manifest_core_hash`、consumed gap-catalog 与 ledger 的指纹、
`reviewer_count`、逐条 challenge 的 `disposition`（含「补了哪条 SC」或「无漏项」）。生成命令
（scaffold 后由 lead 补 challenges[]）：

```bash
node <SKILL_ROOT>/scripts/lib/review-receipt.mjs --draft-manifest <草稿.json> \
     --ledger-fingerprint <Phase 1 ledger-query 输出的 fingerprint> [--reviewer-count N] [--out <路径>]
```

final-gate 校验：**存在性 + hash 关联**——receipt 的草稿 hash 必须对得上当前 manifest 的谱系
（`draftAncestorHash`：把当前 manifest 还原成草稿形状重算 hash；质询后改过 SC/coverage 等
草稿期字段 → 祖先漂移 → REVIEW_RECEIPT_STALE 拒）+ gap-catalog 指纹现算比对。缺失/漂移 → 拒。
**明确不做**：不校验语义真伪——防的是漏跑，不防敷衍质询；敷衍质询的兜底本来就是三审，计划里
已如实声明。ledger 指纹由 `lib/ledger-query.mjs` 产出（唯一实现），本机制只消费其输出形状。

**判据所有权**：投影比对与 review-receipt 校验归 final-gate（与 hash/receipts 同一语义族，
经 `lib/plan-projection.mjs` / `lib/review-receipt.mjs` 执行），其余闸不判。两闸在 final-gate
内是 `FINAL_CHECK_GATES`（七闸**全过后**才评估，错误路径事件集不追加 not_run 条目）。

## 核心机制 C：判据所有权（单一 owner，不重复判）

| 判据 | owner | 另一方 |
|---|---|---|
| schema 形状 / 枚举 / cell 唯一性 / 引用完整性（sc_ids 存在且同任务）/ **SC 声明字段值域（`gates` ∈ authority GATES、`hardening_classes` ∈ authority HARDENING_CLASSES，2026-08-09）** / 路径安全 / 派工包自包含 / 阶段字段集 | `manifest-validate`（经 `lib/cell-domain.mjs`） | coverage-matrix **不判** |
| 矩阵全覆盖（缺格）/ 单任务全 n_a / n_a 的 `reason_code`+`evidence` 必填 / **B 维度 `ui_prediction` 现跑比对** / `n_a_predicted` 域限 / **covered 格的 SC 声明绑定（face→`faces`、gate→`gates`、hardening→`hardening_classes`，`CELL_FACE/GATE/HARDENING_NOT_DECLARED`，P0-B 族）** | `coverage-matrix` | manifest-validate **不判**；schema 刻意把 `reason_code`/`evidence`/`ui_prediction`/`gates`/`hardening_classes` 留作可选，否则所有权又变双头 |
| 双 hash 重算与 receipts 绑定 | `final-gate`（经 `lib/hashing.mjs`） | 其余闸只读不算 |

**前置闸 error 时后继闸 `not_run`，不是第二个红**：定序流水线（final-gate 内）为 `manifest-validate(final)` → `coverage-matrix` → `waves 一致性` → `preflight 记录消费`。前置闸失败，后继闸记录 `not_run` 并转述同一 `error_code`；final-gate 作为 wrapper 可转述，但**不算第二个 owner**。

## 核心机制 D：回流配对的诚实边界

**主关联键是 `(canonical_repo, branch)`，`pr_number` 是辅助等值键**。理由：

- 释放发生在建 PR **之前**（本 skill 到「产出 final 双产物 + 释放派工包」为止），通常还没有 PR 号 → `pr_number` 不能作主键。
- `branch` 单独不够：PR 号与分支名都**不跨仓唯一**，从错误仓运行 gh 会误过 → 主键必须是 `(canonical_repo, branch)`，且 gh 调用显式 `--repo`、不靠 cwd。
- `canonical_repo` 由 `lib/repo-identity.mjs` 从 `git remote get-url origin` **离线**确定性派生（release 与 gap-backfill 两侧复用同一函数），**gh 不在 release 关键路径上**。gh 只用于 Phase 7 检查④的 PR 反查：gh 缺失/不可用 → 该检查不可执行 → 须显式 `--allow-weak-binding` 并标注（这条降级路径真实可执行）。
- **v1 不支持 fork PR**：`headRepositoryOwner` 必须等于 `canonical_repo` 的 owner，不等即 fail-closed 拒。
- `base_sha` 只入 receipt 作诊断，不做等值检查（rebase 后合法变化 → 假拒绝）。

**配对声称按条件收窄（T1，不说全称）**：
- 无条件成立：拒旧 receipt、拒篡改 manifest、拒篡改 artifact。
- **有条件成立**：拒跨仓/跨分支/跨 PR 误配 —— 条件是 `artifact.pr_number` 非 null **且** gh 可用；否则降级弱绑定并显式标注。
- 始终不成立：同仓同分支多计划区分、同 PR 跨轮区分（需 `--expect-round`）、配对选择本身的正确性（仍是 lead 的人工决定）。

## 核心机制 E：B 维度的机器判据（派生，不采信自报）

**总纪律「派生不采信」（普适，不止 B 面）**：

> **被审对象不得选择自己的证据样本与判据配置。**
> 凡「样本集」「配置来源」可由已有数据**确定性派生**的，判据方必须自己派生；被审方自报值只允许作为**冗余副本**，且必须与派生值逐字相等（不等即拒）。让被审方同时挑样本和裁判，就能产出「自洽的假预测」。

B 维度 cell 携带结构化 `ui_prediction`，其中两项由 coverage-matrix 自己派生、**不信自报**：

```
ui_prediction: {
  input_paths[],     # 派生：coverage-matrix 从本 task 引用的全部 SC 的 anchor_paths
                     #   取并集 → 规范化(POSIX) → 去重 → 排序。cell 若落盘此值，
                     #   必须与派生值逐字相等，不等即拒（禁止裁剪样本）
  registry_path,     # 派生：由 repo → authority registry 的固定映射/allowlist 决定
                     #   （权威口径 = submit-pr SKILL.md:51 的 scripts/ui-paths/registry.<repo>.json）
                     #   禁止任意路径；cell 落盘值必须等于映射值，不等即拒
  config_hash,       # matcher 输出，逐字段比对
  touches_ui,        # matcher 输出，逐字段比对
  matched_paths[]    # matcher 输出，逐字段比对
}
```

`coverage-matrix` 经 authority import `matchUiPaths`，用**自己派生**的 `input_paths` + `registry_path` 现场重跑，把三个输出值与 cell 声明值逐字段比对，任一不符 → exit 2。

**残余（收窄后如实声明）**：机器能证「样本集 == 该 task 全部 SC 的 anchor_paths 确定性并集」「registry 是权威那份」「声明结果 == 该输入下的真实 matcher 结果」三件事。**仅剩**「`anchor_paths` 本身是否列全了该任务真正会碰的文件」不可机器判——这是真正的语义问题，由 Phase 4 对抗质询兜底（T1）。

## 核心机制 F：B 维度「预测态」语义

计划期无真实 `base..candidate` changedFiles，ui-match 只吃**预测 anchor_paths** → 状态为 `covered` 或 `n_a_predicted`（记录输入路径集 + registry `config_hash`，标注「预测性判定，真实判定在 submit-pr Phase 1」）。`n_a_predicted` 不能充真实 n_a，且仅 B 维度可用——**不冒充 submit-pr 的真实 touches_ui**。

## 工作流

### Phase 0 · 触发门与适用边界

仅「汇总任务优先级 / 汇总问题优先级」触发。无任务目标 → fail-closed 问清楚再开工。

**适用边界（硬）**：多 PR / 跨模块 / 影响面不明的任务才用；**单文件小修不要触发**——本 skill 单次成本约 50-150k token，经济账成立的前提是省下一轮三审。任务只需改一个文件、影响面清晰 → 直接进 goal，不要走本 skill。

### Phase 1 · 脚本抓数据

probe.mjs（codemap 反向依赖 / git 热区 / 测试映射 / scripts 枚举）。**必须**带 `--out ~/.claude/.goal/<slug>/probe.json` 把探测 JSON 原子落成 sibling 产物；stdout 契约不变（只输出最终 JSON）。计划期 preflight 仍 `exists_not_run`。禁止把探测切片写进 `dispatch.packets`（PACKET_KEYS 本轮不动）；禁止在计划期填写 `first_edit`（那是 approve-exec 的 PreWalk 交卷，不是本 skill 的 `kind=probe`）。`kind=probe` = 信息产出 SC（waves-plan 排进首波 p1..，执行期仍走 exec 三键交卷）**≠** PreWalk。

probe.mjs（调用细节：codemap 反向依赖 / git 热区 / 测试映射 / scripts 枚举）；`node <SKILL_ROOT>/scripts/lib/ledger-query.mjs` 读台账弹药（top-occurrences 按复发频次降序 + 本次消费快照的 ledger fingerprint；`TASK_PRIORITY_SKILL_ROOT` 可重定向隔离；`BOOTSTRAP_EMPTY_LEDGER` = 台账尚未开始积累，**不等于**「已查过、无逃逸」）；authority 现读（FACES / DEFAULT_REQUIREMENTS / HARDENING_CLASSES / familyKeyOf / recomputeArtifactHash / matchUiPaths / capacity）。**authority 失败即停**（`AUTHORITY_UNREACHABLE`），不往下写。

### Phase 2 · 优先级 + SC 起草

PR 拆分预判（codemap 模块边界 + **人工规模估计**——注意：计划期没有 candidate，拿不到 `merge-base..HEAD` 真实 diff，**size-gate 无法预跑、不构成门**；估计只作风险提示，真实 800 行闸在 submit-pr Phase 1 对真实 candidate 判定）；P0/P1/P2 分层；多颗粒度 SC（三段式 + anchor_paths + faces + **可选声明字段 `gates`（值域 = authority GATES 的 4 个闸）与 `hardening_classes`（值域 = authority HARDENING_CLASSES 的 1..10，2026-08-09）**——不是每条 SC 都碰闸或加固类，两者都可省略；但 coverage 矩阵里某 gate/hardening 格一旦标 `covered`/`n_a_predicted`，就必须有 SC 声明了该维度，否则 coverage-matrix 报 `CELL_GATE_NOT_DECLARED` / `CELL_HARDENING_NOT_DECLARED`（与 `CELL_FACE_NOT_DECLARED` 同族，防一条 SC 填满全矩阵）+ fix 类必填 predicted_invariant/primary_face + **每个 priority 必备 pre-submit SC 组，见下**）。颗粒度例句库见 `references/sc-granularity.md`。

#### 必备 pre-submit SC 组（每个 priority 三条，kind=verify）

**每个 `functional_pr=true` 的 priority 必须带三条 `kind=verify` 的 SC**（id 前缀 `presubmit-size` / `presubmit-format` / `presubmit-intent`），把 submit-pr 的三个机器闸搬到**真实 candidate** 上执行——这是 800 行闸最早可被真实判定的时点。模板与完整三段式见 `references/sc-granularity.md`「必备 pre-submit SC 组」。

| SC id 前缀 | verify 命令（真实可执行形态；`<prAutopilotRoot>` = `config/defaults.json` 的 `prAutopilotRoot`） | 期望 |
|---|---|---|
| `presubmit-size` | `node <prAutopilotRoot>/scripts/size-gate.mjs --repo-dir <候选仓> --base origin/main` | exit 0 且输出 `result ≠ STOP`（STOP 即拆 PR——800 行闸唯一出路是拆，不许豁免/游说） |
| `presubmit-format` | `node <prAutopilotRoot>/scripts/pr-format-gate.mjs --repo-dir <候选仓> --base origin/main --title <PR 标题> --body-file <PR 正文文件>` | exit 0 且输出 `result ≠ FAIL` |
| `presubmit-intent` | `node <prAutopilotRoot>/scripts/intent-check.mjs --pr-body <PR 正文文件>` | exit 0（OK/REBUILT）；exit 2 = action-required（marker 未就位，须落 PR body 后重跑），不算通过 |

**结果绑定 candidate SHA（硬要求）**：每条 SC 的 expect 都要求闸结果与**当前候选分支 HEAD** 绑定——size-gate 输出自带 `head_sha`，直接比对 `git rev-parse HEAD`；pr-format-gate / intent-check 无 head 字段，由执行方先 `git rev-parse HEAD` 记录 candidate SHA 并把闸结果与该 SHA 一并写进执行报告。**不绑 SHA 的闸结果无效**（candidate 变化即作废），绑定做法参照 `final-gate` 的 `release-receipt.base_sha`。

**执行环节**：waves-plan 把 `kind=verify` 排到尾波（恒在 fix 之后），goal 实现完成后、送 submit-pr 之前由尾波 worker 在真实 candidate 上执行——这也是「计划期做不到」的机理：计划期无 candidate、`merge-base..HEAD` diff 为空，任何预跑都只会给出假 PASS。

**计划期 preflight 语义**：`cmd=node` ∈ existsOnly 清单 → 恒判 `exists_not_run`（只证 node 存在），**不得当绿采信**，也不需要 disposition（只有 `green_warn` 需要）。

**边界**：本 SC 组的「必备」由 lead 起草时执行（本 skill 的 manifest-validate 未加机器断言，避免与 submit-pr 侧真实 size-gate 双头判据）；coverage 建议挂 `face G`（声称核实）与 `gate format-gate` 维度。

### Phase 3 · 七面反推闸（机器）

`manifest-validate --stage=draft`（结构/域）→ `coverage-matrix`（全覆盖/全 n_a/evidence/B 绑定）。维度集 = authority 动态（7 面 + 4 gate + 十类全量）。违规 → exit 2 点名，回 Phase 2。

**T1 边界声明①**：机器闸只保证**结构性** fail-closed，**不宣称语义完备**——`n_a` 语义真实性机器不判（reason_code 枚举 + evidence 必填只挡结构），由 Phase 4 对抗质询 + 用户拍板兜底。

### Phase 4 · 对抗质询闸（1-2 sub）

输入 = 草稿 + `references/gap-catalog.md` + 台账高频逃逸（来自 Phase 1 的 ledger-query 输出）；**质询包必须携带本次消费的 ledger fingerprint**（query 输出顶层的 `fingerprint` 字段）——没有它，下一轮读没读、读的是哪份快照都无从核验，「不读/漏传」会悄悄发生；看到 `BOOTSTRAP_EMPTY_LEDGER` 时不得写「无逃逸」（那是「还没开始积累」）。只挑「漏了什么 + 哪些 n_a 敷衍」；真漏 → 补 SC 重跑 Phase 3（补后必须**重新质询并更新 receipt**——final-gate 的谱系校验会拒绝「补 SC 未复审」的旧 receipt）。

**质询结束必须产出可消费工件 `review-receipt.json`**（P1-B；缺失/漂移会被 final-gate 拒，见核心机制 G）：用 `scripts/lib/review-receipt.mjs` 的 scaffold 命令生成骨架（draft hash 与 gap-catalog 指纹内部现算，防手抄漂移），再补 `reviewer_count` 与逐条 `challenges[]`（每条 `{challenge, disposition}`，disposition 如实写「补了哪条 SC」或「无漏项」）。ledger fingerprint 用 Phase 1 已拿到的值；空台账（BOOTSTRAP_EMPTY_LEDGER）时如实记录该值，**不得伪装成「已查过无逃逸」**。

**sub 派工模板（硬）**：

```
Agent 工具，subagent_type=general-purpose，model=sonnet 必须显式传
（内置 agent 类型无 frontmatter，不传会继承 lead 的 opus——按 agent-dispatch.md 硬规则）
```

任务描述要点：给全草稿路径 + gap-catalog.md + 台账高频逃逸清单；要求只报「漏了什么 + 哪些 n_a 敷衍」，不报泛泛的「可以更好」。

### Phase 5 · 预验证 + 分组 + packets 生成

sc-preflight 五态（`fabricated` / `red_ok` / `green_warn` / `exists_not_run` / `infra_fail`），实跑在**一次性隔离 worktree** 内（cwd 钉死该 worktree，跑完 `git worktree remove --force` 并校验已删）；green_warn 必写 disposition；waves-plan 出波次；**生成全部 packets**（此后不新增/不改）。Phase 1 的 `probe.json` 是 sibling 产物，**不得**写进 hashed `dispatch.packets`；本轮不改 `PACKET_KEYS`。

**T1 边界声明②**：preflight **非沙箱**——一次性隔离 worktree 只挡「对仓内工作树的写入」，**不隔离进程/网络/全局缓存/全局配置**。实跑任何 runner 都可能有副作用，选择白名单命令时按此评估。

### Phase 6 · 定稿 + 回放 + 释放

时序见核心机制 B（不可交换）：6a 算 core hash 回填 → 6b 渲染 plan（**含 marker 包夹的机器投影区**，用 `scripts/lib/plan-projection.mjs` 渲染，勿手写/勿手改 marker 区内文字）算 plan_hash → 6c 写盘 + final-gate 定序回放 + **最终检查**（投影区逐字节比对 + review-receipt 存在性与谱系） + 写 receipts → 6d **release-gate**（同一快照回读、重算双 hash、比对 receipts、校验 slug）→ 通过才投递已验证快照里的 packet 文本 + 写 release-receipt（含 canonical_repo/branch/pr_number/binding_strength）。

投影区或 review-receipt 任一不过 → 6c 拒并回对应 Phase：投影区漂移回 6b 重渲染；receipt 缺失/漂移回 Phase 4 重新质询并更新 receipt（先改 SC 再补 receipt 的旧 receipt 会被谱系校验拒）。

用户拍板 = 释放不是变更；要改内容回 Phase 2/5，hash 重算，旧 receipts 自动失效。交付消息从**回读的落盘产物**生成，不引用先前草稿。

### Phase 7 · 提示式回流（非自动闭环）

**T1 边界声明③（含在核心机制 D）**：配对声称按条件收窄——拒跨仓/跨分支/跨 PR **仅当** `artifact.pr_number` 非 null 且 gh 可用，否则降级 weak 并显式标注。

**T1 边界声明④（含在核心机制 E）**：B 维度只证 matcher 一致，`anchor_paths` 是否列全不可机器判。

本 skill **不接线 submit-pr**（不自动闭环）：submit-pr 收口后，由 lead 跑 priority-plan.md 尾部内嵌的一键回流命令（含 `--expect-manifest-hash`）→ gap-backfill 消费 canonical_findings，经 familyKeyOf+primary_face 对账，走五道依序检查（receipt 新鲜度含 repo 身份 → manifest hash → artifact 自洽 → (canonical_repo,branch) 主关联 → pr_number 辅助），逃逸按 fingerprint 入台账（默认不 push）；未命中项进人工复核段。机器层只做 exact-key，同义改写的 semantic gap 属已知残余。

## 产物落点纪律

双产物写 `~/.claude/.goal/<slug>/`（priority-plan.md + task-manifest.json + receipts + review-receipt.json + release-receipt），**绝不写进项目 worktree**——Cindy 宿主 gitSnapshotCoordinator 会把脏树自动 commit，产物进交付分支会撞集成侧越域校验。

## 自进化台账

每次执行后的真逃逸（gap-backfill 命中 canonical_findings 的类）、加固触发情况、返工轮数入 `evolution/ledger.json`（fingerprint 去重，默认零远程副作用；写入只经 `scripts/evolution-note.mjs`，无 `--sync` 绝不碰 git）。

**读取（消费侧，Phase 1 / Phase 4 共用同一入口）**：`node <SKILL_ROOT>/scripts/lib/ledger-query.mjs`——确定性查询，同一 ledger 输入输出逐字节相同（排序不靠插入序）；空台账显式输出 `BOOTSTRAP_EMPTY_LEDGER`（尚未开始积累），与「已查过、无逃逸」语义严格区分；输出顶层 `fingerprint`（`ledger-` + sha256 前 10 hex）绑定本次消费快照，Phase 4 质询包必须携带。**唯一实现**：查询逻辑只在 `scripts/lib/ledger-query.mjs`，任何脚本不得重写第二份。

**放行说明措辞（定死，按审核席口径）**：本机制当前一律表述为「**具备可写入回流机制，尚未证明自动演化效果**」——ledger 现为空（`{"version":1,"entries":[]}`），尚无任何真实轮次证明闭环；禁止写成「已自进化」或任何类似「已生效」的表述。

## 工具链环节映射

见 `references/toolchain-map.md`（调研期 → 回流期九环节）。

## 对抗质询弹药库

见 `references/gap-catalog.md`（Top5 复发类别 + 7 例计划期遗漏 + 6 个复发 invariant 家族 + 三审 fail 分布 + 自托管操作合同）。

## 跑测试（**只有这一条命令是对的**）

```bash
cd <SKILL_ROOT> && node scripts/run-tests.mjs     # 判据是 fail 0，不是某个 pass 数
```

`scripts/run-tests.mjs` 是**单一权威入口**：内部显式枚举 `tests/*.test.mjs`（只读 tests/ 顶层，
不递归、不自动发现），输出是 node test runner 的**原始汇总**（不做任何重新统计），退出码
全绿 0 / 有红非 0。接 CI 也只调这个入口。**不要**直接裸跑 `node --test` 或传目录——另两种
直觉写法都会给**假红**（见下表），别用、别据此判断本 skill 坏了：

| 写法 | 结果 | 原因 |
|---|---|---|
| `node --test tests/` 或 `node --test tests` | `1 test / 1 fail`，`MODULE_NOT_FOUND: .../tests` | Node 24.13 把目录位置参数当脚本执行，**一支都没跑**，却报红 |
| `node --test`（裸，自动发现） | 比权威入口**多出 8 支、其中 6 支假红**（2026-08-09 实测） | 自动发现把 `tests/fixtures/**` 下的**夹具**当真测试收走了 |

那 6 支假红来自 `tests/fixtures/preflight/repo-template/src/*.test.js` 与
`tests/fixtures/probe/full/src/**/*.test.ts`——它们**必须**叫这个名字：`scripts/probe.mjs:229`
的 `isTestFile` 就是按 `/(\.test\.|\.spec\.)/` 与 `__tests__/` 发现测试的，改名等于废掉夹具。
Node 24.13 无 `--test-exclude-pattern`（实测 `bad option`），所以排除夹具**只能靠显式枚举**
——这正是 `run-tests.mjs` 存在的理由。

**禁令：文档/报告/评论里不得硬编码具体 pass 数。** 本文档曾写 `174 tests`，测试涨到 179 后
那句话本身成了误导源（裸跑实测也随测试增长漂移：2026-08-09 已是 187 支）。判据只写 `fail 0`；
要报数就贴当时实跑的原始汇总，不写绝对数字。

## 参考

- `needs_three_review` 判据：功能方面的改动必须走 submit-pr 三审；非功能性小 PR（测试补强/文档/格式/纯配置，且生产行为不变）免三审。权威：`~/.claude/rules/pr-submit-gate.md`。按实际 diff 判定，不按标题。
- 颗粒度标准：`references/sc-granularity.md`
