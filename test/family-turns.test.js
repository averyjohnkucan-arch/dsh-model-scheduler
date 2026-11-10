import test from "node:test";
import assert from "node:assert/strict";
import { ModelScheduler } from "../lib/scheduler.js";

function fixture(t) {
  const scheduler = new ModelScheduler({ switchMs: 0, idleMs: 60000 });
  t.after(() => scheduler.close());
  const events = [];
  function request(id, model = "shared", extra = {}, signal) {
    const promise = scheduler.withSession(id, () => scheduler.acquire({
      key: model, name: model, fingerprint: model, gpu: 0,
      load: async () => { events.push("load " + model); return model; },
      unload: async () => { events.push("unload " + model); },
      ...extra,
    }, signal));
    // Teardown cancels outstanding future requests deliberately left in the queue.
    promise.catch(() => {});
    return promise;
  }
  function child(id, parent = "main") {
    scheduler.activity.observe({ id, header: { origin: "subagent", parentSession: parent } });
  }
  return { scheduler, request, child, events };
}

test("main receives every other request and three children rotate for two full rounds", { timeout: 2000 }, async t => {
  const { scheduler, request, child, events } = fixture(t);
  for (const id of ["sub1", "sub2", "sub3"]) child(id);
  let current = "main", lease = await request(current);
  const pending = new Map(["sub1", "sub2", "sub3"].map(id => [id, request(id)]));
  const seen = [current];
  for (const next of ["sub1", "main", "sub2", "main", "sub3", "main", "sub1", "main", "sub2", "main", "sub3"]) {
    pending.set(current, request(current));
    lease.release();
    lease = await pending.get(next);
    pending.delete(next);
    current = next;
    seen.push(scheduler.device(0).current.sessionId);
  }
  assert.deepEqual(seen, ["main", "sub1", "main", "sub2", "main", "sub3", "main", "sub1", "main", "sub2", "main", "sub3"]);
  assert.deepEqual(events, ["load shared"]);
});

test("a waiting main outranks a resident-model child batch at the next boundary", { timeout: 2000 }, async t => {
  const { scheduler, request, child, events } = fixture(t);
  child("sub1"); child("sub2");
  const current = await request("sub1", "child-model");
  const sibling = request("sub2", "child-model");
  const main = request("main", "main-model");
  current.release();
  const parent = await main;
  assert.equal(scheduler.device(0).current.sessionId, "main");
  assert.deepEqual(events, ["load child-model", "unload child-model", "load main-model"]);
  parent.release();
  (await sibling).release();
});

test("children keep rotating while main has no request; main rejoins at the next boundary", { timeout: 2000 }, async t => {
  const { scheduler, request, child } = fixture(t);
  child("sub1"); child("sub2"); child("nested", "sub1");
  let lease = await request("sub1");
  const repeat = request("sub1"), sibling = request("sub2"), nested = request("nested");
  lease.release();
  lease = await sibling;
  assert.equal(scheduler.device(0).current.sessionId, "sub2");
  lease.release();
  lease = await nested;
  assert.equal(scheduler.device(0).current.sessionId, "nested");
  const main = request("main");
  lease.release();
  lease = await main;
  assert.equal(scheduler.device(0).current.sessionId, "main");
  lease.release();
  (await repeat).release();
});

test("cancelled requests are skipped without consuming a main share", { timeout: 2000 }, async t => {
  const { scheduler, request, child } = fixture(t);
  child("sub1"); child("sub2");
  const current = await request("sub1");
  const cancel = new AbortController();
  const cancelled = request("main", "shared", {}, cancel.signal);
  const sibling = request("sub2");
  cancel.abort(new Error("cancel parent"));
  await assert.rejects(cancelled, /cancel parent/);
  const main = request("main");
  current.release();
  const parent = await main;
  assert.equal(scheduler.device(0).current.sessionId, "main");
  parent.release();
  (await sibling).release();
});

test("failed admission does not advance the family rotation", { timeout: 2000 }, async t => {
  const { scheduler, request, child } = fixture(t);
  child("sub1"); child("sub2");
  const current = await request("sub1");
  const remove = scheduler.registerResourceGuard("failure", async ({ key }) => {
    if (key === "bad") throw Error("failed reservation");
    return () => {};
  });
  const bad = request("main", "bad"), good = request("main"), sibling = request("sub2");
  current.release();
  await assert.rejects(bad, /failed reservation/);
  const parent = await good;
  assert.equal(scheduler.device(0).current.sessionId, "main");
  remove();
  parent.release();
  (await sibling).release();
});

test("explicit tool handoffs retain priority without using a conversation share", { timeout: 2000 }, async t => {
  const { scheduler, request, child } = fixture(t);
  child("sub1"); child("sub2");
  const first = await request("sub1");
  const tool = request("sub1", "tool", { immediate: true });
  const main = request("main"), sibling = request("sub2");
  first.release();
  const rendering = await tool;
  assert.equal(scheduler.device(0).current.sessionId, "sub1");
  rendering.release();
  const parent = await main;
  assert.equal(scheduler.device(0).current.sessionId, "main");
  parent.release();
  (await sibling).release();
});

test("unrelated forks retain resident batching and do not become subagents", { timeout: 2000 }, async t => {
  const { scheduler, request, events } = fixture(t);
  scheduler.activity.observe({ id: "fork", header: { parentSession: "main" } }, { type: "turn/start" });
  const first = await request("main", "resident");
  const fork = request("fork", "other"), repeat = request("main", "resident");
  first.release();
  const same = await repeat;
  assert.deepEqual(events, ["load resident"]);
  same.release();
  (await fork).release();
});

test("devices track family shares independently", { timeout: 2000 }, async t => {
  const { scheduler, request, child } = fixture(t);
  child("sub1"); child("sub2");
  const a = await request("main");
  const b = await request("sub1", "shared", { gpu: 1 });
  const aMain = request("main"), aSub = request("sub1");
  const bSub = request("sub2", "shared", { gpu: 1 }), bMain = request("main", "shared", { gpu: 1 });
  a.release(); b.release();
  const onA = await aSub, onB = await bMain;
  assert.equal(scheduler.device(0).current.sessionId, "sub1");
  assert.equal(scheduler.device(1).current.sessionId, "main");
  onA.release(); onB.release();
  (await aMain).release(); (await bSub).release();
});
