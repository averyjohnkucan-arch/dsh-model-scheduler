# DSH Model Scheduler

A separate Cordis plugin for DeepSeek Harness 0.2.1-rc.2. Install this repository through DSH's plugin installer, or use `dsh plugin --profile web add link:/absolute/path/dsh-model-scheduler` for local development.

The Models settings page exposes the idle retention (300 seconds by default) and a separate model-switch grace (30 seconds by default), registered models, load/unload controls, current GPU owner and waiting requests. Strata and NInfer remain independent plugins; when this service is installed, they request admission through it. No Harness core patches are required.

The scheduler serializes managed requests on each GPU. A fully completed or stopped turn switches to another queued model immediately after the owned process confirms unloading. The 30-second grace applies only when another model is waiting while the existing turn still has tool work or another between-inference wait. The grace starts when the competing request queues, not after completion; ending the turn removes the delay immediately. A continuation of the current turn may reuse its model within the grace without resetting the contender's deadline. An active generation finishes before another model loads; the existing 30-second preemption deadline for background workers remains separate.

With no competing request, an unused model stays loaded for up to five minutes (or stays warm if its driver requests that). The idle retention, waiting-turn grace and background admission delay are independently configurable. Cancelling the contender preserves normal idle retention. Public `session/event` and `llm/stream` hooks associate sessions and leases inside this plugin; Strata and NInfer need no turn-tracking changes. Drivers without a DSH session have request-level tracking: after their lease releases and any busy operation completes, handoff is immediate. Queues preserve arrival order, with interactive requests ahead of background work. Cancelling a queued chat removes it without loading its model.

Unloading stops the process tree owned by its engine plugin. An external server cannot be forcibly unloaded: the scheduler reports that its owner must stop it. It also refuses to admit another model after a failed unload.

## Background integration

Plugins may optionally inject the Cordis `modelScheduler` service and call `acquire(driver, signal)`. A driver supplies `key`, `name`, `gpu`, `fingerprint`, `load(signal)`, and `unload()`. Background drivers set `priority: 'background'`. They wait for the current foreground turn to finish and for 120 seconds (configurable) after its last inference lease releases. A new foreground request resets this quiet period; another chat always goes ahead of queued background work. This delay also applies to keep-warm models, which retain their cache while background work waits. It is separate from the five-minute idle retention and 30-second unfinished-turn grace for competing foreground requests. The returned lease contains `state`, an abortable `signal`, and an idempotent `release()`.

A driver may set `keepWarm: true` to skip idle unloading while nothing else is waiting. This preserves an in-memory conversation cache. It still yields to another queued model under the pending-turn policy, exclusive image work, manual unload and shutdown. This per-model setting does not change the global idle timer for other models; status reports `keepWarm` and the Models card shows when cache retention is active.

Release a background lease at a document boundary. A waiting chat causes immediate unloading at that boundary; after 30 seconds the lease is aborted and `unload()` must terminate its GPU worker and confirm memory release. The caller should retry the interrupted document on CPU without publishing partial results. This service is cooperative: it cannot move an arbitrary third-party worker to a different device, intercept every OS process, or make a CPU-only runtime execute on CUDA. Knowledge GPU integration must be implemented and qualified by the knowledge plugin separately.

Lifecycle policy lives here. Engine-specific cache formats and process ownership stay in their provider plugins. No requirement for Strata and NInfer to talk directly to each other.

Run `node --test test/*.test.js` for queue, cancellation, priority, deadline and unload failure checks.

## Exclusive image/video tools

`runExclusive(driver, operation, {signal, restorePrevious:true})` waits for active inference, bypasses the idle grace period for a new workload, and confirms its owned process unload before restoring the prior chat driver. If another queued chat already owns the GPU, restoration is deferred to the next chat request. Preflight/render failures still attempt to restore the displaced model.

The Models card lists detected NVIDIA GPU compute processes, including applications outside DSH. Detection is read-only; it does not imply ownership or grant permission to kill an external application. Cooperative third-party plugins can register their own lifecycle drivers. DSH Image Tools uses this API.

## Foreground resource reservations

Background plugins can register `registerResourceGuard(id, async ({gpu, key, signal}) => release)` on the optional `modelScheduler` Cordis service. Before every interactive load or reuse (including image rendering and automatic chat restoration), the scheduler waits for these guards to finish releasing background device workers. It holds their returned, idempotently released reservations for the inference lease. Failed reservations prevent model startup; earlier reservations are released. Background leases do not reserve foreground resources. Plugins own and stop their own workers; the scheduler never guesses or kills external processes. Knowledge uses this hook to yield its GPU embedding workers while leaving CPU and NPU lanes available.

## Generation indicators

Queued chats remain grey with the normal slow rotation. The admitted conversation
is blue and slow (1.5 seconds) during model loading, prefill, checkpoint work,
image/video work, and between-step tool waits. Actual text, reasoning, or tool-call
token deltas switch it to blue and fast (650 ms). If output stalls for 1.5 seconds,
it returns to slow blue until tokens resume. The indicator clears at completion,
cancellation, or handoff to another conversation. A working/generating subagent
also lights its ancestor chats; ordinary forks and background OCR/embedding do not.
Unscheduled provider streams use the same working/output phases. Reduced-motion
preferences disable the added rotation.

The plugin uses `session/event`, `llm/stream`, and `tools/execute` to associate work
with sessions. One lightweight authenticated poll per visible browser page reads
activity every 500 ms; it does not query NVIDIA, write to disk, or start models.
Failed/disconnected polls clear the blue state.

The sidebar uses its row-action slot to supply scoped styles. DSH 0.2.1-rc.2 has no
per-subagent indicator slot, so the plugin shadows only the two subagent catalog
presentation slots using the supported priority mechanism. Its local, MIT-licensed
view preserves the upstream navigation, keyboard handling, metrics and locale;
only its status indicators change. See `client/subagent-views.js` and
`THIRD_PARTY_LICENSES.md`. Removing the plugin restores the standard views.
No Harness files or other plugins are modified.

After editing the client sources, run `npm run build` to regenerate `client.js`,
then `npm run check` and `npm test`.
