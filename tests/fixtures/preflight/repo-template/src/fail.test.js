// ASSERT_FAIL — 断言失败标记(stub 据此模拟 vitest 的 AssertionError 输出)
import { expect, test } from 'vitest';

test('should fail', () => {
  expect(1).toBe(2);
});
