# task-priority 自进化台账

自动生成:由 `scripts/evolution-note.mjs` 从 `evolution/ledger.json` 再生成,**手改本文件会被覆盖**。
条目按根因 fingerprint 去重;分类与落地规则见 SKILL.md「Phase 7 提示式回流」。
外部使用者欢迎把自己的台账条目以 PR 形式回流(只动 `evolution/ledger.json`,经脚本 add 生成)。

## 待维护者拍板(放宽验收口径类提案,永不自动落地)

- `sc-verify-cmd-structurally-unpassable-at-plan-time` **verify_cmds 计划期就不可能通过** — 出现 1 次,首见 2026-08-24,最近 2026-08-24,status: tracked
  - 现象:双载体自指或被测对象在别仓；exists_not_run 放行后执行期才炸。属增强不是现存 bug。
  - 备注:[decided:2026-08-24] track 增强提案。升格条件：再出现 1 次计划期不可通过的 verify_cmds 进到执行期。

## 已自动落地(工具/文档缺口修复,不放宽口径)

- `probe-sc-depends-on-fix-unschedulable` **probe 依赖 fix 构成不可满足波序** — 出现 1 次,首见 2026-08-24,最近 2026-08-24,status: landed
  - 现象:PROBE_DEPENDS_LATE 已在 waves-plan 抛错。
  - 备注:[decided:2026-08-24] landed-effective waves-plan.mjs 已抛 PROBE_DEPENDS_LATE，测试覆盖。
- `sc-preflight-argv-swallows-subcommand-flags` **sc-preflight parseArgv 吞子命令 --repo/--cmd** — 出现 1 次,首见 2026-08-24,最近 2026-08-24,status: landed
  - 现象:无 -- 终止符，指纹按截短命令算。
  - 备注:[decided:2026-08-24] landed-effective task-priority#2 merge ba65e82：parseArgv 遇 -- 停止扫自身 flag。
- `review-receipt-hash-shape-mismatch` **review-receipt 用 manifestCoreHash 而非 draftAncestorHash** — 出现 1 次,首见 2026-08-24,最近 2026-08-24,status: landed
  - 现象:喂 final 形态 manifest 静默产出错 hash，拖到 Phase 6c 才炸。
  - 备注:[decided:2026-08-24] landed-effective task-priority#2 merge ba65e82：scaffold 改用 draftAncestorHash。
- `cli-symlink-isolation-guard-noop` **5 个脚本的 isCLI 在软链安装下静默空转** — 出现 1 次,首见 2026-08-24,最近 2026-08-24,status: landed
  - 现象:import.meta.url === pathToFileURL(argv[1]) 在 ~/.claude/skills/task-priority 软链下永不相等，rc=0 假绿。
  - 备注:[decided:2026-08-24] landed-effective task-priority#2 merge ba65e82：is-direct-run.mjs 两侧 realpathSync。

## 已否决的提案(留档防止重复提出)

- `plan-anchor-secondhand-lineno-drift` 起草期采信二手 file:line 锚点未复核 — [decided:2026-08-24] reject(非缺陷) 人写坏锚点。不再重提；重提唯一合法条件=skill 起草器自动采信二手 file:line。
- `silenced-checkout-error-yields-phantom-zero-measurement` 循环内 checkout 被 2>/dev/null 吞掉量出 counted=0 — [decided:2026-08-24] reject(非缺陷) 人写坏命令。不再重提；重提唯一合法条件=skill 脚本自己吞 checkout 错误。
- `equivalence-criterion-tree-vs-content-under-base-drift` 验收把内容等价误写成树等价 — [decided:2026-08-24] reject(非缺陷) 人写坏判据。不再重提；重提唯一合法条件=skill 默认模板写成树等价。
- `plan-drafted-against-stale-local-checkout` 起草期读本机 stale 工作树当现值 — [decided:2026-08-24] reject(非缺陷) 人读 stale 树。不再重提；重提唯一合法条件=skill 强制读工作树现值。
- `sc-holds-self-contradiction-forces-observability-edit` holds 同时要求留档可恢复与工作树干净 — [decided:2026-08-24] reject(非缺陷) 人写坏 holds。不再重提；重提唯一合法条件=skill 生成自相矛盾 holds。
