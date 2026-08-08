import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./index";

test("store version", () => {
  assert.equal(store.version, 1);
});
