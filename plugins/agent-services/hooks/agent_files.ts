import type { EngineInterface } from 'claude-code'

export const PLUGIN_FILES: readonly string[] = [
  'jobs.json', 'evidence.json', 'audit*.jsonl', 'task-state.json', 'task-state.md', 'handover.md', '*.bad-*',
  'memory-facts.json',
]

const doneKeys = new Set<string>()

function globRx(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
}

export function isPluginPath(path: string): boolean {
  const m = /(?:^|\/)\.agent\/([^/]+)$/.exec(String(path).replace(/\\/g, '/'))
  return m !== null && PLUGIN_FILES.some((glob) => globRx(glob).test(m[1]!))
}

export async function ensureAgentIgnore($: EngineInterface, root: string): Promise<void> {
  try {
    const dir = String(root).replace(/[\\/]+$/, '')
    let session = ''
    try {
      session = String((await $.session.id()) ?? '')
    } catch {}
    const key = `${session}\u0000${dir}`
    if (doneKeys.has(key)) return
    const agent = `${dir}/.agent`
    if ((await $.fs.exists(agent)) !== true) return
    const names = ((await $.fs.list(agent)) as any[]).map((e) => String(e?.name))
    const file = `${agent}/.gitignore`
    if (names.includes('.gitignore') || (await $.fs.exists(file)) !== false) {
      doneKeys.add(key)
      return
    }
    const text = ['# agent-services: the plugin\'s own files in this folder (kept out of git and of snapshots).', ...PLUGIN_FILES, ''].join('\n')
    await $.fs.write(file, text)
    doneKeys.add(key)
  } catch {}
}
