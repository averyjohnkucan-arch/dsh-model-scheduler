# DSH Model Scheduler

A separate Cordis plugin for DeepSeek Harness 0.2.1-rc.2. Install this repository through DSH's plugin installer, or use `dsh plugin --profile web add link:/absolute/path/dsh-model-scheduler` for local development.

The Models settings page exposes the idle retention (300 seconds by default) and a separate model-switch grace (30 seconds by default), registered models, load/unload controls, current GPU owner and waiting requests. Strata and NInfer remain independent plugins; when this service is installed, they request admission through it. No Harness core patches are required.

The scheduler serializes managed requests on each GPU. A fully completed or stopped turn switches to another queued model immediately after the owned process confirms unloading. The 30-second grace applies only when another model is waiting while the existing turn still has tool work or another between-inference wait. The grace starts when the competing request queues, not after completion; ending the turn removes the delay immediately. A continuation of the current turn may reuse its model within the grace without resetting the contender's deadline. An active generation finishes before another model loads; the existing 30-second preemption deadline for background workers remains separate.

With no competing request, an unused model stays loaded for up to five minutes (or stays warm if its driver requests that). The idle retention and waiting-turn grace are independently configurable. Cancelling the contender preserves normal idle retention. Public `session/event` and `llm/stream` hooks associate sessions and leases inside this plugin; Strata and NInfer need no turn-tracking changes. Drivers without a DSH session have request-level tracking: after their lease releases and any busy operation completes, handoff is immediate. Queues preserve arrival order, with interactive requests ahead of background work. Cancelling a queued chat removes it without loading its model.

Unloading stops the process tree owned by its engine plugin. An external server cannot be forcibly unloaded: the scheduler reports that its owner must stop it. It also refuses to admit another model after a failed unload.

## Background integration

Plugins may optionally inject the Cordis `modelScheduler` service and call `acquire(driver, signal)`. A driver supplies `key`, `name`, `gpu`, `fingerprint`, `load(signal)`, and `unload()`. Background drivers set `priority: 'background'`. The returned lease contains `state`, an abortable `signal`, and an idempotent `release()`.

A driver may set `keepWarm: true` to skip idle unloading while nothing else is waiting. This preserves an in-memory conversation cache. It still yields to another queued model under the pending-turn policy, exclusive image work, manual unload and shutdown. This per-model setting does not change the global idle timer for other models; status reports `keepWarm` and the Models card shows when cache retention is active.

Release a background lease at a document boundary. A waiting chat causes immediate unloading at that boundary; after 30 seconds the lease is aborted and `unload()` must terminate its GPU worker and confirm memory release. The caller should retry the interrupted document on CPU without publishing partial results. This service is cooperative: it cannot move an arbitrary third-party worker to a different device, intercept every OS process, or make a CPU-only runtime execute on CUDA. Knowledge GPU integration must be implemented and qualified by the knowledge plugin separately.

Lifecycle policy lives here. Engine-specific cache formats and process ownership stay in their provider plugins. No requirement for Strata and NInfer to talk directly to each other.

Run `node --test test/*.test.js` for queue, cancellation, priority, deadline and unload failure checks.

## Exclusive image/video tools

`runExclusive(driver, operation, {signal, restorePrevious:true})` waits for active inference, bypasses the idle grace period for a new workload, and confirms its owned process unload before restoring the prior chat driver. If another queued chat already owns the GPU, restoration is deferred to the next chat request. Preflight/render failures still attempt to restore the displaced model.

The Models card lists detected NVIDIA GPU compute processes, including applications outside DSH. Detection is read-only; it does not imply ownership or grant permission to kill an external application. Cooperative third-party plugins can register their own lifecycle drivers. DSH Image Tools uses this API.
