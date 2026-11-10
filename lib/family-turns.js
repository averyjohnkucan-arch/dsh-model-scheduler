/** Alternate a queued main chat with its descendants at model-request boundaries. */
export class FamilyTurns {
  constructor(parents) {
    this.parents = parents;
    this.turns = new Map();
  }

  root(sessionId) {
    if (!sessionId) return undefined;
    const seen = new Set();
    let current = sessionId;
    while (this.parents.has(current)) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      current = this.parents.get(current);
    }
    return current;
  }

  eligible(request) {
    return request.sessionId && request.driver.priority !== "background" &&
      !request.driver.immediate && !request.controller.signal.aborted;
  }

  state(root) {
    if (!this.turns.has(root)) this.turns.set(root, { children: [] });
    return this.turns.get(root);
  }

  select(queue, candidate) {
    const unchanged = { request: candidate, ordered: false };
    if (!this.eligible(candidate)) return unchanged;
    const root = this.root(candidate.sessionId);
    if (!root) return unchanged;
    // One oldest request per session; a chat cannot buy extra shares by queuing more.
    const pending = new Map();
    for (const request of queue) {
      if (this.eligible(request) && this.root(request.sessionId) === root &&
          !pending.has(request.sessionId)) pending.set(request.sessionId, request);
    }
    const children = [...pending.keys()].filter(id => id !== root);
    if (children.length === 0 || pending.size < 2) return unchanged;
    const state = this.state(root);
    for (const id of children) if (!state.children.includes(id)) state.children.push(id);
    const main = pending.get(root);
    if (main && state.lastSessionId !== root) return { request: main, ordered: true };
    const start = state.children.indexOf(state.lastChildId) + 1;
    for (let offset = 0; offset < state.children.length; offset++) {
      const id = state.children[(start + offset) % state.children.length];
      if (pending.has(id)) return { request: pending.get(id), ordered: true };
    }
    return unchanged;
  }

  admit(request) {
    if (!this.eligible(request)) return;
    const root = this.root(request.sessionId);
    if (!root) return;
    const state = this.state(root);
    state.lastSessionId = request.sessionId;
    if (request.sessionId !== root) {
      if (!state.children.includes(request.sessionId)) state.children.push(request.sessionId);
      state.lastChildId = request.sessionId;
    }
  }

  clear() { this.turns.clear(); }
}
