import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../index.js";

test("merged indicators share scheduler authentication, lifecycle and admission", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merged-indicators-")),
    previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const ctx = new Context();
  let route;
  t.after(async () => {
    await ctx.fiber.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  ctx.provide("webServer", {
    register: (r) => {
      route = r;
      return () => {};
    },
    getOrigin: () => "http://localhost:3080",
  });
  await ctx.plugin({
    name: "dsh-model-scheduler",
    apply: (scope) => apply(scope, { idleSeconds: 60, switchSeconds: 0 }),
  });
  const table = [];
  ctx.emit("webserver/index-inject", table);
  assert.equal(table.length, 1);
  assert.equal(table[0].name, "__DSH_MODEL_SCHEDULER__");
  const { token } = table[0].value;
  const scheduler = ctx.get("modelScheduler"),
    driver = (key) => ({
      key,
      name: key,
      gpu: 0,
      fingerprint: key,
      load: async () => ({}),
      unload: async () => {},
    });
  async function call(extra = {}) {
    const req = Readable.from([
      Buffer.from(JSON.stringify({ action: "indicators" })),
    ]);
    Object.assign(req, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        origin: "http://localhost:3080",
      },
      ...extra,
    });
    const res = {
      setHeader() {},
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await route.handler(req, res);
    return res;
  }
  const chat = await scheduler.withSession("chat", () =>
    scheduler.acquire(driver("a")),
  );
  const pending = scheduler.withSession("queued", () =>
    scheduler.acquire(driver("b")),
  );
  for (const id of ["chat", "queued"])
    ctx.emit("agent/assistant-stream", {
      agent: { id },
      frame: { type: "start", attemptId: "one" },
    });
  assert.deepEqual((await call()).body.result.prefillingSessionIds, ["chat"]);
  ctx.emit("agent/assistant-stream", {
    agent: { id: "chat" },
    frame: {
      type: "chunk",
      attemptId: "one",
      chunk: { type: "reasoning-delta", text: "x" },
    },
  });
  assert.deepEqual((await call()).body.result.generatingSessionIds, ["chat"]);
  ctx.emit("agent/status", { agent: { id: "chat" }, status: "idle" });
  chat.release();
  const next = await pending;
  assert.deepEqual((await call()).body.result, {
    prefillingSessionIds: ["queued"],
    generatingSessionIds: [],
  });
  ctx.emit("agent/disposed", { agent: { id: "queued" } });
  next.release();
  assert.deepEqual((await call()).body.result.prefillingSessionIds, []);
  assert.equal((await call({ headers: {} })).status, 401);
  assert.equal((await call({ method: "GET" })).status, 405);
  assert.equal(
    (
      await call({
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          origin: "http://other",
        },
      })
    ).status,
    403,
  );
});
