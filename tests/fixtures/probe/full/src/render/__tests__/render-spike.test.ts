import { test } from "node:test";
import assert from "node:assert/strict";
// 通过 __tests__/ 目录 + 引用关注路径的 basename，测试映射应同时命中：
// 1) __tests__/ 同级扫描  2) git grep 内容引用
import { useLeaferSpikeRenderer } from "../useLeaferSpikeRenderer";

test("render-spike via __tests__", () => {
  assert.ok(useLeaferSpikeRenderer);
});
