
import { mergeIndex } from './brain_serve'
import type { CompanyEntry } from './brain_serve'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export function indexBlock(answer: unknown): string | null {
  if (!isObj(answer) || answer.fallback !== null || answer.kind !== 'index') return null
  if (typeof answer.note !== 'string' || !answer.note || !isObj(answer.entries)) return null
  const rows = Object.entries(answer.entries).filter(([, v]) => typeof v === 'string')
  if (!rows.length) return null
  const dict = '{\n' + rows.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n}'
  return `<agent-toolbox version="${String(answer.version)}">\n${answer.note}\n${dict}\n</agent-toolbox>`
}

export type ToolboxDeps = {
  active(): Promise<boolean>
  index(): Promise<unknown>
  sleep: (ms: number) => Promise<unknown>
  waitMs: number
  company?(): Promise<CompanyEntry[] | null>
}

export class ToolboxPush {
  private readonly d: ToolboxDeps
  private pending: Promise<unknown> | null = null
  private fetched = false
  private block: string | null = null
  private sent = false

  constructor(d: ToolboxDeps) {
    this.d = d
  }

  private fetch(): Promise<unknown> {
    const index = Promise.resolve().then(() => this.d.index()).catch(() => null)
    if (!this.d.company) return index
    const company = Promise.resolve().then(() => this.d.company?.()).catch(() => null)
    return Promise.all([index, company]).then(([a, c]) => mergeIndex(a, c), () => index)
  }

  again(): void {
    this.sent = false
  }

  async prompt(): Promise<string | null> {
    try {
      if (!(await this.d.active())) return null
      if (!this.fetched) {
        if (!this.pending) this.pending = this.fetch()
        const late = {}
        const got = await Promise.race([this.pending, Promise.resolve(this.d.sleep(this.d.waitMs)).then(() => late, () => late)])
        if (got === late) return null
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
