// The toolbox index in the main agent's context (toolbox plan, serving). The service keeps know-how for
// one tool or tool family per pack; the model fetches a pack on demand with the `toolbox` tool (core.ts, guard.ts
// fetchToolbox). So that the model knows which packs exist, the plugin puts the index into the main agent's context:
// - once per session, with the first prompt that has it (phase.ts pushLessons), and again on the first prompt after
//   a /clear or a compaction (phase.ts pushAgain: that context no longer holds the block); never on a phase change;
// - fetched once per session (the guard caches it), from the first prompt of the main agent and not before (the
//   methods level is known only then), waited for at most the prompt's window; a fetch still running then goes with
//   a later prompt;
// - at methods level "suggest" and "on", never at "off" (phase.ts returns before); signed out: nothing; subagents
//   get nothing (main agent only);
// - fail open: a fallback answer (no_toolbox: no licence, an older server, a failure) or an empty index injects
//   nothing, and it is not tried again in this session.
// The block is one labelled block: the server's note (an agent-services suggestion, never the user's words) and the
// index as a dict {"key": "when", ...}; branched-problems is one entry like any other.
// Harness-neutral: nothing here touches `$`; the fetch, the auth state and the sleep are injected.

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** The context block for the toolbox tool's index answer, or null when it has nothing to give. Pure. */
export function indexBlock(answer: unknown): string | null {
  if (!isObj(answer) || answer.fallback !== null || answer.kind !== 'index') return null
  if (typeof answer.note !== 'string' || !answer.note || !isObj(answer.entries)) return null
  const rows = Object.entries(answer.entries).filter(([, v]) => typeof v === 'string')
  if (!rows.length) return null
  const dict = '{\n' + rows.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n}'
  return `<agent-toolbox version="${String(answer.version)}">\n${answer.note}\n${dict}\n</agent-toolbox>`
}

export type ToolboxDeps = {
  active(): Promise<boolean> // signed in (the auth gate); false: nothing is fetched or injected
  index(): Promise<unknown> // the toolbox tool's answer for key "index" (core.ts toolboxIndex)
  sleep: (ms: number) => Promise<unknown>
  waitMs: number
}

/** One session's toolbox index: fetched once, pushed once, and again after again(). Never throws. */
export class ToolboxPush {
  private readonly d: ToolboxDeps
  private pending: Promise<unknown> | null = null // the fetch in flight
  private fetched = false
  private block: string | null = null
  private sent = false

  constructor(d: ToolboxDeps) {
    this.d = d
  }

  private fetch(): Promise<unknown> {
    return Promise.resolve().then(() => this.d.index()).catch(() => null)
  }

  /** After a /clear or a compaction: the next prompt pushes the index again. */
  again(): void {
    this.sent = false
  }

  /** prompt.submit of the main agent: the index block to inject, or null. Waits at most waitMs. */
  async prompt(): Promise<string | null> {
    try {
      if (!(await this.d.active())) return null
      if (!this.fetched) {
        if (!this.pending) this.pending = this.fetch()
        const late = {}
        const got = await Promise.race([this.pending, Promise.resolve(this.d.sleep(this.d.waitMs)).then(() => late, () => late)])
        if (got === late) return null // still running: kept for a later prompt
        this.fetched = true
        this.pending = null
        this.block = indexBlock(got)
      }
      if (!this.block || this.sent) return null
      this.sent = true
      return this.block
    } catch {
      return null
    }
  }
}
