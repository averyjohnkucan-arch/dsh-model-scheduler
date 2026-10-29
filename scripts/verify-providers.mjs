import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ModelScheduler } from "../lib/scheduler.js";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
// Real provider classes, fake owned servers: this checks admission, not GPU kernels.
const directories = process.argv.slice(2);
if (directories.length !== 3)
  throw Error(
    "Usage: node scripts/verify-providers.mjs <strata-repo> <ninfer-repo> <dory-repo>",
  );
const source = (index, path) =>
  pathToFileURL(join(resolve(directories[index]), path));
const { StrataService } = await import(source(0, "lib/service.js"));
const { Runtime: NInfer } = await import(source(1, "lib/runtime.js"));
const { Runtime: Dory } = await import(source(2, "lib/runtime.js"));
const { freshProfile: nProfile } = await import(source(1, "lib/profiles.js"));
const { freshProfile: dProfile } = await import(source(2, "lib/profiles.js"));
const { gpuOperation } = await import(source(1, "lib/gpu-operation.js"));
const versions = await Promise.all(
  [
    new URL("../package.json", import.meta.url),
    ...directories.map((dir) => join(dir, "package.json")),
  ].map(async (path) => JSON.parse(await readFile(path, "utf8")).version),
);
const scheduler = new ModelScheduler({ switchMs: 0 }),
  events = [];
const strata = new StrataService(),
  ninfer = new NInfer("ninfer", {}),
  dory = new Dory({});
const s = { id: "s", name: "Gyro S", gpu: 0 },
  n = { ...nProfile("ninfer"), id: "n", name: "NInfer" },
  d = { ...dProfile(), id: "d", name: "Dory" };
strata.profiles = [s];
ninfer.profiles = [n];
dory.profiles = [d];
for (const runtime of [strata, ninfer, dory]) runtime.scheduler = scheduler;
strata.startServer = async () => {
  events.push("load strata");
  const state = { profile: s, active: 0, ready: true };
  strata.servers.set("s", state);
  return state;
};
ninfer.startLocal = async () => {
  events.push("load ninfer");
  const state = { profile: n, active: 0, ready: true };
  ninfer.running.set("n", state);
  return state;
};
dory.start = async () => {
  events.push("load dory");
  const state = { profile: d, active: 0, ready: true };
  dory.running.set("d", state);
  return state;
};
for (const [runtime, key, method] of [
  [strata, "strata", "stopLocal"],
  [ninfer, "ninfer", "stopLocal"],
  [dory, "dory", "stop"],
]) {
  const stop = runtime[method].bind(runtime);
  runtime[method] = async (id) => {
    events.push("unload " + key);
    return stop(id);
  };
}
try {
  const a = await ninfer.acquire(n);
  a.state.active++;
  const waiting = strata.acquire("s");
  await delay(20);
  assert.deepEqual(events, ["load ninfer"]);
  // The lease remains held during checkpoint IO, even after streaming has ended.
  await delay(20);
  assert.deepEqual(events, ["load ninfer"]);
  a.state.active--;
  a.release();
  const b = await waiting;
  assert.deepEqual(events, ["load ninfer", "unload ninfer", "load strata"]);
  const cancelled = new AbortController(),
    c = dory.acquire(d, cancelled.signal);
  cancelled.abort();
  await assert.rejects(c, { name: "AbortError" });
  assert.equal(b.state.active, 1);
  const next = dory.acquire(d);
  await delay(20);
  assert.equal(events.at(-1), "load strata");
  b.release();
  const e = await next;
  assert.deepEqual(events.slice(-2), ["unload strata", "load dory"]);
  e.state.active++;
  let calibrated = false;
  const calibration = gpuOperation(ninfer, n, undefined, async () => {
    calibrated = true;
    events.push("calibrate ninfer");
  });
  await delay(20);
  assert.equal(calibrated, false);
  e.state.active--;
  e.release();
  await calibration;
  assert.deepEqual(events.slice(-2), ["unload dory", "calibrate ninfer"]);
  strata.tuneLocal = async () => {
    events.push("tune strata");
  };
  await strata.tune("s", new AbortController().signal, () => {});
  assert.equal(events.at(-1), "tune strata");
  let attempts = 0;
  strata.startServer = async () => {
    if (++attempts === 1) throw Error("Native allocation failed");
    return { active: 0 };
  };
  await assert.rejects(strata.acquire("s"), /allocation/);
  assert.equal(strata.answering, 0);
  (await strata.acquire("s")).release();
  assert.equal(strata.answering, 0);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        scheduler: versions[0],
        strata: versions[1],
        ninfer: versions[2],
        dory: versions[3],
        checks: [
          "NInfer to Strata handoff",
          "checkpoint lease retention",
          "cancelled Dory waiter",
          "Strata to Dory handoff",
          "NInfer calibration reservation",
          "Strata native tuning reservation",
          "failed-load retry",
        ],
        events,
      },
      null,
      2,
    ),
  );
} finally {
  await scheduler.close();
}
