'use strict';

/** Lightweight observability layer. Keeps only aggregate runtime metrics, not message contents. */
class Telemetry {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.startedAt = this.now();
    this.counters = Object.create(null);
    this.latencies = [];
    this.decisions = Object.create(null);
    this.errors = [];
  }
  inc(name, n = 1) { this.counters[name] = (this.counters[name] || 0) + n; }
  decision(name) { this.decisions[name] = (this.decisions[name] || 0) + 1; }
  observe(ms) { if (Number.isFinite(ms)) this.latencies.push(ms); if (this.latencies.length > 500) this.latencies.shift(); }
  error(kind) { this.errors.push({ kind: String(kind), at: this.now() }); if (this.errors.length > 50) this.errors.shift(); }
  snapshot() {
    const xs = [...this.latencies].sort((a,b)=>a-b);
    const pct = (p) => xs.length ? Math.round(xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]) : 0;
    return {
      uptimeSeconds: Math.floor((this.now() - this.startedAt) / 1000),
      counters: { ...this.counters },
      decisions: { ...this.decisions },
      latencyMs: { p50: pct(.5), p95: pct(.95), samples: xs.length },
      recentErrors: [...this.errors]
    };
  }
}
module.exports = { Telemetry };
