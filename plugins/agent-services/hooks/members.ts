import { ORG_PAUSED_LINE } from './org'
import { NOTICE_TEXT, PAUSED_LINE } from './svc'
import { COMMAND } from './status'

type Obj = Record<string, any>
type Call = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; body?: unknown; error?: string | null }>
export type MembersDeps = {
  svc: { call: Call }
  ask: ((question: string, options: { options: string[]; header?: string }) => Promise<string>) | null
  canAsk: () => boolean
  byTool: boolean
  validEmail: (s: unknown) => boolean
}

export async function membersCommand(d: MembersDeps, rest: string[]): Promise<string> {
  const sub = (rest[0] ?? '').toLowerCase()
  if (rest.length === 0) return list(d)
  if ((sub === 'add' || sub === 'remove') && rest.length === 2 && d.validEmail(rest[1]!)) return change(d, sub, rest[1]!)
  return usageText()
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function usageText(): string {
  return `Usage: ${COMMAND} members, ${COMMAND} members add <email>, or ${COMMAND} members remove <email>.`
}

function orgName(b: Obj): string {
  return typeof b.org === 'string' && b.org.trim() ? b.org : 'your company'
}

function seatsText(used: unknown, paid: unknown): string {
  const u = typeof used === 'number' ? used : 0
  return typeof paid === 'number' ? `${u} of ${paid} seats used` : `${u} ${u === 1 ? 'seat' : 'seats'} used`
}

function paidOf(b: Obj): number | null {
  return typeof b.seats_paid === 'number' ? b.seats_paid : null
}

function addRemoveTail(): string {
  return `Add or remove: ${COMMAND} members add <email> or ${COMMAND} members remove <email>.`
}

function sentence(code: string, verb: 'list' | 'add' | 'remove', paid: number | null): string {
  switch (code) {
    case 'not_org_admin':
      return "Only your company's admin can manage members."
    case 'no_license':
      return "Your company's license is not valid; ask your agent-services contact."
    case 'not_in_plan':
      return "Your company's plan does not include managing members; ask your agent-services contact."
    case 'rate_limited':
      return 'Too many requests; try again in a minute.'
    case 'day_limit':
      return "Your company reached today's limit for member changes; try again tomorrow."
    case 'auth_failed':
    case 'not_logged_in':
      return PAUSED_LINE
    case 'org_paused':
      return ORG_PAUSED_LINE
    case 'account_locked':
    case 'locked_out':
    case 'clock_skew':
      return NOTICE_TEXT[code]!
    case 'service_off':
      return 'This service is switched off on this computer, so nothing was sent.'
    case 'inactive':
      return `The service is not available to this session right now, so nothing was sent; ask Claude for the agent-services status to see why.`
    case 'upgrade_required':
      return `This plugin version is no longer accepted by the service; update it with ${COMMAND} update.`
  }
  const invalid = code === 'bad_request' || code === 'invalid_body'
  if (verb === 'list') {
    return invalid ? 'Could not list the members: the service refused the request as invalid.'
      : `Could not list the members (${code}). Try again later.`
  }
  const did = verb === 'add' ? 'Not added' : 'Not removed'
  if (invalid) return `${did}: the service refused the request as invalid.`
  if (['timeout', 'connection_failed', 'server_unreachable', 'failed'].includes(code) || /^http_5\d\d$/.test(code)) {
    return `The ${verb === 'add' ? 'addition' : 'removal'} may have gone through, but the service did not confirm it. ` +
      `Run ${COMMAND} members to check before you try again.`
  }
  if (verb === 'add') {
    switch (code) {
      case 'no_free_seat':
        return `${did}: ${paid === null ? 'no seat count is set for your company' : `all ${paid} paid seats are used`}. ` +
          'More seats come from your agent-services contact.'
      case 'already_member':
        return 'Not added: that address is already a member.'
      case 'not_added':
        return 'Not added. If this address should belong to your company, ask your agent-services contact.'
    }
  } else if (code === 'not_removed') {
    return 'Not removed. Only members of your company who are not admins can be removed here; for anything else ask ' +
      'your agent-services contact.'
  }
  return `${did} (${code}). Try again later.`
}

async function list(d: MembersDeps): Promise<string> {
  const r = await d.svc.call('GET', '/org/members')
  if (!r.ok || !isObj(r.body)) return sentence(r.error ?? 'failed', 'list', null)
  const b = r.body
  const lines = [`Members of ${orgName(b)}: ${seatsText(b.seats_used, b.seats_paid)}.`]
  if (b.view === 'totals') {
    lines.push('Member addresses are not shown in the totals view; add and remove still work by address.')
  } else if (Array.isArray(b.members)) {
    for (const m of b.members) {
      if (!isObj(m)) continue
      const n = typeof m.devices === 'number' ? m.devices : 0
      lines.push(`${m.email} (${m.role}, ${n} ${n === 1 ? 'device' : 'devices'})`)
    }
  }
  lines.push(addRemoveTail())
  return lines.join('\n')
}

function refusal(d: MembersDeps, verb: 'add' | 'remove', email: string): string {
  if (d.byTool) {
    return `Nothing was sent: members are changed only when you type ${COMMAND} members ${verb} ${email} yourself in ` +
      'Claude Code.'
  }
  return `Nothing was sent: this session cannot ask you to confirm it. Type ${COMMAND} members ${verb} ${email} yourself ` +
    'in Claude Code.'
}

async function change(d: MembersDeps, verb: 'add' | 'remove', email: string): Promise<string> {
  if (d.byTool || !d.ask || !d.canAsk()) return refusal(d, verb, email)
  const first = await d.svc.call('GET', '/org/members')
  if (!first.ok || !isObj(first.body)) return sentence(first.error ?? 'failed', 'list', null)
  const b = first.body
  const org = orgName(b)
  const used = typeof b.seats_used === 'number' ? b.seats_used : 0
  const paid = paidOf(b)
  if (verb === 'add' && paid === null) return sentence('no_free_seat', 'add', null)
  const seat = `They take one of your ${paid} seats (${used} used)`
  const options = verb === 'add' ? ['Add, notice given', 'Cancel'] : ['Remove', 'Cancel']
  const question = verb === 'add'
    ? `Add ${email} to ${org}? ${seat} and can sign in with a code mailed to that address when they ask for one. ` +
      "Nothing is sent to them now. Confirm that you gave them your company's notice about what the company admin can see."
    : `Remove ${email} from ${org}? They are signed out on every device at once and their seat is freed. Their account ` +
      'and past figures are not deleted.'
  let answer = ''
  try {
    answer = String(await d.ask(question, { options, header: 'Members' })).trim()
  } catch {
    answer = ''
  }
  if (answer !== options[0]) {
    return verb === 'add' ? 'Not added: cancelled. Nothing was sent.' : 'Not removed: cancelled. Nothing was sent.'
  }
  if (verb === 'add') {
    const r = await d.svc.call('POST', '/org/members', { email, notice_given: true })
    if (!r.ok) return sentence(r.error ?? 'failed', 'add', paid)
    const res = isObj(r.body) ? r.body : {}
    return `Added ${email}. ${seatsText(res.seats_used, res.seats_paid)}.`
  }
  const r = await d.svc.call('POST', '/org/members/remove', { email })
  if (!r.ok) return sentence(r.error ?? 'failed', 'remove', paid)
  const res = isObj(r.body) ? r.body : {}
  const n = typeof res.signed_out === 'number' ? res.signed_out : 0
  return `Removed ${email}; signed out on ${n} ${n === 1 ? 'device' : 'devices'}. ${seatsText(res.seats_used, res.seats_paid)}.`
}
