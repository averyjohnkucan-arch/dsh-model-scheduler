function installGenerationIndicators(ctx, require) {
  const { useSyncExternalStore } = React;
  const { StateDot } = require("@deepseek-ai/dsh-client-ui-primitives");
  let snapshot = { prefillingSessionIds: [], generatingSessionIds: [] },
    serial = "",
    timer,
    controller,
    stopped = false;
  const listeners = new Set();
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getSnapshot = () => snapshot;
  function publish(next) {
    const key = JSON.stringify(next);
    if (key === serial) return;
    serial = key;
    snapshot = next;
    for (const listener of listeners) listener();
  }
  async function refresh() {
    if (stopped) return;
    if (document.visibilityState === "hidden") {
      publish({ prefillingSessionIds: [], generatingSessionIds: [] });
      timer = setTimeout(refresh, 1500);
      return;
    }
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 3000);
    try {
      const cfg = window.__DSH_MODEL_SCHEDULER__;
      if (!cfg) throw Error("Activity service unavailable");
      const response = await fetch(cfg.path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + cfg.token,
        },
        body: JSON.stringify({ action: "indicators" }),
        signal: controller.signal,
      });
      if (!response.ok) throw Error("Activity service unavailable");
      const { result } = await response.json();
      if (
        !Array.isArray(result?.prefillingSessionIds) ||
        !Array.isArray(result?.generatingSessionIds)
      )
        throw Error("Invalid activity");
      if (!stopped) publish(result);
    } catch {
      if (!stopped)
        publish({ prefillingSessionIds: [], generatingSessionIds: [] });
    } finally {
      clearTimeout(timeout);
      controller = null;
      if (!stopped) timer = setTimeout(refresh, 250);
    }
  }
  ctx.effect(() => {
    refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      listeners.clear();
    };
  });

  const spinCSS = (selector, phase) =>
    `${selector}{color:${phase === "generating" ? "#579bff" : "var(--dsw-alias-label-tertiary)"}!important}${selector}>g{animation:dsh-activity-spin .65s linear infinite!important;transform-origin:12px 12px;transform-box:view-box}${selector} circle{animation:none!important;stroke:currentColor!important}${selector} circle:first-child{opacity:.22}${selector} circle:last-child{opacity:1;stroke-dasharray:20 40;stroke-dashoffset:0}`;
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-model-scheduler";
    style.textContent = `@keyframes dsh-activity-spin{to{transform:rotate(360deg)}}${spinCSS('html body .dsh-activity-prefill[data-state="ongoing"]', "prefill")}${spinCSS('html body .dsh-activity-generating[data-state="ongoing"]', "generating")}@media(prefers-reduced-motion:reduce){html body .dsh-activity-generating[data-state="ongoing"]>g,html body .dsh-activity-prefill[data-state="ongoing"]>g{animation:none!important}}`;
    document.head.appendChild(style);
    return () => style.remove();
  });
  function useActive(useSessions) {
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const catalog = useSessions((s) => s);
    // Client catalog fills lineage for children already running when the plugin
    // was enabled, and propagates activity through nested subagent trees.
    const parents = new Map();
    for (const [id, summary] of Object.entries(catalog.byId ?? {}))
      if (summary.origin === "subagent" && summary.parentId)
        parents.set(id, summary.parentId);
    for (const [parent, projection] of Object.entries(
      catalog.projectionsBySession ?? {},
    ))
      for (const entry of projection.values?.subagentCatalog ?? [])
        if (entry.mode !== "external") parents.set(entry.id, parent);
    const rollup = (all, direct) => {
      const result = new Set([...(all ?? []), ...(direct ?? [])]);
      for (const id of direct ?? []) {
        const seen = new Set([id]);
        let parent = parents.get(id);
        while (parent && !seen.has(parent)) {
          result.add(parent);
          seen.add(parent);
          parent = parents.get(parent);
        }
      }
      return result;
    };
    return {
      prefilling: rollup([], state.prefillingSessionIds),
      generating: rollup([], state.generatingSessionIds),
    };
  }
  function RowActivity({ sessionId, useSessions }) {
    const activity = useActive(useSessions),
      phase = activity.generating.has(sessionId)
        ? "generating"
        : activity.prefilling.has(sessionId)
          ? "prefill"
          : undefined;
    const selector = `html body [data-row-key="${CSS.escape("session:" + sessionId)}"]>span:first-child svg[data-state="ongoing"]`;
    // Queues and tool waits retain the native slow grey indication.
    const neutral = `${selector}{color:var(--dsw-alias-label-tertiary)!important}${selector}>g{animation:dsh-activity-spin 1.5s linear infinite!important;transform-origin:12px 12px}${selector} circle{animation:none!important;stroke:currentColor!important}`;
    return h(
      React.Fragment,
      null,
      h(
        "style",
        null,
        (phase ? spinCSS(selector, phase) : neutral) +
          `@media(prefers-reduced-motion:reduce){${selector}>g{animation:none!important}}`,
      ),
      phase &&
        h(
          "span",
          {
            style: {
              position: "absolute",
              width: 1,
              height: 1,
              overflow: "hidden",
              clipPath: "inset(50%)",
            },
          },
          phase === "generating"
            ? "Generating output"
            : "Prefilling / waiting for first token",
        ),
    );
  }
  ctx.slots.inject("sidebar.workspaces.session.row.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.workspaces.session.row.action",
        id: "dsh-model-scheduler",
        order: 1000,
      },
      RowActivity,
    ),
  );

  const ActivityContext = React.createContext({
    prefilling: new Set(),
    generating: new Set(),
  });
  function GenerationDot({ sessionId, sessionIds = [], state }) {
    const active = React.useContext(ActivityContext);
    const ids = [sessionId, ...sessionIds],
      generating = ids.some((id) => active.generating.has(id)),
      prefilling = ids.some((id) => active.prefilling.has(id));
    const phase = generating
      ? "generating"
      : prefilling
        ? "prefill"
        : undefined;
    const dot = h(StateDot, {
      state,
      className: phase ? "dsh-activity-" + phase : undefined,
    });
    return phase
      ? h(
          "span",
          {
            style: { display: "inline-flex" },
            role: "img",
            "aria-label":
              phase === "generating"
                ? "Generating output"
                : "Prefilling / waiting for first token",
            title:
              phase === "generating"
                ? "Generating output"
                : "Prefilling / waiting for first token",
          },
          dot,
        )
      : dot;
  }
  const views = createSubagentViews(require, GenerationDot);
  // Supported slot priority shadowing keeps all changes in this plugin. The
  // upstream registrations still own navigation injection, locale and lifetime.
  function shadow(name, id, View) {
    ctx.slots.inject(name, () => {
      let source,
        priority,
        dispose,
        updating = false;
      const reconcile = () => {
        if (updating) return;
        updating = true;
        try {
          const next = ctx.slots
            .entries(name)
            .find(
              (entry) =>
                entry.registrant === "@deepseek-ai/dsh-client-ui-subagent" &&
                (id === undefined || entry.options.id === id),
            );
          const others = ctx.slots
            .entries(name)
            .filter(
              (entry) =>
                entry.registrant !== "dsh-model-scheduler" &&
                (id === undefined || entry.options.id === id),
            );
          const nextPriority =
            Math.min(0, ...others.map((entry) => entry.options.priority ?? 0)) -
            1;
          if (next === source && nextPriority === priority) return;
          priority = nextPriority;
          dispose?.();
          dispose = undefined;
          source = next;
          if (!source) return;
          function ActivityView(props) {
            return h(
              ActivityContext.Provider,
              { value: useActive(props.useSessions) },
              h(View, props),
            );
          }
          dispose = ctx.slots.register(
            {
              name,
              ...source.options,
              priority,
              inject: source.inject,
              locale: source.locale,
            },
            ActivityView,
          );
        } finally {
          updating = false;
        }
      };
      const unsubscribe = ctx.slots.subscribe(name, reconcile);
      reconcile();
      return () => {
        unsubscribe();
        dispose?.();
      };
    });
  }
  shadow(
    "conversation.session.header.actions",
    "subagent-catalog",
    views.SubagentCatalogAction,
  );
  shadow(
    "conversation.session.header.lineage",
    undefined,
    views.SubagentHeaderLineage,
  );
}
