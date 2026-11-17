// Server → panel push channel (SSE). Used for live refresh after agent tool calls
// and for the "看这里" navigation the agent triggers via `career_panel`.
export class PanelBus {
  constructor() {
    this.listeners = new Set()
    this.lastNavigate = null
    this.history = []
  }

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  publish(payload) {
    if (payload?.kind === 'navigate') this.lastNavigate = payload
    this.history.push({ at: new Date().toISOString(), payload })
    if (this.history.length > 50) this.history.shift()
    for (const fn of [...this.listeners]) {
      try {
        fn(payload)
      } catch {
        /* a broken panel must never break a tool call */
      }
    }
  }

  get count() {
    return this.listeners.size
  }
}
