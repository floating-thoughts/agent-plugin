import { splitOutsideQuotes } from './cmdguard'
import { vaultMask } from './vault'

type Obj = Record<string, any>

export const ENVGUARD_NOTE =
  'agent-services note: this command was stopped by the secret dump guard. The guard blocks commands that print ' +
  'every environment variable or a whole secret store into the transcript (env, printenv, a bare set, export -p, ' +
  'declare -x, Get-ChildItem env:, [Environment]::GetEnvironmentVariables(), reg query HKCU\\Environment without /v, ' +
  'reading .env files, ~/.agent_secrets or a private SSH key, cmdkey /list), also inside ssh, wsl, cmd /c, bash -c ' +
  'or powershell -Command/-EncodedCommand, because one such listing puts every API key and token into the ' +
  'conversation, where it stays. It matched: {command}\n' +
  'Instead, read one named variable (echo $HTTP_PROXY, $env:HTTPS_PROXY, printenv HTTP_PROXY, reg query ' +
  'HKCU\\Environment /v HTTP_PROXY) or list names only (env | cut -d= -f1, (Get-ChildItem env:).Name, ' +
  '(Get-Item HKCU:\\Environment).GetValueNames()).\n' +
  'If the full listing is truly needed (for example the user asked for it), start the Bash or PowerShell description ' +
  'with "env dump ok: <reason>", or put a comment "# env dump ok: <reason>" in the command; it then runs and its ' +
  'output stays in the transcript.'

const MAX_TEXT = 100000
const MAX_DEPTH = 6

const SEP = /\r?\n|;|&&|\|\||(?<![>&|])&(?![&>])/

function wordsIn(stage: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  for (let i = 0; i < stage.length; i++) {
    const c = stage[i]!
    if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
      continue
    }
    has = true
    if (c === "'") {
      const j = stage.indexOf("'", i + 1)
      if (j < 0) { cur += stage.slice(i + 1); break }
      cur += stage.slice(i + 1, j)
      i = j
    } else if (c === '"') {
      let j = i + 1
      for (; j < stage.length && stage[j] !== '"'; j++) {
        if (stage[j] === '\\' && (stage[j + 1] === '"' || stage[j + 1] === '\\')) j++
        cur += stage[j]!
      }
      i = j
    } else if (c === '\\' && (stage[i + 1] === '"' || stage[i + 1] === "'")) {
      cur += stage[i + 1]!
      i++
    } else {
      cur += c
    }
  }
  if (has) out.push(cur)
  return out
}

const base = (w: string): string => (w.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')
const isOpt = (w: string): boolean => /^-/.test(w)

function decode64(text: string): string {
  try {
    const raw = atob(String(text).replace(/\s+/g, ''))
    let s = ''
    for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8))
    return s
  } catch {
    return ''
  }
}

function envKey(raw: string): boolean {
  const k = raw.trim().replace(/^registry::/i, '').replace(/^(hkcu|hklm):\\?/i, '$1\\').replace(/[\\/]+/g, '\\')
    .replace(/\\$/, '').replace(/\s+/g, ' ')
  return /^(?:hkcu|hkey_current_user)\\environment$/i.test(k) ||
    /^(?:hklm|hkey_local_machine)\\system\\(?:currentcontrolset|controlset\d+)\\control\\session manager\\environment$/i.test(k)
}

function secretPath(p: string): boolean {
  const parts = p.split(/[\\/]+/)
  const b = (parts[parts.length - 1] ?? '').toLowerCase()
  if (parts.some((x) => x.toLowerCase() === '.agent_secrets')) return true
  if ((/^\.env(?:\..+)?$/.test(b) || /.\.env$/.test(b)) && !/\.(?:example|sample|template|dist|defaults?)$/.test(b)) return true
  return /^id_(?:rsa|ed25519|ecdsa|dsa)(?:_[\w-]*)?$/.test(b)
}

const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'more', 'less', 'head', 'tail', 'bat', 'batcat', 'tac', 'nl',
  'xxd', 'od', 'hexdump', 'base64', 'strings', 'format-hex'])

