import { sha256 } from './noble.js'
import { hex, utf8 } from './e2e'
import { serveBrain } from './brain_serve'
import type { CompanyEntry, Send } from './brain_serve'
import { identityPublic } from './sealed_keys'
import type { Identity } from './sealed_keys'
import type { Roster } from './sealed_roster'
import { KitError, compareVersions } from './ckit'

export type ExportIn = { org: string; identity: Identity; roster: Roster; t: number }
export type ExportedKit = { key: string; kit: string; version: string }
export type ExportOut = { files: Record<string, string>; kits: ExportedKit[] }

const digest = (s: string): string => hex(sha256(utf8(s)))

function kitOf(e: CompanyEntry, keys: Set<string>): { kit: string; part: number; version: string } | null {
  const m = /^co-kit-([a-z][a-z0-9-]{1,21})$/.exec(e.key)
  const v = / \(v((?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5})\.(?:0|[1-9][0-9]{0,5}))\)$/.exec(e.title)
  if (!m || !v) return null
  const tail = /^(.+)-([2-9])$/.exec(m[1])
  if (tail && keys.has(`co-kit-${tail[1]}`)) return { kit: tail[1], part: Number(tail[2]), version: v[1] }
  return { kit: m[1], part: 1, version: v[1] }
}

function yamlScalar(s: string): string {
  return /: | #|:$|^[-?:,[\]{}#&*!|>'"%@`\s]|\s$|[\u0000-\u001f]/.test(s) ? JSON.stringify(s) : s
}

function skillText(e: CompanyEntry): string {
  const lines = ['---', `name: ${e.key}`, `description: ${yamlScalar(e.when)}`, '---', '', `# ${e.title}`, '', e.when, '']
  for (const it of e.items) lines.push(`## ${it.id}`, '', it.text, '')
  return lines.join('\n')
}

export async function exportKits(a: ExportIn, send: Send): Promise<ExportOut> {
  const pub = identityPublic(a.identity)
  const me = a.roster?.members?.find((m) => m.devices.some((d) => d.sig_pk === pub.sig_pk))
  if (!me || me.role !== 'admin' || a.roster.org !== a.org) throw new KitError('not_admin')

  const entries: CompanyEntry[] = []
  for (const v of a.roster.vaults) {
    if (v.kind !== 'brain') continue
    const s = await serveBrain({ org: a.org, vault: v.id, roster: a.roster, identity: a.identity.enc_sk }, send)
    if (s.ok && s.entry.key.startsWith('co-')) entries.push(s.entry)
  }
  entries.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))

  const files: Record<string, string> = {}
  const keys = new Set(entries.map((e) => e.key))
  const kits: ExportedKit[] = []
  const byKit = new Map<string, { kit: string; version: string; parts: [number, string][] }>()
  for (const e of entries) {
    const k = kitOf(e, keys)
    const pack: Record<string, unknown> = {
      v: 1, id: e.key, tier: 'company', version: k ? k.version : e.version, title: e.title, when: e.when, items: e.items,
    }
    if (k) Object.assign(pack, { kit: k.kit, part: k.part })
    const json = JSON.stringify(pack, null, 2) + '\n'
    files[`${e.key}/SKILL.md`] = skillText(e)
    files[`${e.key}/kit.json`] = json
    if (k) {
      kits.push({ key: e.key, kit: k.kit, version: k.version })
      const id = `${k.kit}@${k.version}`
      const row = byKit.get(id) ?? { kit: k.kit, version: k.version, parts: [] }
      row.parts.push([k.part, digest(json)])
      byKit.set(id, row)
    }
  }
  const paths = Object.keys(files).sort()
  files['MANIFEST.txt'] = [
    `roster_seq: ${a.roster.seq}`,
    `time: ${new Date(a.t * 1000).toISOString()}`,
    '',
    ...paths.map((p) => `${digest(files[p])}  ${p}`),
    '',
  ].join('\n')

  const done = [...byKit.values()]
    .sort((x, y) => (x.kit < y.kit ? -1 : x.kit > y.kit ? 1 : compareVersions(x.version, y.version)))
    .map((r) => ({ kit: r.kit, version: r.version, plain: digest(r.parts.sort((p, q) => p[0] - q[0]).map((p) => p[1]).join('\n')) }))
  for (const k of done) await send('/sealed/kit/exported', k)
  return { files, kits }
}
