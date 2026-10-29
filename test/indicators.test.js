import test from "node:test";
import assert from "node:assert/strict";
import { Activity } from "../lib/indicators.js";
const start = (a, id, attemptId = id) =>
  a.frame(id, { type: "start", attemptId });
const chunk = (a, id, chunk, attemptId = id) =>
  a.frame(id, { type: "chunk", attemptId, chunk });

test("prefill becomes blue only for real output, remains blue through gaps, and resets between calls", () => {
  const a = new Activity();
  start(a, "a");
  assert.deepEqual(a.snapshot(), {
    prefillingSessionIds: ["a"],
    generatingSessionIds: [],
  });
  chunk(a, "a", { type: "usage" });
  chunk(a, "a", { type: "block-start" });
  chunk(a, "a", { type: "text-delta", text: "" });
  assert.deepEqual(a.snapshot().generatingSessionIds, []);
  chunk(a, "a", { type: "text-delta", text: "Hello" });
  assert.deepEqual(a.snapshot(), {
    prefillingSessionIds: [],
    generatingSessionIds: ["a"],
  });
  chunk(a, "a", { type: "usage" });
  assert.deepEqual(a.snapshot().generatingSessionIds, ["a"]);
  chunk(a, "a", { type: "finish" });
  assert.deepEqual(a.snapshot(), {
    prefillingSessionIds: [],
    generatingSessionIds: [],
  });
  start(a, "a", "next");
  a.frame("a", { type: "end", attemptId: "a" });
  assert.deepEqual(a.snapshot().prefillingSessionIds, ["a"]);
  a.frame("a", { type: "end", attemptId: "next" });
  assert.deepEqual(a.snapshot().prefillingSessionIds, []);
});

test("reasoning and tool-call arguments count as output; empty deltas do not", () => {
  for (const value of [
    { type: "reasoning-delta", text: "Thinking" },
    { type: "tool-call-delta", argumentsDelta: '{"q"' },
    { type: "tool-call-delta", name: "search", argumentsDelta: "" },
  ]) {
    const a = new Activity();
    start(a, "child");
    chunk(a, "child", value);
    assert.deepEqual(a.snapshot().generatingSessionIds, ["child"]);
  }
  const a = new Activity();
  start(a, "a");
  chunk(a, "a", { type: "tool-call-delta", argumentsDelta: "" });
  assert.deepEqual(a.snapshot().generatingSessionIds, []);
});

test("scheduler admission gates queued chats and handoffs independently", () => {
  const a = new Activity();
  start(a, "admitted");
  start(a, "queued");
  const admitted = (ids) => ({
    directSessionIds: ids,
    directGeneratingSessionIds: [],
  });
  assert.deepEqual(a.snapshot(admitted(["admitted"])).prefillingSessionIds, [
    "admitted",
  ]);
  chunk(a, "admitted", { type: "text-delta", text: "a" });
  assert.deepEqual(a.snapshot(admitted(["admitted"])).generatingSessionIds, [
    "admitted",
  ]);
  assert.deepEqual(a.snapshot(admitted(["queued"])), {
    prefillingSessionIds: ["queued"],
    generatingSessionIds: [],
  });
  a.clear("queued");
  assert.deepEqual(a.snapshot(admitted(["queued"])).prefillingSessionIds, []);
});

test("activation during a stream accepts output without a start marker", () => {
  const a = new Activity();
  chunk(a, "existing", { type: "reasoning-delta", text: "Still thinking" });
  assert.deepEqual(a.snapshot().generatingSessionIds, ["existing"]);
  a.frame("existing", { type: "end", attemptId: "existing" });
  assert.deepEqual(a.snapshot().generatingSessionIds, []);
});
