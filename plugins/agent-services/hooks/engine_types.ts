// The seams of the in-process core (core.ts, records.ts, counters.ts): what it needs from the svc channel
// (svc.ts, P2), the store, the clock and the file system. Harness-neutral: nothing here touches `$`.
// Types only; Node's type stripping erases this file's imports.

// One answer from the service, as host/services.py Result: `ok` with the opened inner body, or an error code.
export type SvcResult = {
  ok: boolean
  status: number | null
  body: unknown
  error: string | null
}

// Each call carries the deadline it must answer within (3.3 item 3: agent.spawn 1 s, tool.call 8 s in all,
// background work longer). The channel never sleeps out a Retry-After inside it.
export type CallOptions = { kind: string; deadlineMs: number }

// The shell gate as host/services.py gate_state(). Reasons: null (open), 'unknown' (no hello yet), 'login'
// (no valid sign-in, or a 401 that did not recover), 'locked' (a 423 that did not recover), 'upgrade',
// 'offline', 'unavailable', 'unverified'. 'login' and 'locked' are the auth-fail state of plan 3.9.
export type GateState = { open: boolean; reason: string | null; minShell: string | null }

// What the core needs from the svc channel. P2's svc.ts implements it; the tests use a fake.
export interface Transport {
  // One sealed, signed request (`path` is the inner path, as '/router/decide'). Never throws.
  call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | null, opts: CallOptions): Promise<SvcResult>
  // The gate as last known; cheap (the channel re-reads `$.store` at most once per 5 s). Never throws.
  gateState(): Promise<GateState>
  // One POST /auth/hello that opens or closes the gate; `body.plan` carries the plan. Never throws.
  handshake(opts: CallOptions): Promise<SvcResult>
  // One phase of a role's served items (bound per session_ref, as Connector.fetch_served). Never throws.
  fetchServed(sessionRef: string, role: string, phase: string, opts: CallOptions): Promise<SvcResult>
  // Forget the served binding of a session (local only, as Connector.end_served_session).
  endServedSession(sessionRef: string): void
}

// The `$.store` subset the core uses: a JSON key-value store shared by every session, readable by other plugins,
// with no atomic read-modify-write.
export interface KV {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type Clock = () => number // milliseconds since the epoch
export type Random = (n: number) => Uint8Array
export type ReadText = (path: string) => Promise<string | null> // UTF-8 text, null when missing or unreadable
