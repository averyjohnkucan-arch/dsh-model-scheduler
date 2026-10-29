window.__ModuleLoader__.load({
  id: "dsh-model-scheduler",
  factory(require) {
    const React = require("react"),
      h = React.createElement,
      { useState, useEffect } = React;
    /* GENERATION_UI */
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
