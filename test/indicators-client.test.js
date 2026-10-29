import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import React from "react";
import Renderer, { act } from "react-test-renderer";
import * as jsx from "react/jsx-runtime";

test("built client decorates rows, shadows subagent views, rolls up nested children and clears failed polls", async () => {
  let plugin,
    next = { prefillingSessionIds: ["grandchild"], generatingSessionIds: [] };
  const callbacks = [],
    cleanup = [],
    registrations = [],
    css = [],
    timers = new Map();
  let timerId = 0;
  const native = (name, id) => ({
    registrant: "@deepseek-ai/dsh-client-ui-subagent",
    options: { id },
    inject: {},
    locale: "native",
  });
  const nativeEntries = [
    native("actions", "subagent-catalog"),
    native("lineage", "lineage"),
  ];
  const source = await readFile(
    new URL("../client.js", import.meta.url),
    "utf8",
  );
  const primitives = new Proxy(
    {
      StateDot: (props) =>
        React.createElement("svg", { "data-state": props.state, ...props }),
    },
    { get: (target, key) => target[key] ?? (() => null) },
  );
  const context = {
    window: {
      innerWidth: 1200,
      addEventListener() {},
      removeEventListener() {},
      __ModuleLoader__: {
        load: (mod) => {
          plugin = mod.factory((name) =>
            name === "react"
              ? React
              : name === "react/jsx-runtime"
                ? jsx
                : name === "react-dom"
                  ? { createPortal: (node) => node }
                  : primitives,
          );
        },
      },
      __DSH_MODEL_SCHEDULER__: { path: "/activity", token: "fixture" },
    },
    document: {
      body: {},
      addEventListener() {},
      removeEventListener() {},
      visibilityState: "visible",
      createElement: () => ({ dataset: {}, remove() {} }),
      head: { appendChild: (node) => css.push(node) },
    },
    fetch: async () => {
      if (next instanceof Error) throw next;
      return { ok: true, json: async () => ({ result: next }) };
    },
    setInterval: () => 0,
    clearInterval() {},
    queueMicrotask,
    AbortController,
    CSS: { escape: (value) => value },
    setTimeout: (fn) => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(source, context);
  const ctx = {
    locale: { register: () => () => {} },
    effect: (fn) => {
      const dispose = fn();
      if (dispose) cleanup.push(dispose);
    },
    slots: {
      inject: (name, fn) => {
        const dispose = fn();
        if (dispose) cleanup.push(dispose);
      },
      register: (options, component) => {
        const entry = { options, component, registrant: "dsh-model-scheduler" };
        registrations.push(entry);
        return () => registrations.splice(registrations.indexOf(entry), 1);
      },
      entries: (name) =>
        name.endsWith("actions")
          ? [
              nativeEntries[0],
              {
                registrant: "another-extension",
                options: { id: "subagent-catalog", priority: -1 },
              },
              ...registrations.filter((x) => x.options.name === name),
            ]
          : [
              nativeEntries[1],
              ...registrations.filter((x) => x.options.name === name),
            ],
      subscribe: (name, fn) => {
        callbacks.push(fn);
        return () => {};
      },
    },
  };
  await act(async () => {
    plugin.apply(ctx);
    await Promise.resolve();
  });
  const row = registrations.find((r) => r.options.id === "dsh-model-scheduler");
  const shadow = registrations.find(
    (r) => r.options.name === "conversation.session.header.actions",
  );
  assert.equal(shadow.options.priority, -2);
  assert.equal(shadow.options.locale, "native");
  const catalog = {
    byId: {
      child: { origin: "subagent", parentId: "root" },
      grandchild: { origin: "subagent", parentId: "child" },
      fork: { parentId: "other" },
    },
    projectionsBySession: {},
  };
  const props = { sessionId: "root", useSessions: (select) => select(catalog) };
  let rendered;
  await act(async () => {
    rendered = Renderer.create(React.createElement(row.component, props));
  });
  const style = () => rendered.root.findByType("style").props.children;
  assert.match(style(), /650|\.65s/);
  assert.match(style(), /var\(--dsw-alias-label-tertiary\)/);
  assert.equal(
    rendered.root.findByType("span").children[0],
    "Prefilling / waiting for first token",
  );
  assert.match(css[0].textContent, /prefers-reduced-motion/);
  next = { prefillingSessionIds: [], generatingSessionIds: ["grandchild"] };
  async function poll() {
    const [id, fn] = [...timers].at(-1);
    timers.delete(id);
    await act(async () => {
      await fn();
    });
  }
  await poll();
  assert.match(style(), /#579bff/);
  assert.equal(
    rendered.root.findByType("span").children[0],
    "Generating output",
  );
  // Native forks must not propagate phase to an unrelated parent.
  next = { prefillingSessionIds: [], generatingSessionIds: ["fork"] };
  await poll();
  assert.doesNotMatch(style(), /#579bff/);
  // Render the actual adapted subagent dropdown and expand its nested catalog.
  catalog.projectionsBySession = {
    root: {
      state: "ready",
      values: {
        subagentCatalog: [{ id: "child", label: "Child", mode: "continuable" }],
      },
    },
    child: {
      state: "ready",
      values: {
        subagentCatalog: [
          { id: "grandchild", label: "Grandchild", mode: "continuable" },
        ],
      },
    },
    grandchild: { state: "ready", values: { subagentCatalog: [] } },
  };
  next = { prefillingSessionIds: [], generatingSessionIds: ["grandchild"] };
  await poll();
  let dropdown;
  const nativeProps = {
    ...props,
    useSessionStatus: (selector) =>
      selector(
        new Map([
          ["child", { running: true }],
          ["grandchild", { running: true }],
        ]),
      ),
    refreshProjection() {},
    openChild() {},
    openChildAside() {},
    t: (key) => key,
  };
  await act(async () => {
    dropdown = Renderer.create(
      React.createElement(shadow.component, nativeProps),
      {
        createNodeMock: () => ({
          getBoundingClientRect: () => ({ bottom: 20, left: 20 }),
          contains: () => false,
        }),
      },
    );
  });
  assert.equal(
    dropdown.root.findAll(
      (node) =>
        node.type === "svg" &&
        node.props.className === "dsh-activity-generating",
    ).length,
    1,
  );
  await act(async () =>
    dropdown.root.findByProps({ "aria-haspopup": "tree" }).props.onClick(),
  );
  assert.equal(dropdown.root.findAllByProps({ role: "treeitem" }).length, 1);
  await act(async () =>
    dropdown.root
      .findByProps({ "aria-label": "branch.expand" })
      .props.onClick({ preventDefault() {}, stopPropagation() {} }),
  );
  assert.equal(dropdown.root.findAllByProps({ role: "treeitem" }).length, 2);
  assert.equal(
    dropdown.root.findAll(
      (node) =>
        node.type === "svg" &&
        node.props.className === "dsh-activity-generating",
    ).length,
    3,
  );
  await act(async () => dropdown.unmount());
  next = new Error("disconnected");
  await poll();
  assert.match(style(), /1\.5s/);
  assert.equal(rendered.root.findAllByType("span").length, 0);
  await act(async () => rendered.unmount());
  for (const dispose of cleanup.reverse()) dispose();
  assert.equal(registrations.length, 0);
});
