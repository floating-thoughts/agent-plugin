// The core's Transport over the svc channel (moved from wiring.ts unchanged): engine_types.ts
// Transport on svc.ts Svc, with the hook budget each core deadline fits in.
import type { CallOptions, GateState, ServedSelect, SvcResult, Transport } from './engine_types'
import type { Hook, Kind, Svc } from './svc'
import { HOOK_BUDGET_MS, TIMEOUTS_MS } from './svc'
import { TOOLBOX_ROUTE } from './svc_wire'

const result = (r: { ok: boolean; status: number | null; body: unknown; error: string | null }): SvcResult => ({
  ok: r.ok,
  status: r.status,
  body: r.body,
  error: r.error,
})

// ------------------------------------------------------------------ the core's Transport over the svc channel

/** The svc hook budget a core deadline fits in: agent.spawn 1 s, tool.call 8 s, else background. */
export const hookFor = (deadlineMs: number): Hook =>
  !(deadlineMs > HOOK_BUDGET_MS.spawn) ? 'spawn' : deadlineMs <= HOOK_BUDGET_MS.tool ? 'tool' : 'background'

const FAILED: SvcResult = { ok: false, status: null, body: null, error: 'failed' }

/**
 * engine_types.ts Transport on svc.ts Svc. The gate is the auth state first ('login' or 'locked' straight
 * from the store, so a signed-out session passes every event through from its first one), then the channel's gate.
 * Never throws.
 */
export function svcTransport(svc: Svc): Transport {
  const kindOf = (k: string): Kind | undefined => (Object.hasOwn(TIMEOUTS_MS, k) ? (k as Kind) : undefined)
  return {
    async call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | null, opts: CallOptions): Promise<SvcResult> {
      try {
        return result(await svc.call(method, path, body ?? undefined, { kind: kindOf(opts?.kind), hook: hookFor(opts?.deadlineMs) }))
      } catch {
        return FAILED
      }
    },
    async gateState(): Promise<GateState> {
      try {
        const a = await svc.authState()
        if (a !== 'ok') return { open: false, reason: a === 'locked' || a === 'paused' ? a : 'login', minShell: null }
        const g = svc.gateState()
        // Signed in (in the store) while this session's gate still says login or locked: another session signed in
        // since this one's 401 or 423. Report unknown so the core handshakes again.
        if (!g.open && (g.reason === 'login' || g.reason === 'locked' || g.reason === 'paused')) return { open: false, reason: 'unknown', minShell: null }
        const until = typeof svc.retryAt === 'function' ? svc.retryAt() : null
        return until === null ? { open: g.open, reason: g.reason, minShell: g.min_shell }
          : { open: g.open, reason: g.reason, minShell: g.min_shell, retryAt: until / 1000 }
      } catch {
        return { open: false, reason: 'unavailable', minShell: null }
      }
    },
    async handshake(opts: CallOptions): Promise<SvcResult> {
      try {
        return result(await svc.handshake(hookFor(opts?.deadlineMs)))
      } catch {
        return FAILED
      }
    },
    async fetchServed(sessionRef: string, role: string, phase: string, opts: CallOptions, state?: Record<string, unknown>, select?: ServedSelect): Promise<SvcResult> {
      try {
        return result(await svc.fetchServed(sessionRef, role, phase, hookFor(opts?.deadlineMs), state, select))
      } catch {
        return FAILED
      }
    },
    async fetchToolbox(sessionRef: string, pack: string, topic: string | undefined, opts: CallOptions): Promise<SvcResult> {
      try {
        const body: Record<string, unknown> = { session_ref: sessionRef, pack }
        if (topic !== undefined) body.topic = topic
        return result(await svc.call('POST', TOOLBOX_ROUTE, body, { kind: 'served', hook: hookFor(opts?.deadlineMs) }))
      } catch {
        return FAILED
      }
    },
    endServedSession(sessionRef: string): void {
      try {
        svc.endServedSession(sessionRef)
      } catch {
        // local only
      }
    },
  }
}
