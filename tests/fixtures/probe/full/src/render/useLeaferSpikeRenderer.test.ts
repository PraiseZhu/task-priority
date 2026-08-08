import { test } from "node:test";
import assert from "node:assert/strict";
import { useLeaferSpikeRenderer } from "./useLeaferSpikeRenderer";

test("renderer works", () => {
  assert.equal(useLeaferSpikeRenderer(), "renderer");
});
