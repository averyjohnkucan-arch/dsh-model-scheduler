# DSH Model Scheduler

Shared GPU model handoff and conversation activity indicators for DeepSeek Harness 0.2.1-rc.2. No Harness or native-engine patches are needed.

## Install

Paste `https://github.com/averyjohnkucan-arch/dsh-model-scheduler#v0.2.0` into **Plugins → Add plugin**, enable it, then restart DSH and reload the page. Use Strata 0.6.4+, NInfer 0.4.3+ and Dory 0.2.1+ for the coordinated paths verified with this release. Existing saved profiles and native tuning settings stay in their provider plugins.

The activity indicators are included here. Disable and uninstall the old `dsh-activity-indicators` plugin if it is installed; only this scheduler plugin is needed.

## Handoff policy

- With no other model waiting, unload after **60 seconds** without a request.
- When a different model waits, switch after **5 quiet seconds** since the last request released its lease. An active answer and checkpoint save finish before that clock starts.
- Drain queued requests for the resident model across conversations, in arrival order within that model. A new request for it during the quiet interval runs immediately and restarts the clock after finishing.
- Tool calls, questions and turn boundaries can create the required pause. Completing a turn does not bypass the five seconds; a long tool call does not retain the GPU forever.
- A cancelled contender is removed without loading. If no contenders remain, the normal 60-second idle deadline applies. Each GPU has its own queue.

For example, with two Flash Next conversations and two 27B conversations, Flash Next serves both of its queued conversations without reloading. After five seconds with no Flash Next request, it unloads and the 27B batch runs. A continuous supply of requests for the resident model can therefore keep other models waiting until a quiet gap.

The Models settings card shows the GPU owner, waiting requests and registered providers. The idle, foreground-switch and background-switch quiet periods are configurable; new installs default to 60/5/5 seconds. Existing explicitly saved timings remain in effect until changed in settings. An explicit driver `keepWarm` request skips idle unloading when nothing else waits; it does not block another model. Exclusive tools and manual unload have explicit handoff paths.

Only registered provider processes can be unloaded. Unknown GPU applications are never killed. A failed unload blocks admission until its owner can release the GPU.

## Activity indicators

| State | Indicator |
| --- | --- |
| Queued or between model calls | Normal slow grey spinner |
| Admitted call awaiting first output | Fast grey spinner |
| Text, reasoning or tool-call output | Fast blue spinner |
| Finished, cancelled, approval or question | Native DSH status |

Blue persists through gaps between chunks until that model call ends. Each new call starts grey. Nested subagent activity rolls up through its ancestor chats; ordinary chat forks do not affect parents. Reduced-motion preferences disable the added rotation. Fast grey can include model loading, checkpoint restore and network latency; it is not a measurement of GPU prefill kernels. One authenticated read-only poll updates phases while the browser is visible.

The indicator implementation was merged from `dsh-activity-indicators` revision `608312452fc3d66656739256f887b03e1be469b4`. The old standalone repository can be removed after this release is published. Adapted DSH subagent views retain their MIT notice in THIRD_PARTY_LICENSES.md.

## Provider integration

Optionally inject the Cordis `modelScheduler` service and call `acquire(driver, signal)`. A driver supplies `key`, `name`, `gpu`, `fingerprint`, `load(signal)` and `unload()`. Keep the lease through generation and checkpoint IO; release it in a finally block. Drivers own process termination and must confirm unloading before returning. The scheduler does not guess PIDs or cache formats.

Background drivers set `priority: 'background'` and release at a document boundary. Foreground requests precede background work. Background admission uses its own configurable quiet timer, also five seconds by default. An active background worker may be asked to yield after its separate 30-second preemption deadline; its owner must stop the worker and retry incomplete work on CPU.

## Exclusive image/video tools

`runExclusive(driver, operation, {signal, restorePrevious:true})` waits for active inference, bypasses the idle grace period for a new workload, and confirms its owned process unload before restoring the prior chat driver. If another queued chat already owns the GPU, restoration is deferred to the next chat request. Preflight/render failures still attempt to restore the displaced model.

The Models card lists detected NVIDIA GPU compute processes, including applications outside DSH. Detection is read-only; it does not imply ownership or grant permission to kill an external application. Cooperative third-party plugins can register their own lifecycle drivers. DSH Image Tools uses this API.

## Foreground resource reservations

Background plugins can register `registerResourceGuard(id, async ({gpu, key, signal}) => release)` on the optional `modelScheduler` Cordis service. Before every interactive load or reuse (including image rendering and automatic chat restoration), the scheduler waits for these guards to finish releasing background device workers. It holds their returned, idempotently released reservations for the inference lease. Failed reservations prevent model startup; earlier reservations are released. Background leases do not reserve foreground resources. Plugins own and stop their own workers; the scheduler never guesses or kills external processes. Knowledge uses this hook to yield its GPU embedding workers while leaving CPU and NPU lanes available.

## Development

The sidebar uses its row-action slot for scoped styles. DSH 0.2.1-rc.2 has no individual subagent indicator slot, so the two catalog presentation slots use supported priority shadowing. The adapted view preserves navigation, keyboard handling, metrics and locale. No Harness files are modified; removing the plugin restores its standard views.

After editing client sources, run `npm run build`, `npm run check` and `npm test`. The suite covers timing, model batches, cancellation, lifecycle, authentication, phase tracking and rendered subagent indicators. `scripts/verify-providers.mjs` checks the actual Strata, NInfer and Dory runtime classes with simulated servers; CI pins their source revisions.

See [COMPATIBILITY.md](COMPATIBILITY.md) for supported DSH versions and upgrade checks.
