window.__ModuleLoader__.load({
  id: "dsh-model-scheduler",
  factory(require) {
    const React = require("react"),
      h = React.createElement,
      { useState, useEffect } = React;
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

// Subagent catalog presentation adapted from @deepseek-ai/dsh-client-ui-subagent 0.2.1-rc.2.
// Copyright (c) 2026 DeepSeek. MIT; see THIRD_PARTY_LICENSES.md.
// Kept local because this DSH release has no per-subagent status-renderer slot.
// Navigation, keyboard handling, expansion and metrics remain the upstream view.
function createSubagentViews(require, GenerationDot) {
 const react_jsx_runtime = require('react/jsx-runtime'), react = require('react');
 const react_dom = require('react-dom');
 const _deepseek_ai_dsh_client_ui_primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		var SubagentHeaderLineage_module_css_default = {
			"activitySlot": "ZKlsPq_activitySlot",
			"ancestorSwitcherTrigger": "ZKlsPq_ancestorSwitcherTrigger",
			"children": "ZKlsPq_children",
			"clickarea": "ZKlsPq_clickarea",
			"content": "ZKlsPq_content",
			"currentLabel": "ZKlsPq_currentLabel",
			"disclosure": "ZKlsPq_disclosure",
			"disclosureOpen": "ZKlsPq_disclosureOpen",
			"disclosureSpace": "ZKlsPq_disclosureSpace",
			"error": "ZKlsPq_error",
			"label": "ZKlsPq_label",
			"menu": "ZKlsPq_menu",
			"menuBody": "ZKlsPq_menuBody",
			"metricDuration": "ZKlsPq_metricDuration",
			"metricToken": "ZKlsPq_metricToken",
			"metrics": "ZKlsPq_metrics",
			"node": "ZKlsPq_node",
			"notice": "ZKlsPq_notice",
			"refresh": "ZKlsPq_refresh",
			"root": "ZKlsPq_root",
			"row": "ZKlsPq_row",
			"rowActivitySlot": "ZKlsPq_rowActivitySlot",
			"sidebarButton": "ZKlsPq_sidebarButton",
			"summary": "ZKlsPq_summary",
			"switcherRoot": "ZKlsPq_switcherRoot",
			"switcherTitle": "ZKlsPq_switcherTitle",
			"switcherTrigger": "ZKlsPq_switcherTrigger",
			"trigger": "ZKlsPq_trigger",
			"triggerOpen": "ZKlsPq_triggerOpen"
		};
		//#endregion
		//#region lib/types/client/SubagentHeaderLineage.js
		function treeItems(root) {
			return root === null ? [] : Array.from(root.querySelectorAll("[role=\"treeitem\"]:not([aria-disabled=\"true\"])"));
		}
		/** Compact token count shared in shape with the conversation stats strip. */
		function formatTokens(value, t) {
			const scaled = (next) => next >= 100 ? String(Math.round(next)) : String(Math.round(next * 10) / 10);
			if (value < 1e3) return String(value);
			if (value < 1e6) return t("tokens.thousand", { value: scaled(value / 1e3) });
			return t("tokens.million", { value: scaled(value / 1e6) });
		}
		/** Sum the four disjoint durable provider-usage buckets. */
		function tokenTotal(usage) {
			return usage === void 0 ? void 0 : usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
		}
		/** Exact whole-second active-turn duration for one catalog row. */
		function activityDuration(summary, activity, now) {
			if (summary === void 0) return void 0;
			const timing = summary.projectionValues?.subagentTiming;
			if (timing === void 0) return void 0;
			if (timing.active === void 0) return timing.settledMs;
			const end = activity === "running" ? now : timing.active.through;
			return timing.settledMs + Math.max(0, end - timing.active.since);
		}
		function splitDuration(ms) {
			const totalSeconds = Math.floor(Math.max(0, ms) / 1e3);
			const totalMinutes = Math.floor(totalSeconds / 60);
			const totalHours = Math.floor(totalMinutes / 60);
			return {
				seconds: totalSeconds % 60,
				minutes: totalMinutes % 60,
				hours: totalHours % 24,
				days: Math.floor(totalHours / 24),
				totalMinutes,
				totalHours
			};
		}
		/** Format a duration with decreasing visual precision at larger scales. */
		function formatDuration(ms, t) {
			const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms);
			if (days >= 365) {
				const years = Math.floor(days / 365);
				const months = Math.floor(days % 365 / 30);
				return months === 0 ? t("duration.years", { years }) : t("duration.yearsMonths", {
					years,
					months
				});
			}
			if (days >= 30) {
				const months = Math.floor(days / 30);
				const remainingDays = days % 30;
				return remainingDays === 0 ? t("duration.months", { months }) : t("duration.monthsDays", {
					months,
					days: remainingDays
				});
			}
			if (days > 0) return hours === 0 ? t("duration.days", { days }) : t("duration.daysHours", {
				days,
				hours
			});
			if (totalHours > 0) return t("duration.hours", {
				hours: totalHours,
				minutes: String(minutes).padStart(2, "0"),
				seconds: String(seconds).padStart(2, "0")
			});
			if (totalMinutes > 0) return t("duration.minutes", {
				minutes: totalMinutes,
				seconds: String(seconds).padStart(2, "0")
			});
			return t("duration.seconds", { seconds });
		}
		/** Preserve exact whole seconds for hover and accessible naming. */
		function formatExactDuration(ms, t) {
			const { seconds, minutes, hours, days } = splitDuration(ms);
			return days === 0 ? formatDuration(ms, t) : t("duration.exactDays", {
				days,
				hours: String(hours).padStart(2, "0"),
				minutes: String(minutes).padStart(2, "0"),
				seconds: String(seconds).padStart(2, "0")
			});
		}
		function SubagentSwitcherIcon() {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 20 20",
				fill: "none",
				"aria-hidden": "true",
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M5.99951 12.7L8.95546 14.9478C9.40011 15.2859 9.62244 15.455 9.87526 15.488C9.95774 15.4988 10.0413 15.4988 10.1238 15.488C10.3766 15.455 10.5989 15.2859 11.0436 14.9478L13.9995 12.7",
					stroke: "currentColor",
					strokeWidth: "1.5"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M13.9995 7.7417L11.0436 5.49387C10.5989 5.15574 10.3766 4.98668 10.1238 4.95362C10.0413 4.94283 9.95775 4.94283 9.87527 4.95362C9.62245 4.98668 9.40012 5.15574 8.95547 5.49387L5.99952 7.7417",
					stroke: "currentColor",
					strokeWidth: "1.5"
				})]
			});
		}
		/** Render catalog loading without inventing child membership. */
		function CatalogLoadingRows({ t }) {
			return (0, react_jsx_runtime.jsx)("div", {
				className: SubagentHeaderLineage_module_css_default.notice,
				children: t("loading.label")
			});
		}
		/** A child becomes a known leaf only after its own authoritative catalog loads empty. */
		function isKnownLeaf(catalog) {
			return catalog?.state === "ready" && catalog.entries.length === 0;
		}
		/** Render one catalog level and recurse only through explicitly expanded rows. */
		function CatalogRows({ parentSessionId, currentSessionId, catalog, catalogs, summaries, expanded, level, openChild, openChildAside, refreshProjection, toggleBranch, closeCatalog, t }) {
			const [now, setNow] = (0, react.useState)(() => Date.now());
			const running = catalog.entries.some((entry) => entry.activity === "running");
			(0, react.useEffect)(() => {
				if (!running) return;
				const timer = setInterval(() => {
					setNow(Date.now());
				}, 1e3);
				return () => {
					clearInterval(timer);
				};
			}, [running]);
			const emptyLoading = catalog.state === "loading" && catalog.entries.length === 0;
			const reserveDisclosure = catalog.entries.some((entry) => entry.mode !== "external" && !isKnownLeaf(catalogs[entry.id]) && summaries[entry.id]?.formatStatus !== "migration-required" && catalogs[entry.id]?.state !== "migration-required");
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				emptyLoading && (0, react_jsx_runtime.jsx)(CatalogLoadingRows, { t }),
				catalog.state === "error" && (0, react_jsx_runtime.jsxs)("div", {
					className: SubagentHeaderLineage_module_css_default.error,
					children: [(0, react_jsx_runtime.jsx)("span", { children: catalog.error?.message ?? t("load.error") }), (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: SubagentHeaderLineage_module_css_default.refresh,
						onClick: () => {
							refreshProjection(parentSessionId);
						},
						children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, { size: 14 }), t("retry")]
					})]
				}),
				catalog.entries.map((entry) => {
					const external = entry.mode === "external";
					const childCatalog = catalogs[entry.id];
					const isCurrent = entry.id === currentSessionId;
					const knownLeaf = external || isKnownLeaf(childCatalog);
					const requiresOpening = summaries[entry.id]?.formatStatus === "migration-required" || childCatalog?.state === "migration-required";
					const canExpand = !knownLeaf && !requiresOpening;
					const isExpanded = canExpand && expanded.has(entry.id);
					const childLoading = childCatalog === void 0 || childCatalog.state === "loading" && childCatalog.entries.length === 0;
					const summary = summaries[entry.id];
					const label = entry.label ?? entry.id;
					const mode = external ? t("mode.external") : entry.mode === "unknown" ? t("mode.unknown") : entry.mode === "one-shot" ? t("mode.oneShot") : t("mode.continuable");
					const completed = !external && entry.activity === "inactive" && summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true;
					const activity = external ? void 0 : entry.activity === "running" ? t("activity.running") : completed ? t("activity.completed") : t("activity.inactive");
					const secondary = [
						summary?.title,
						requiresOpening ? t("catalog.migrationRequired") : mode,
						activity
					].filter((value) => value !== void 0).join(" · ");
					const totalTokens = tokenTotal(summary?.projectionValues?.tokenUsage);
					const durationMs = activityDuration(summary, entry.activity, now);
					const tokenMetric = totalTokens === void 0 ? void 0 : t("tokens.total", { value: formatTokens(totalTokens, t) });
					const durationMetric = durationMs === void 0 ? void 0 : {
						compact: formatDuration(durationMs, t),
						exact: formatExactDuration(durationMs, t)
					};
					const metrics = [tokenMetric, durationMetric?.exact].filter((value) => value !== void 0).join(" · ");
					const open = () => {
						if (external) return;
						openChild({
							parentSessionId,
							childSessionId: entry.id,
							mode: entry.mode
						});
						closeCatalog();
					};
					const handleKey = (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							event.stopPropagation();
							open();
						} else if (event.key === "ArrowRight" && canExpand && !isExpanded || event.key === "ArrowLeft" && isExpanded) {
							event.preventDefault();
							event.stopPropagation();
							toggleBranch(entry.id);
						}
					};
					const toggle = (event) => {
						event.preventDefault();
						event.stopPropagation();
						toggleBranch(entry.id);
					};
					return (0, react_jsx_runtime.jsxs)("div", {
						className: SubagentHeaderLineage_module_css_default.node,
						children: [(0, react_jsx_runtime.jsxs)("div", {
							role: "treeitem",
                            "data-generation-session": entry.id,
							tabIndex: external ? -1 : 0,
							"aria-disabled": external || void 0,
							"aria-level": level,
							"aria-current": isCurrent || void 0,
							"aria-label": [
								label,
								secondary,
								metrics
							].filter((value) => value !== "").join(" "),
							...canExpand ? { "aria-expanded": isExpanded } : {},
							className: SubagentHeaderLineage_module_css_default.row,
							onClick: open,
							onKeyDown: handleKey,
							children: [!canExpand ? reserveDisclosure && (0, react_jsx_runtime.jsx)("span", { className: SubagentHeaderLineage_module_css_default.disclosureSpace }) : (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								tabIndex: -1,
								className: `${SubagentHeaderLineage_module_css_default.disclosure} ${isExpanded ? SubagentHeaderLineage_module_css_default.disclosureOpen : ""}`,
								"aria-label": t(isExpanded ? "branch.collapse" : "branch.expand", { label }),
								onClick: toggle,
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, {})
							}), (0, react_jsx_runtime.jsxs)("div", {
								className: SubagentHeaderLineage_module_css_default.clickarea,
								children: [
									(0, react_jsx_runtime.jsx)("span", {
										className: SubagentHeaderLineage_module_css_default.rowActivitySlot,
										children: (0, react_jsx_runtime.jsx)(GenerationDot, { sessionId: entry.id, state: entry.activity === "running" ? "ongoing" : completed ? "done" : "idle" })
									}),
									(0, react_jsx_runtime.jsxs)("span", {
										className: SubagentHeaderLineage_module_css_default.content,
										children: [(0, react_jsx_runtime.jsx)("span", {
											className: `${SubagentHeaderLineage_module_css_default.label} ${isCurrent ? SubagentHeaderLineage_module_css_default.currentLabel : ""}`,
											children: label
										}), (0, react_jsx_runtime.jsx)("span", {
											className: SubagentHeaderLineage_module_css_default.summary,
											children: secondary
										})]
									}),
									metrics !== "" && (0, react_jsx_runtime.jsxs)("span", {
										className: SubagentHeaderLineage_module_css_default.metrics,
										children: [tokenMetric !== void 0 && (0, react_jsx_runtime.jsx)("span", {
											className: SubagentHeaderLineage_module_css_default.metricToken,
											children: tokenMetric
										}), durationMetric !== void 0 && (0, react_jsx_runtime.jsx)("span", {
											className: SubagentHeaderLineage_module_css_default.metricDuration,
											title: t("duration.exactTitle", { duration: durationMetric.exact }),
											children: durationMetric.compact
										})]
									}),
									!isCurrent && !external && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
										label: t("open.sidebar"),
										side: "bottom",
										align: "end",
										children: (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: SubagentHeaderLineage_module_css_default.sidebarButton,
											"aria-label": t("open.sidebar.aria", { label }),
											onClick: (event) => {
												event.preventDefault();
												event.stopPropagation();
												openChildAside({
													parentSessionId,
													childSessionId: entry.id,
													mode: entry.mode
												});
												closeCatalog();
											},
											onKeyDown: (event) => {
												event.stopPropagation();
											},
											children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutlineRegular, {})
										})
									})
								]
							})]
						}), isExpanded && (0, react_jsx_runtime.jsx)("div", {
							role: "group",
							className: SubagentHeaderLineage_module_css_default.children,
							"aria-busy": childLoading || void 0,
							children: childCatalog === void 0 ? (0, react_jsx_runtime.jsx)(CatalogLoadingRows, { t }) : (0, react_jsx_runtime.jsx)(CatalogRows, {
								parentSessionId: entry.id,
								currentSessionId,
								catalog: childCatalog,
								catalogs,
								summaries,
								expanded,
								level: level + 1,
								openChild,
								openChildAside,
								refreshProjection,
								toggleBranch,
								closeCatalog,
								t
							})
						})]
					}, entry.id);
				})
			] });
		}
		const MENU_VIEWPORT_MARGIN = 16;
		/** Place a portaled catalog below its trigger without crossing the viewport edge. */
		function catalogMenuPosition(trigger) {
			const rect = trigger.getBoundingClientRect();
			const width = Math.min(336, window.innerWidth - MENU_VIEWPORT_MARGIN * 2);
			return {
				top: rect.bottom + 5,
				left: Math.min(Math.max(MENU_VIEWPORT_MARGIN, rect.left), window.innerWidth - width - MENU_VIEWPORT_MARGIN)
			};
		}
		/** One trigger-plus-tree dropdown over the catalog rooted at `rootSessionId`. */
		function CatalogDropdown({ rootSessionId, currentSessionId, displayTitle, openTitle, variant, useSessions, useSessionStatus, openChild, openChildAside, refreshProjection, t }) {
			const ancestorSwitcher = variant === "switcher" && openTitle !== void 0;
			const projections = useSessions((state) => state.projectionsBySession);
			const summaries = useSessions((state) => state.byId);
			const statuses = useSessionStatus((value) => value);
			const catalogs = (0, react.useMemo)(() => {
				return Object.fromEntries(Object.entries(projections).map(([id, snapshot]) => {
					const projected = snapshot.values.subagentCatalog;
					return [id, {
						state: snapshot.state === "idle" ? projected === void 0 ? "loading" : "ready" : snapshot.state === "migration-required" && projected !== void 0 ? "ready" : snapshot.state,
						error: snapshot.error,
						entries: (projected ?? []).map((entry) => ({
							...entry,
							activity: (statuses.get(entry.id)?.running ?? summaries[entry.id]?.running) === true ? "running" : "inactive"
						}))
					}];
				}));
			}, [
				projections,
				summaries,
				statuses
			]);
			const catalog = catalogs[rootSessionId];
			const [open, setOpen] = (0, react.useState)(false);
			const [menuPosition, setMenuPosition] = (0, react.useState)();
			const [expanded, setExpanded] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const rootRef = (0, react.useRef)(null);
			const triggerRef = (0, react.useRef)(null);
			const menuRef = (0, react.useRef)(null);
			const hoverOpenTimer = (0, react.useRef)(void 0);
			const hoverCloseTimer = (0, react.useRef)(void 0);
			const pinnedRef = (0, react.useRef)(false);
			const currentEntry = currentSessionId === void 0 ? void 0 : projections[rootSessionId]?.values.subagentCatalog?.find((entry) => entry.id === currentSessionId);
			const switcherDisplayTitle = currentEntry !== void 0 ? currentEntry.label ?? currentEntry.id : displayTitle;
			const directChildren = catalog?.entries ?? [];
			const directCount = directChildren.length;
			const runningCount = directChildren.filter((entry) => entry.activity === "running").length;
			const totalCountKey = directCount === 1 ? "count.total.one" : "count.total.other";
			const runningCountKey = runningCount === 1 ? "count.running.one" : "count.running.other";
			const presentedCatalog = catalog ?? (variant === "switcher" ? {
				entries: [],
				state: "loading",
				error: null
			} : void 0);
			const cancelHoverClose = () => {
				if (hoverCloseTimer.current === void 0) return;
				clearTimeout(hoverCloseTimer.current);
				hoverCloseTimer.current = void 0;
			};
			const cancelHoverOpen = () => {
				if (hoverOpenTimer.current === void 0) return;
				clearTimeout(hoverOpenTimer.current);
				hoverOpenTimer.current = void 0;
			};
			const changeOpen = (next, restoreFocus = false) => {
				cancelHoverOpen();
				cancelHoverClose();
				if (next) {
					const trigger = triggerRef.current;
					/* v8 ignore next -- a queued callback can outlive the trigger */
					if (trigger === null) return;
					setOpen(true);
					setMenuPosition(catalogMenuPosition(trigger));
				} else {
					pinnedRef.current = false;
					setOpen(false);
					setMenuPosition(void 0);
					setExpanded(/* @__PURE__ */ new Set());
				}
				if (restoreFocus) queueMicrotask(() => {
					triggerRef.current?.focus();
				});
			};
			const scheduleHoverOpen = () => {
				cancelHoverOpen();
				cancelHoverClose();
				if (open) return;
				hoverOpenTimer.current = setTimeout(() => {
					hoverOpenTimer.current = void 0;
					changeOpen(true);
				}, 150);
			};
			const scheduleHoverClose = () => {
				cancelHoverOpen();
				cancelHoverClose();
				if (pinnedRef.current) return;
				hoverCloseTimer.current = setTimeout(() => {
					hoverCloseTimer.current = void 0;
					changeOpen(false);
				}, 120);
			};
			const closeBranch = (root) => {
				const closing = /* @__PURE__ */ new Set();
				const visit = (parentSessionId) => {
					if (closing.has(parentSessionId) || !expanded.has(parentSessionId)) return;
					closing.add(parentSessionId);
					const branch = catalogs[parentSessionId];
					for (const entry of branch?.entries ?? []) visit(entry.id);
				};
				visit(root);
				setExpanded((current) => new Set([...current].filter((id) => !closing.has(id))));
			};
			const toggleBranch = (childSessionId) => {
				if (expanded.has(childSessionId)) {
					closeBranch(childSessionId);
					return;
				}
				setExpanded((current) => new Set(current).add(childSessionId));
				refreshProjection(childSessionId);
			};
			(0, react.useEffect)(() => {
				if (!open) return;
				const closeOutside = (event) => {
					if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) changeOpen(false);
				};
				document.addEventListener("pointerdown", closeOutside);
				return () => {
					document.removeEventListener("pointerdown", closeOutside);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const placeMenu = () => {
					const trigger = triggerRef.current;
					/* v8 ignore next -- native resize or scroll can outlive the trigger */
					if (trigger === null) return;
					setMenuPosition(catalogMenuPosition(trigger));
				};
				window.addEventListener("resize", placeMenu);
				document.addEventListener("scroll", placeMenu, true);
				return () => {
					window.removeEventListener("resize", placeMenu);
					document.removeEventListener("scroll", placeMenu, true);
				};
			}, [open]);
			(0, react.useEffect)(() => () => {
				cancelHoverOpen();
				cancelHoverClose();
			}, []);
			const visible = presentedCatalog !== void 0 && (variant === "switcher" || presentedCatalog.state === "error" || presentedCatalog.entries.length > 0);
			(0, react.useEffect)(() => {
				if (visible) return;
				cancelHoverOpen();
				cancelHoverClose();
				if (!open) return;
				pinnedRef.current = false;
				setOpen(false);
				setExpanded(/* @__PURE__ */ new Set());
			}, [visible, open]);
			if (!visible) return null;
			const focusAt = (index) => {
				const items = treeItems(menuRef.current);
				if (items.length === 0) return;
				items[(index + items.length) % items.length]?.focus();
			};
			const navigate = (event) => {
				const items = treeItems(menuRef.current);
				const index = items.indexOf(document.activeElement);
				if (event.key === "Escape") {
					event.preventDefault();
					changeOpen(false, true);
				} else if (event.key === "Home") {
					event.preventDefault();
					focusAt(0);
				} else if (event.key === "End") {
					event.preventDefault();
					focusAt(items.length - 1);
				} else if (event.key === "ArrowDown") {
					event.preventDefault();
					focusAt(index + 1);
				} else if (event.key === "ArrowUp") {
					event.preventDefault();
					focusAt(index < 0 ? items.length - 1 : index - 1);
				}
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${SubagentHeaderLineage_module_css_default.root} ${variant === "switcher" ? SubagentHeaderLineage_module_css_default.switcherRoot : ""}`,
				ref: rootRef,
				onKeyDown: navigate,
				onMouseLeave: scheduleHoverClose,
				children: [(0, react_jsx_runtime.jsxs)("button", {
					ref: triggerRef,
					onMouseEnter: scheduleHoverOpen,
					type: "button",
					className: variant === "switcher" ? `${SubagentHeaderLineage_module_css_default.switcherTrigger} ${ancestorSwitcher ? SubagentHeaderLineage_module_css_default.ancestorSwitcherTrigger : ""}` : SubagentHeaderLineage_module_css_default.trigger,
					"aria-haspopup": "tree",
					"aria-expanded": open,
					"aria-label": variant === "switcher" ? t("switcher.aria", { title: switcherDisplayTitle }) : t(runningCount > 0 ? runningCountKey : totalCountKey, { count: runningCount > 0 ? runningCount : directCount }),
					onClick: openTitle === void 0 ? () => {
						cancelHoverOpen();
						cancelHoverClose();
						pinnedRef.current = true;
						if (!open) changeOpen(true);
					} : () => {
						cancelHoverOpen();
						if (open) changeOpen(false);
						openTitle();
					},
					onKeyDown: (event) => {
						if (event.key !== "ArrowDown") return;
						event.preventDefault();
						if (!open) changeOpen(true);
						queueMicrotask(() => {
							focusAt(0);
						});
					},
					children: [variant === "switcher" ? (0, react_jsx_runtime.jsx)("span", {
						className: SubagentHeaderLineage_module_css_default.switcherTitle,
						children: switcherDisplayTitle
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [runningCount > 0 && (0, react_jsx_runtime.jsx)("span", {
						className: SubagentHeaderLineage_module_css_default.activitySlot,
						children: (0, react_jsx_runtime.jsx)(GenerationDot, { sessionIds: directChildren.map(child => child.id), state: "ongoing" })
					}), (0, react_jsx_runtime.jsx)("span", {
						className: SubagentHeaderLineage_module_css_default.count,
						children: t(totalCountKey, { count: directCount })
					})] }), variant === "switcher" ? (0, react_jsx_runtime.jsx)(SubagentSwitcherIcon, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { className: open ? SubagentHeaderLineage_module_css_default.triggerOpen : void 0 })]
				}), open && (0, react_dom.createPortal)((0, react_jsx_runtime.jsx)("div", {
					ref: menuRef,
					className: SubagentHeaderLineage_module_css_default.menu,
					style: menuPosition,
					onMouseEnter: cancelHoverClose,
					onMouseLeave: scheduleHoverClose,
					children: (0, react_jsx_runtime.jsx)("div", {
						className: SubagentHeaderLineage_module_css_default.menuBody,
						role: "tree",
						"aria-label": t("tree.aria"),
						children: (0, react_jsx_runtime.jsx)(CatalogRows, {
							parentSessionId: rootSessionId,
							currentSessionId,
							catalog: presentedCatalog,
							catalogs,
							summaries,
							expanded,
							level: 1,
							openChild,
							openChildAside,
							refreshProjection,
							toggleBranch,
							closeCatalog: () => {
								changeOpen(false);
							},
							t
						})
					})
				}), document.body)]
			});
		}
		/**
		* Session-header catalog action for root sessions: the descendant count and
		* its dropdown after the preset label in the header actions band. Child sessions render nothing
		* here — their breadcrumb switcher in the lineage slot owns the same
		* navigation.
		* @param props - Session standard props plus the catalog actions and translator.
		* @returns The count dropdown, or null on a child session.
		*/
		function SubagentCatalogAction({ sessionId, useSessions, useSessionStatus, openChild, openChildAside, refreshProjection, t }) {
			if (useSessions((state) => state.byId[sessionId]?.origin === "subagent")) return null;
			return (0, react_jsx_runtime.jsx)(CatalogDropdown, {
				rootSessionId: sessionId,
				variant: "count",
				useSessions,
				useSessionStatus,
				openChild,
				openChildAside,
				refreshProjection,
				t
			}, sessionId);
		}
		/**
		* Render one breadcrumb title together with its subagent navigation.
		* @param props - Breadcrumb title, session standard props, and catalog actions.
		* @returns A title-and-chevron sibling switcher, or nothing on a root session.
		*/
		function SubagentHeaderLineage({ lineageSessionId, displayTitle, openTitle, useSessions, useSession, useSessionStatus, openChild, openChildAside, refreshProjection, t }) {
			const address = useSession((session) => session.subagent?.address);
			const parentId = useSessions((state) => {
				if (address?.childSessionId === lineageSessionId) return address.parentSessionId;
				for (const [parentId, snapshot] of Object.entries(state.projectionsBySession)) if (snapshot.values.subagentCatalog?.some((entry) => entry.id === lineageSessionId)) return parentId;
				const summary = state.byId[lineageSessionId];
				return summary?.origin === "subagent" ? summary.parentId : void 0;
			});
			const shared = {
				useSessions,
				useSessionStatus,
				openChild,
				openChildAside,
				refreshProjection,
				t
			};
			if (parentId === void 0) return null;
			return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(CatalogDropdown, {
				rootSessionId: parentId,
				currentSessionId: lineageSessionId,
				variant: "switcher",
				displayTitle,
				...openTitle === void 0 ? {} : { openTitle },
				...shared
			}, `switcher:${lineageSessionId}`), openTitle === void 0 && (0, react_jsx_runtime.jsx)(CatalogDropdown, {
				rootSessionId: lineageSessionId,
				variant: "count",
				...shared
			}, `children:${lineageSessionId}`)] });
		}
		//#endregion

 return {SubagentCatalogAction,SubagentHeaderLineage};
}

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        installGenerationIndicators(ctx, require);
        ctx.effect(() =>
          ctx.locale.register("dsh-model-scheduler", { en: {} }),
        );
        function Card() {
          const [data, setData] = useState(null),
            [seconds, setSeconds] = useState(null),
            [switchSeconds, setSwitchSeconds] = useState(null),
            [backgroundSeconds, setBackgroundSeconds] = useState(null),
            [error, setError] = useState(""),
            [busy, setBusy] = useState(false);
          async function api(action, payload = {}) {
            const cfg = window.__DSH_MODEL_SCHEDULER__;
            if (!cfg) throw new Error("Restart DSH to connect the scheduler.");
            const r = await fetch(cfg.path, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + cfg.token,
              },
              body: JSON.stringify({ action, payload }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error);
            return d.result;
          }
          useEffect(() => {
            let alive = true;
            const refresh = () =>
              api("list")
                .then((d) => {
                  if (alive) setData(d);
                })
                .catch((e) => {
                  if (alive) setError(e.message);
                });
            refresh();
            const timer = setInterval(refresh, 1500);
            return () => {
              alive = false;
              clearInterval(timer);
            };
          }, []);
          async function act(action, payload) {
            setBusy(true);
            setError("");
            try {
              await api(action, payload);
              setData(await api("list"));
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }
          return h(
            "section",
            {
              className: "dsh-scheduler",
              style: {
                marginTop: 16,
                padding: 16,
                border: "1px solid var(--dsw-alias-settings-card-stroke)",
                borderRadius: 12,
                background: "var(--dsw-alias-settings-card-fill)",
              },
            },
            h(
              "style",
              null,
              `.dsh-scheduler{font:inherit;font-size:14px;color:var(--dsw-alias-label-primary)}.dsh-scheduler h3{font-size:15px;font-weight:500;margin:0}.dsh-scheduler p{color:var(--dsw-alias-label-secondary);line-height:1.5}.dsh-scheduler button,.dsh-scheduler input{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:7px 10px}.dsh-scheduler button{cursor:pointer}.dsh-scheduler button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-scheduler button:disabled{opacity:.5;cursor:default}.dsh-scheduler :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.dsh-scheduler input{width:90px;margin:0 8px}`,
            ),
            h("h3", null, "Model Scheduler"),
            h(
              "p",
              null,
              "Keep a model loaded for 60 seconds without requests. When another model waits, switch after 5 quiet seconds. Requests for the loaded model run together across chats and restart that timer. Active answers and checkpoint saves finish first. Fast grey means waiting for first output; fast blue means generating. Only registered engines are managed.",
            ),
            h(
              "label",
              null,
              "Idle retention with no waiting model (seconds) ",
              h("input", {
                type: "number",
                min: 0,
                max: 86400,
                value: seconds ?? data?.idleSeconds ?? 60,
                onChange: (e) => setSeconds(e.target.value),
              }),
            ),
            h(
              "label",
              null,
              "Quiet period when another model waits (seconds) ",
              h("input", {
                type: "number",
                min: 0,
                max: 86400,
                value: switchSeconds ?? data?.switchSeconds ?? 5,
                onChange: (e) => setSwitchSeconds(e.target.value),
              }),
            ),
            h(
              "label",
              null,
              "Quiet period for waiting background models (seconds) ",
              h("input", {
                type: "number",
                min: 0,
                max: 86400,
                value: backgroundSeconds ?? data?.backgroundSeconds ?? 5,
                onChange: (e) => setBackgroundSeconds(e.target.value),
              }),
            ),
            h(
              "button",
              {
                disabled: busy,
                onClick: () =>
                  act("configure", {
                    idleSeconds: Number(seconds ?? data?.idleSeconds ?? 60),
                    switchSeconds: Number(
                      switchSeconds ?? data?.switchSeconds ?? 5,
                    ),
                    backgroundSeconds: Number(
                      backgroundSeconds ?? data?.backgroundSeconds ?? 5,
                    ),
                  }),
              },
              "Save",
            ),
            error && h("p", { role: "alert" }, error),
            data?.devices.map((d) =>
              h(
                "p",
                { key: d.gpu },
                "GPU " +
                  d.gpu +
                  ": " +
                  (d.model || "idle") +
                  " · " +
                  d.phase +
                  (d.keepWarm ? " · keeping cache warm" : "") +
                  " · " +
                  d.queue.length +
                  " waiting",
                d.error ? " · " + d.error : "",
              ),
            ),
            data?.gpuProcesses?.length > 0 &&
              h(
                "details",
                null,
                h(
                  "summary",
                  null,
                  "GPU processes, including applications outside DSH",
                ),
                h(
                  "p",
                  null,
                  "Detection is read-only. Only registered drivers can be unloaded; other applications are never killed.",
                ),
                data.gpuProcesses.map((p) =>
                  h(
                    "p",
                    { key: p.pid },
                    p.name + " · PID " + p.pid + " · " + p.memoryMiB + " MiB",
                  ),
                ),
              ),
            data?.models.map((m) =>
              h(
                "div",
                {
                  key: m.key,
                  style: {
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "8px 0",
                  },
                },
                h("span", { style: { flex: 1 } }, m.name),
                h(
                  "button",
                  {
                    disabled: busy,
                    onClick: () => act("load", { key: m.key }),
                  },
                  "Load",
                ),
                h(
                  "button",
                  { onClick: () => act("unload", { key: m.key, force: true }) },
                  "Unload",
                ),
              ),
            ),
          );
        }
        ctx.slots.inject("settings.models.footer", () =>
          ctx.slots.register(
            {
              name: "settings.models.footer",
              id: "dsh-model-scheduler",
              order: 5,
            },
            Card,
          ),
        );
      },
    };
  },
});