function namesOnly(stage: string): boolean {
  const t = stage.replace(/["']/g, '').trim().toLowerCase()
  if (/^cut\b/.test(t) && /-d\s*=/.test(t) && /-f\s*1(?![\d,-])/.test(t)) return true
  if (/^sed\b.*\bs([/|#,:])=\.\*\1\1/.test(t)) return true
  if (/^awk\b.*-f\s*=.*print\s+\$1(?!\d)/.test(t) && !/\$[02-9]/.test(t)) return true
  if (/^(?:select-object|select)\s+(?:-(?:expandproperty|property|expand|exp|prop)\s+)?(?:name|key|pschildname)\s*$/.test(t)) return true
  if (/^(?:foreach-object|%|foreach)\s+(?:\{\s*\$_\.(?:name|key)\s*\}|name|key)\s*$/.test(t)) return true
  return /^(?:format-table|ft|format-list|fl|format-wide|fw)\s+(?:-property\s+)?(?:name|key)\s*$/.test(t)
}

function lineDump(line: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null
  let text = line.slice(0, MAX_TEXT)
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (s: string, _q: string, _w: string, _h: string, at: number, all: string) =>
      /\b(?:(?:ba|da|z|k)?sh|pwsh|powershell|ssh|wsl|cmd)\b/i.test(all.slice(all.lastIndexOf('\n', at - 1) + 1, at) + _h) ? s : '<<HEREDOC')
    .replace(/@(['"])[ \t]*\r?\n[\s\S]*?\r?\n\1@/g, "'Q'")
    .replace(/"[^"]*"/g, (s) => (s.includes('\n') && !/\$\(|`/.test(s) ? '"Q"' : s))
    .replace(/((?:^|\s)(?:-m|--message)(?:\s+|=))'[^']*'/g, (s, head: string) => (s.includes('\n') ? `${head}'Q'` : s))
  const inner: string[] = []
  for (let k = 0; k < 50; k++) {
    const m = /\$\(([^()]*)\)/.exec(text)
    if (!m) break
    inner.push(m[1]!)
    text = `${text.slice(0, m.index)}SUB${text.slice(m.index + m[0].length)}`
  }
  for (const m of text.matchAll(/`([^`\n]+)`/g)) inner.push(m[1]!)
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) inner.push(m[1]!)
  for (const s of inner) {
    const hit = lineDump(s, depth + 1)
    if (hit) return hit
  }
  for (const command of splitOutsideQuotes(text, SEP)) {
    const stages = splitOutsideQuotes(command, /\|/)
    for (let i = 0; i < stages.length; i++) {
      const hit = stageDump(stages[i]!, depth)
      if (hit && !stages.slice(i + 1).some(namesOnly)) return hit
    }
  }
  return null
}

const NAME_MEMBERS = /^(?:name|key|keys|pschildname|property|getvaluenames|count)$/i

function stageDump(stage: string, depth: number): string | null {
  let s = stage.replace(/(^|\s)#[^'"]*$/, '$1').trim().replace(/^\$[\w:]+\s*=\s*/, '')
  const member = /^\(([\s\S]*)\)\s*\.\s*(\w+)\s*(?:\(\s*\))?\s*$/.exec(s)
  if (member) {
    if (NAME_MEMBERS.test(member[2]!)) return null
    s = member[1]!
  } else {
    const wrapped = /^\(([\s\S]*)\)\s*$/.exec(s)
    if (wrapped) s = wrapped[1]!
  }
  if (/\[(?:system\.)?environment\]::getenvironmentvariables\s*\((?:[^()]|\([^()]*\))*\)(?!\s*\.\s*(?:keys|count)\b)/i.test(s)) {
    return '[Environment]::GetEnvironmentVariables()'
  }
  let w = wordsIn(s)
  for (;;) {
    if (!w.length) return null
    const h = w[0]!.toLowerCase()
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) || /^(?:&|time|nohup|command|exec|call|doas|nice)$/.test(h)) {
      w = w.slice(1)
    } else if (base(h) === 'sudo') {
      let i = 1
      while (i < w.length && isOpt(w[i]!)) i += /^-[ugpCDhrtU]$/.test(w[i]!) ? 2 : 1
      w = w.slice(i)
    } else break
  }
  const quote = s.length > 160 ? `${s.slice(0, 160)}...` : s
  const prog = base(w[0]!)
  const args = w.slice(1)
  const low = args.map((a) => a.toLowerCase())
  const rest = (i: number): string | null => (i < w.length ? lineDump(w.slice(i).join(' '), depth + 1) : null)

  if (prog === 'ssh') {
    let i = 1
    while (i < w.length && isOpt(w[i]!)) i += /^-[A-Za-z]*[BbcDEeFIiJLlmOoPpQRSWw]$/.test(w[i]!) ? 2 : 1
    return rest(i + 1)
  }
  if (prog === 'wsl') {
    let i = 1
    while (i < w.length && isOpt(w[i]!)) {
      if (/^(?:--|-e|--exec)$/i.test(w[i]!)) { i++; break }
      i += /^(?:-d|--distribution|-u|--user|--cd|--shell-type|--distribution-id)$/i.test(w[i]!) ? 2 : 1
    }
    return rest(i)
  }
  if (prog === 'cmd') {
    const i = low.findIndex((a) => /^\/[ck]$/.test(a))
    return i >= 0 ? rest(i + 2) : null
  }
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(prog)) {
    for (let i = 1; i < w.length; i++) {
      if (/^-[a-z]*c[a-z]*$/i.test(w[i]!)) return i + 1 < w.length ? lineDump(w[i + 1]!, depth + 1) : null
      if (!isOpt(w[i]!)) return null
    }
    return null
  }
  if (prog === 'powershell' || prog === 'pwsh') {
    for (let i = 1; i < w.length; i++) {
      const a = w[i]!.toLowerCase()
      if (a === '-c' || a === '/c' || (a.startsWith('-com') && '-command'.startsWith(a))) return rest(i + 1)
      if (['-e', '-ec', '-en', '-enc'].includes(a) || (a.length >= 4 && '-encodedcommand'.startsWith(a))) {
        return i + 1 < w.length ? lineDump(decode64(w[i + 1]!), depth + 1) : null
      }
      if (a === '-f' || a.startsWith('-fi')) return null
      if (!isOpt(a)) return rest(i)
      if (/^-(?:ex|ep|w|o|in|if|ps|v|config|settings|custom|encodeda)/.test(a)) i++
    }
    return null
  }
  if (prog === 'iex' || prog === 'invoke-expression') return rest(1)
  if (prog === 'env') {
    let i = 1
    let clean = false
    while (i < w.length) {
      const a = w[i]!
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i++
      else if (a === '-' || /^(?:-i|--ignore-environment)$/.test(a)) { clean = true; i++ }
      else if (/^(?:-u|--unset|-C|--chdir)$/.test(a)) i += 2
      else if (/^(?:-S|--split-string)$/.test(a)) return i + 1 < w.length ? lineDump(w.slice(i + 1).join(' '), depth + 1) : null
      else if (isOpt(a)) i++
      else break
    }
    if (i >= w.length) return clean ? null : quote
    return rest(i)
  }

  const names = args.filter((a) => !isOpt(a) && !/^\//.test(a))
  if (prog === 'reg') {
    if (low[0] !== 'query') return null
    const key = args.slice(1).filter((a) => !/^[/-]/.test(a)).join(' ')
    return envKey(key) && !low.some((a) => /^[/-]ve?$/.test(a)) ? quote : null
  }
  if (prog === 'get-itemproperty' || prog === 'gp') {
    return envKey(names.join(' ')) && !low.some((a) => /^-n(?:a(?:me?)?)?$/.test(a)) ? quote : null
  }
  if (prog === 'set') return args.length === 0 ? quote : null
  if (prog === 'printenv') return args.every(isOpt) ? quote : null
  if (prog === 'export') return args.every(isOpt) ? quote : null
  if (prog === 'declare' || prog === 'typeset') return args.every(isOpt) && (args.length === 0 || args.some((a) => /^-\w*[xp]/.test(a))) ? quote : null
  if (/^(?:get-childitem|gci|ls|dir|get-item|gi)$/.test(prog)) {
    const drive = args.some((a) => {
      const m = /^env:[\\/]*(.*)$/i.exec(a)
      return m !== null && (m[1] === '' || /[*?[]/.test(m[1]!))
    })
    if (drive && !(prog !== 'get-item' && prog !== 'gi' && low.includes('-name'))) return quote
    if ((prog === 'get-item' || prog === 'gi') && envKey(names.join(' '))) return quote
    return null
  }
  if (READERS.has(prog)) return args.some((a) => !isOpt(a) && secretPath(a)) ? quote : null
  if (prog === 'cmdkey') return low.some((a) => a.startsWith('/list')) ? quote : null
  return null
}

function skipped(command: string, description: unknown): boolean {
  if (typeof description === 'string' && /^[\s>*_`"']*env dump ok\s*:[ \t]*\S/i.test(description)) return true
  return /(?:^|[\s;&|])(?:#|rem\s|::)[ \t]*env dump ok\s*:[ \t]*\S/im.test(command)
}

export function envDump(command: unknown, description?: unknown): string | null {
  try {
    const text = typeof command === 'string' ? command : ''
    if (text.trim() === '' || skipped(text, description)) return null
    return lineDump(text, 0)
  } catch {
    return null
  }
}

export function envguardDeny(e: Obj | null | undefined): string | null {
  try {
    if (!e || (e.tool !== 'Bash' && e.tool !== 'PowerShell')) return null
    const hit = envDump(e.command, e.description)
    return hit === null ? null : ENVGUARD_NOTE.split('{command}').join(vaultMask(hit))
  } catch {
    return null
  }
}
