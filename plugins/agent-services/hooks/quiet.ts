
let bound: string | null = null
let finished = new Map<string, true>()
let silences = new Map<string, string>()
let onces = new Map<string, true>()
let slots = new Map<string, string>()

function ok(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 300
}

function put<V>(m: Map<string, V>, k: string, v: V): void {
  m.delete(k)
  m.set(k, v)
  while (m.size > 500) {
    const first = m.keys().next().value
    if (first === undefined) break
    m.delete(first)
  }
}

export function bindSession(id: string): void {
  if (!ok(id) || id === bound) return
  if (bound !== null) resetForTests()
  bound = id
}

export function markFinished(id: string): void {
  if (ok(id)) put(finished, id, true)
}

export function markLive(id: string): void {
  if (ok(id)) finished.delete(id)
}

export function isFinished(id: string): boolean {
  return ok(id) && finished.has(id)
}

function ended(status: unknown): boolean {
  return /^(completed|complete|done|failed|error|killed|stopped|cancelled|canceled)$/i.test(String(status ?? '').trim())
}

export function finishedFromNotification(text: unknown): string[] {
  const out: string[] = []
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return out
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
    const body = m[1] ?? ''
    const tag = (name: string): string => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() ?? ''
    if (!ended(tag('status'))) continue
    for (const id of [tag('task-id'), tag('tool-use-id')]) {
      if (ok(id)) {
        markFinished(id)
        out.push(id)
      }
    }
  }
  return out
}

export function finishedFromSpawn(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const r = result as Record<string, unknown>
  if (!ok(r.agentId) || r.isAsync === true || !ended(r.status)) return null
  markFinished(r.agentId)
  return r.agentId
}

export function finishedFromList(list: unknown): string[] {
  const out: string[] = []
  if (!Array.isArray(list)) return out
  for (const row of list) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const id = ok(r.id) ? r.id : ok(r.agentId) ? r.agentId : null
    if (id === null || !ended(r.status)) continue
    markFinished(id)
    out.push(id)
  }
  return out
}

export function silence(subject: string, reason: string): void {
  if (ok(subject)) put(silences, subject, typeof reason === 'string' ? reason.slice(0, 300) : '')
}

export function isSilencedHere(subject: string): boolean {
  return ok(subject) && silences.has(subject)
}

export function silenceReason(subject: string): string | null {
  return ok(subject) ? silences.get(subject) ?? null : null
}

export function onceKey(key: string): boolean {
  if (!ok(key) || onces.has(key)) return false
  put(onces, key, true)
  return true
}

export function textHash(text: string): string {
  const s = typeof text === 'string' ? text : String(text ?? '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return `${h.toString(16).padStart(8, '0')}-${s.length}`
}

export function sameAsLast(slot: string, text: string): boolean {
  if (!ok(slot)) return false
  const h = textHash(text)
  const same = slots.get(slot) === h
  put(slots, slot, h)
  return same
}

export function forgetSlot(slot: string): void {
  if (ok(slot)) slots.delete(slot)
}

export function resetForTests(): void {
  bound = null
  finished = new Map<string, true>()
  silences = new Map<string, string>()
  onces = new Map<string, true>()
  slots = new Map<string, string>()
}
