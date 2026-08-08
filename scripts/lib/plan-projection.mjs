// lib/plan-projection.mjs — priority-plan.md 的**机器投影区**单一实现（P1-A 双产物语义漂移修复）。
//
// 背景（lead 2026-08-09 实测）：manifestCoreHash 与 planHash 是两个互不引用的函数——前者吃
// manifest 对象、后者吃 markdown 纯文本，final-gate 只分别校验「各自与自己的 receipt 相符」，
// 没有任何跨产物语义比对。审核席实跑：把 priority-plan.md 里 SC-1 的文字改成与 manifest 不一致，
// 七闸全过、release 放行。后果：manifest 里 SC 已更新而人读计划留旧 SC；或正文写了一条残余而
// 机读 coverage 是另一套。用户和 worker 读到的计划，与机器判定的事实可以是两回事。
//
// 修法（lead 裁决形态，非「manifest 为 canonical、renderer 全量生成 plan」）：marker 包夹的
// **机器投影区**。priority-plan.md 保留人读的 rationale 与 trade-off 自由散文；其中一段区块由
// manifest **确定性渲染**、用 marker 包夹，final-gate 逐字节比对「现渲染 == plan 内 marker 区块」，
// 不等即拒（PLAN_PROJECTION_MISMATCH）。marker 区外的自由散文不受约束——人话归人，事实归机器。
//
// 渲染内容（至少）：SC 清单（id + 三段式 change/holds/verify）、派工组（waves 分组）、
// 残余风险（coverage 的 n_a 格——manifest 无独立 residual_risks 字段，机器可判的残余 = n_a 格；
// 该派生是本文件的唯一实现，禁止各处各写一份）。
//
// 确定性：同一 manifest 输入 → 输出逐字节相同（无时间戳、无环境路径、无 Object.keys 默认序依赖
// ——数组序即 manifest 落盘序，JSON 落盘序由写入方保证确定）。marker 区块**位于
// PLAN_RECEIPTS_MARKER 之前**（在 planHash 覆盖的正文内）：release-gate 的 plan_hash 逐字比对
// 因此也钉住投影区，篡改 marker 区块在 6d 同样暴露。

/** 投影区起始 marker（plan 正文中投影区之前的界定行） */
export const PLAN_PROJECTION_START = '<!-- task-priority:projection:start -->';

/** 投影区结束 marker（投影区之后的界定行；两 marker 之间的字节必须 == renderPlanProjection 输出） */
export const PLAN_PROJECTION_END = '<!-- task-priority:projection:end -->';

function esc(s) {
  return String(s ?? '');
}

/** verify 命令渲染：cmd + args 空格拼接（数组序确定性）。 */
function renderVerify(verify) {
  if (!verify || typeof verify !== 'object') return '';
  const args = Array.isArray(verify.args) ? verify.args.map(esc) : [];
  return [esc(verify.cmd), ...args].join(' ');
}

/**
 * 从 manifest 确定性渲染投影区（含首尾 marker，无尾部换行）。
 * 要求 manifest 已是 final 形状（scs/waves/coverage 在场）；缺关键结构 → throw（fail-closed，
 * 与 manifestCoreHash 同风格——渲染器的输入契约不成立时不许静默产出残缺区块）。
 */
export function renderPlanProjection(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('renderPlanProjection: manifest 必须是非数组对象');
  }
  const scs = manifest.scs;
  const waves = manifest.waves;
  const coverage = manifest.coverage;
  if (!Array.isArray(scs)) throw new Error('renderPlanProjection: manifest.scs 必须是数组');
  if (!Array.isArray(waves)) throw new Error('renderPlanProjection: manifest.waves 必须是数组');
  if (!Array.isArray(coverage)) throw new Error('renderPlanProjection: manifest.coverage 必须是数组');

  const lines = [PLAN_PROJECTION_START, '', '## 机器投影（由 task-manifest.json 确定性渲染，勿手改）', ''];

  // ── SC 清单（id + 三段式 change/holds/verify）──
  lines.push('### SC 清单');
  if (scs.length === 0) {
    lines.push('（无 SC）');
  } else {
    for (const s of scs) {
      const meta = [esc(s.kind), esc(s.granularity)].filter(Boolean).join('/');
      const verify = renderVerify(s.verify);
      lines.push(
        `- **${esc(s.id)}** (${meta}) ${esc(s.change)} — holds: ${esc(s.holds)}${verify ? ` — verify: \`${verify}\`` : ''}`,
      );
    }
  }
  lines.push('');

  // ── 派工组（waves 分组）──
  lines.push('### 派工组（waves）');
  if (waves.length === 0) {
    lines.push('（无波次）');
  } else {
    for (const w of waves) {
      for (const g of Array.isArray(w.groups) ? w.groups : []) {
        const scIds = Array.isArray(g.sc_ids) ? g.sc_ids.map(esc) : [];
        lines.push(`- **${esc(g.group_id)}**（wave ${esc(w.wave)}, workers ${esc(g.worker_count)}）: ${scIds.join(', ')}`);
      }
    }
  }
  lines.push('');

  // ── 残余风险（coverage n_a 格——manifest 无独立 residual_risks 字段时的机器可判残余）──
  lines.push('### 残余风险（coverage n_a 格）');
  const naCells = coverage.filter((c) => c && c.status === 'n_a');
  if (naCells.length === 0) {
    lines.push('（无 n_a 格）');
  } else {
    for (const c of naCells) {
      const rc = c.reason_code ? `, ${esc(c.reason_code)}` : '';
      lines.push(`- ${esc(c.task_id)} / ${esc(c.dimension_kind)} ${esc(c.dimension_id)}: n_a${rc}`);
    }
  }

  lines.push('', PLAN_PROJECTION_END);
  return lines.join('\n');
}

/**
 * 从 plan 正文提取 marker 包夹的投影区（含首尾 marker）。
 * 任一端 marker 缺失 → null（调用方区分 PLAN_PROJECTION_MISSING 与 MISMATCH）。
 */
export function extractPlanProjection(planMarkdownText) {
  if (typeof planMarkdownText !== 'string') {
    throw new Error('extractPlanProjection: 输入必须是字符串');
  }
  const start = planMarkdownText.indexOf(PLAN_PROJECTION_START);
  if (start === -1) return null;
  const end = planMarkdownText.indexOf(PLAN_PROJECTION_END, start);
  if (end === -1) return null;
  return planMarkdownText.slice(start, end + PLAN_PROJECTION_END.length);
}
