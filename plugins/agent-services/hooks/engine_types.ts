
export type SvcResult = {
  ok: boolean
  status: number | null
  body: unknown
  error: string | null
}

export type CallOptions = { kind: string; deadlineMs: number }
export type ServedSelect = { jit?: boolean; event?: string }

export type GateState = { open: boolean; reason: string | null; minShell: string | null; retryAt?: number | null }

export interface Transport {
  call(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | null, opts: CallOptions): Promise<SvcResult>
  gateState(): Promise<GateState>
  handshake(opts: CallOptions): Promise<SvcResult>
  fetchServed(sessionRef: string, role: string, phase: string, opts: CallOptions, state?: Record<string, unknown>, select?: ServedSelect): Promise<SvcResult>
  fetchToolbox(sessionRef: string, pack: string, topic: string | undefined, opts: CallOptions): Promise<SvcResult>
  endServedSession(sessionRef: string): void
}

export interface KV {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type Clock = () => number
export type Random = (n: number) => Uint8Array
export type ReadText = (path: string) => Promise<string | null>
