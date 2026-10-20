# DSH Model Scheduler

A separate Cordis plugin for DeepSeek Harness 0.2.1-rc.2. Install this repository through DSH's plugin installer, or use `dsh plugin --profile web add link:/absolute/path/dsh-model-scheduler` for local development.

The Models settings page exposes the idle delay (30 seconds by default), registered models, load/unload controls, current GPU owner and waiting requests. Strata and NInfer remain independent plugins; when this service is installed, they request admission through it. No Harness core patches are required.

The scheduler serializes managed requests on each GPU. An active chat finishes before another model loads. Its idle grace period starts when the request and its KV checkpoint finish. A request for the same loaded model can reuse it immediately. Queues preserve arrival order, with interactive requests ahead of background work. Cancelling a queued chat removes it without loading its model.

Unloading stops the process tree owned by its engine plugin. An external server cannot be forcibly unloaded: the scheduler reports that its owner must stop it. It also refuses to admit another model after a failed unload.

## Background integration

Plugins may optionally inject the Cordis `modelScheduler` service and call `acquire(driver, signal)`. A driver supplies `key`, `name`, `gpu`, `fingerprint`, `load(signal)`, and `unload()`. Background drivers set `priority: 'background'`. The returned lease contains `state`, an abortable `signal`, and an idempotent `release()`.

Release a background lease at a document boundary. A waiting chat causes immediate unloading at that boundary; after 30 seconds the lease is aborted and `unload()` must terminate its GPU worker and confirm memory release. The caller should retry the interrupted document on CPU without publishing partial results. This service is cooperative: it cannot move an arbitrary third-party worker to a different device, intercept every OS process, or make a CPU-only runtime execute on CUDA. Knowledge GPU integration must be implemented and qualified by the knowledge plugin separately.

Lifecycle policy lives here. Engine-specific cache formats and process ownership stay in their provider plugins. No requirement for Strata and NInfer to talk directly to each other.

Run `node --test test/*.test.js` for queue, cancellation, priority, deadline and unload failure checks.
