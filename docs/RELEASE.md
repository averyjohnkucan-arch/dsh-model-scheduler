# Model Scheduler 0.2.0

The default policy now keeps a model for 60 idle seconds, or switches after five quiet seconds when another model waits. Queued conversations using the resident model run together and restart the quiet timer after their requests complete. Active answers and checkpoint saves finish before handoff.

Activity indicators are included: slow grey while queued or between calls, fast grey while an admitted call waits for output, and fast blue during text, reasoning or tool-call generation. Nested subagents roll up to their parent chats. Disable the old standalone activity plugin after installing this one.

Verified with Strata 0.6.4, NInfer 0.4.3 and Dory 0.2.1. Their inference engines are unchanged. The release pipeline tests the actual provider classes against the scheduler with simulated owned servers, along with timing, cancellation, lifecycle and browser rendering tests. A separate live Flash Next Gyro S test passed at 262K FP16/FP16 after the competing idle NInfer model released the GPU. This is not a native three-model performance benchmark.
