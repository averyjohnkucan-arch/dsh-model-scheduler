/** Transient phases only: no prompts, tokens, or history are stored. */
export class Activity {
  attempts = new Map();

  frame(sessionId, frame) {
    if (frame.type === "start") {
      this.attempts.set(sessionId, { id: frame.attemptId, phase: "prefill" });
      return;
    }
    const current = this.attempts.get(sessionId);
    if (current && current.id !== frame.attemptId) return;
    if (frame.type === "end") this.attempts.delete(sessionId);
    else if (frame.type === "chunk") {
      const chunk = frame.chunk;
      const output =
        chunk.type === "text-delta" || chunk.type === "reasoning-delta"
          ? typeof chunk.text === "string" && chunk.text.length > 0
          : chunk.type === "tool-call-delta" &&
            ((typeof chunk.argumentsDelta === "string" &&
              chunk.argumentsDelta.length > 0) ||
              (typeof chunk.name === "string" && chunk.name.length > 0));
      if (chunk.type === "finish") this.attempts.delete(sessionId);
      else if (output)
        this.attempts.set(sessionId, {
          id: frame.attemptId,
          phase: "generating",
        });
    }
  }

  clear(sessionId) {
    this.attempts.delete(sessionId);
  }

  snapshot(scheduled) {
    const admitted = scheduled
      ? new Set(scheduled.directSessionIds)
      : undefined;
    const prefilling = new Set(),
      generating = new Set();
    for (const [id, attempt] of this.attempts) {
      if (admitted && !admitted.has(id)) continue;
      (attempt.phase === "generating" ? generating : prefilling).add(id);
    }
    // A plugin enabled during an existing stream can use the scheduler's
    // current token evidence until its first observed output frame arrives.
    for (const id of scheduled?.directGeneratingSessionIds ?? []) {
      if (!this.attempts.has(id) && admitted.has(id)) generating.add(id);
    }
    return {
      prefillingSessionIds: [...prefilling].sort(),
      generatingSessionIds: [...generating].sort(),
    };
  }
}
