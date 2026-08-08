#!/usr/bin/env node
// probe 测试 fixture 的 mock codemap —— 输出确定性的模块级 markdown（模仿 MivoCanvas
// scripts/codemap.mjs --full 的格式）。probe 只做只读调用，不 import 本文件。
// 图结构（正向边）：
//   src → src/app, src/store
//   src/app → src/canvas, src/store
//   src/canvas → src/render, src/store
//   src/render → src/types
//   src/store → —
//   src/types → —
// 反向闭包（关注 src/render）：direct=[src/canvas]，maxDepth=3（canvas←app←src）
if (process.argv.includes("--full") || true) {
  process.stdout.write(`# Fixture Codemap
[导航规范] 测试 fixture，非真实仓库。

modules: 6 | files: 9 | lines: 120 | circ: 0 | gen: 0.01s

## 模块（文件数 / 行数 / 职责 / 依赖 / 被依赖）
- **src** — 1f 10L — 应用入口壳 (main.tsx 根装配)
  - → src/app, src/store
  - ← —
- **src/app** — 1f 20L — UI 壳 — 顶栏/侧栏/聊天面板
  - → src/canvas, src/store
  - ← src
- **src/canvas** — 3f 30L — 画布组件 + 单一职责交互 hook + 节点注册
  - → src/render, src/store
  - ← src/app
- **src/render** — 2f 20L — 投影/命中/视口契约（含 useLeaferSpikeRenderer）
  - → src/types
  - ← src/canvas
- **src/store** — 2f 20L — Zustand 状态根 + 持久化迁移
  - → —
  - ← src, src/app
- **src/types** — 1f 10L — 跨层共享类型
  - → —
  - ← src/render
`);
}
