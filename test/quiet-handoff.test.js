import test from "node:test";
import assert from "node:assert/strict";
import { ModelScheduler } from "../lib/scheduler.js";
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const events = [],
    s = new ModelScheduler();
  t.after(() => s.close());
  const driver = (key) => ({
    key,
    name: key,
    gpu: 0,
    fingerprint: key,
    load: async () => {
      events.push("load " + key);
      return key;
    },
    unload: async () => events.push("unload " + key),
  });
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { s, events, driver, tick };
}
test("default idle unload occurs at sixty seconds, including a tool pause", async (t) => {
  const { s, events, driver, tick } = fixture(t);
  s.turnStarted("chat");
  (await s.withSession("chat", () => s.acquire(driver("a")))).release();
  await tick(59999);
  assert.deepEqual(events, ["load a"]);
  await tick(1);
  assert.deepEqual(events, ["load a", "unload a"]);
});
test("another model waits for five quiet seconds after the last request, not queue arrival", async (t) => {
  const { s, events, driver, tick } = fixture(t);
  const first = await s.acquire(driver("a"));
  const waiting = s.acquire(driver("b"));
  await tick(20000);
  assert.deepEqual(events, ["load a"]);
  first.release();
  await tick(4999);
  assert.deepEqual(events, ["load a"]);
  await tick(1);
  const next = await waiting;
  assert.deepEqual(events, ["load a", "unload a", "load b"]);
  next.release();
});
test("four conversations sharing two models drain the resident batch in arrival order", async (t) => {
  const { s, events, driver, tick } = fixture(t);
  const a1 = await s.withSession("a1", () => s.acquire(driver("a")));
  const b1 = s.withSession("b1", () => s.acquire(driver("b")));
  const a2 = s.withSession("a2", () => s.acquire(driver("a")));
  const b2 = s.withSession("b2", () => s.acquire(driver("b")));
  a1.release();
  const current = await a2;
  assert.deepEqual(events, ["load a"]);
  current.release();
  await tick(4999);
  assert.deepEqual(events, ["load a"]);
  await tick(1);
  const second = await b1;
  assert.equal(s.device(0).current.sessionId, "b1");
  second.release();
  const third = await b2;
  assert.equal(s.device(0).current.sessionId, "b2");
  assert.deepEqual(events, ["load a", "unload a", "load b"]);
  third.release();
});
test("a new request during the quiet interval resets the five-second clock", async (t) => {
  const { s, events, driver, tick } = fixture(t);
  (await s.acquire(driver("a"))).release();
  const waiting = s.acquire(driver("b"));
  await tick(4999);
  (await s.acquire(driver("a"))).release();
  await tick(4999);
  assert.deepEqual(events, ["load a"]);
  await tick(1);
  (await waiting).release();
  assert.deepEqual(events, ["load a", "unload a", "load b"]);
});
test("cancelling the only contender restores the sixty-second idle deadline", async (t) => {
  const { s, events, driver, tick } = fixture(t);
  (await s.acquire(driver("a"))).release();
  const c = new AbortController(),
    waiting = s.acquire(driver("b"), c.signal);
  c.abort();
  await assert.rejects(waiting);
  await tick(59999);
  assert.deepEqual(events, ["load a"]);
  await tick(1);
  assert.deepEqual(events, ["load a", "unload a"]);
});
