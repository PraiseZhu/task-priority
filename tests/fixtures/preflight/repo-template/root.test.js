// 根目录测试（复刻真实仓根目录测试形态，如 MIVO 的 vitest.setup.test.ts）。
// 无任何 marker → vitest 替身 exit 0 → green_warn（验证「根目录测试也能实跑」，
// 不再被目录白名单误判为 fabricated；vitest 默认 include **/*.{test,spec}.* 覆盖根目录）。
