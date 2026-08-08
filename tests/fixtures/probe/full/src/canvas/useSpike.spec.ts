import { test } from "node:test";
import assert from "node:assert/strict";
import { useSpike } from "./useSpike";

test("spike", () => {
  assert.ok(useSpike());
});
