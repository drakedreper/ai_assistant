/**
 * Permission broker: turns a backend's permission_request into an Approval card, remembers which backend request it
 * answers, persists everything through LaneStore, and turns the human's click back into a PermissionDecision.
 *
 * Safety lives here, in code, not in the prompt (ADR 0005):
 *   - a LOCKED tool (finance_move_money) is denied at once, without ever asking, and the attempt is audited;
 *   - a tool that is not in this lane's tool list is denied at once, without asking, and audited;
 *   - everything else becomes a pending approval whose risk comes from the tool's tier and readOnly flag plus simple
 *     command and path heuristics (recursive deletes, force pushes, writes outside the working directory...).
 * Previews are redacted before they are persisted or shown.
 */
import nodePath from 'node:path'
import { STAGE_TOOL_SURFACE, TOOL_SURFACE } from '@ai-assistant/shared'
import type { Approval, AuditEntry, BackendEvent, LaneId, LaneStore, PermissionDecision, ServerEventDraft, ToolBinding, ToolSpec } from '@ai-assistant/shared'
import { errorText, isRecord, oneLine, redactSecrets, safeJson, tierRank, truncate } from './util'

export type PermissionRequestEvent = Extract<BackendEvent, { type: 'permission_request' }>
type Risk = Approval['risk']
type Deny = Extract<PermissionDecision, { behavior: 'deny' }>

export interface BrokerDeps {
  lane: LaneId
  store: Pick<LaneStore, 'saveApproval' | 'setApprovalStatus' | 'audit'>
  /** The tools this lane may use. Anything else that asks is denied without a card. */
  tools: ToolBinding[]
  emit(draft: ServerEventDraft): void
  now(): Date
  newId(prefix: string): string
  /** Working directory; shell-like inputs touching paths outside it raise the risk. */
  cwd: string
  /** The persona's name for card text ("Mira wants to..."). The name is editable, so it is never hard-coded. */
  assistantName?: () => string
}

export type BrokerOutcome =
  | { kind: 'denied'; reason: 'locked' | 'not_allowed'; decision: Deny }
  | { kind: 'pending'; approval: Approval }

export interface PermissionBroker {
  request(ev: PermissionRequestEvent): BrokerOutcome
  /** Apply the human's decision. Undefined when the approval is not pending here (unknown, or already decided). */
  decide(approvalId: string, decision: 'approved' | 'denied'): { requestId: string; decision: PermissionDecision } | undefined
  /** Backend request id to approval id, while pending. */
  approvalFor(requestId: string): string | undefined
  /** Mark one pending approval denied because the backend stopped waiting (timeout, interrupt, turn end). */
  expire(approvalId: string, reason: string): boolean
  /** Expire everything pending. Returns the approval ids. */
  expireAll(reason: string): string[]
  pending(): Approval[]
  /** True for any approval this broker created, decided or not. */
  owns(approvalId: string): boolean
}

// ------------------------------------------------------------------ risk

export interface RiskAssessment {
  level: Risk
  reasons: string[]
}

const HIGH: Array<[RegExp, string]> = [
  [/\brm\s+(?:-[a-z-]+\s+)*-[a-z]*r|\brm\s+.*--recursive/i, 'recursive delete'],
  [/\b(?:rmdir|rd)\s+\/s\b/i, 'recursive delete'],
  [/\bdel\s+(?:\/\w\s+)*\/[sq]\b/i, 'recursive delete'],
  [/\bremove-item\b[^\n]*-recurse/i, 'recursive delete'],
  [/\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/i, 'force push'],
  [/\bgit\s+reset\s+--hard\b/i, 'discards local changes'],
  [/\bgit\s+clean\s+-[a-z]*f/i, 'deletes untracked files'],
  [/\bgit\s+branch\s+-D\b/i, 'deletes a branch'],
  [/\bdrop\s+(?:table|database|schema)\b/i, 'drops data'],
  [/\btruncate\s+table\b/i, 'drops data'],
  [/\bdelete\s+from\s+\w+\s*(?:;|$)/i, 'deletes every row'],
  [/\bformat\s+[a-z]:|\bmkfs\b|\bdd\s+if=/i, 'overwrites a disk'],
  [/\bshutdown\b|\bchmod\s+-R\s+777\b/i, 'system-wide change'],
  [/\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell)\b|\b(?:iwr|invoke-webrequest)\b[^|\n]*\|\s*iex\b/i, 'runs a downloaded script'],
]

const MEDIUM: Array<[RegExp, string]> = [
  [/\bsudo\b|\brunas\b/i, 'runs with elevated rights'],
  [/\bgit\s+push\b/i, 'publishes to a remote'],
  [/\b(?:npm|pnpm|yarn)\s+(?:publish|add|install|i)\b|\bpip\s+install\b/i, 'installs or publishes packages'],
  [/(?:^|[\s/\\])\.env(?:\.\w+)?\b/i, 'touches a settings file that may hold secrets'],
  [/\b(?:chmod|chown)\b/i, 'changes permissions'],
  [/\b(?:curl|wget|invoke-webrequest|iwr)\b/i, 'uses the network'],
  [/(?:^|[^>-])>>?\s*[^\s&|]/, 'writes to a file'],
]

const SECRET_PATHS = /(?:^|[\\/\s"'=])(?:\.env(?:\.[\w-]+)?|\.ssh|id_(?:rsa|ed25519|ecdsa)|\.aws|\.npmrc|\.netrc|credentials(?:\.json)?|\.git-credentials)(?:$|[\\/\s"'])/i

const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'sh', 'cmd'])
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'targetPath', 'notebook_path', 'cwd']
const COMMAND_FIELDS = ['command', 'cmd', 'script']

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** True when `target` is not inside `cwd`. Handles Windows and POSIX styles without assuming the host OS. */
export function isOutside(target: string, cwd: string): boolean {
  const t = target.trim().replace(/^["']|["']$/g, '')
  if (!t) return false
  if (t.startsWith('~')) return true
  const winTarget = isWindowsPath(t)
  const winCwd = isWindowsPath(cwd)
  if (winTarget !== winCwd && (nodePath.posix.isAbsolute(t) || winTarget)) return true
  const mod = winCwd || winTarget ? nodePath.win32 : nodePath.posix
  const abs = mod.isAbsolute(t) ? t : mod.join(cwd, t)
  const rel = mod.relative(cwd, abs)
  return rel.startsWith('..') || mod.isAbsolute(rel)
}

function pathCandidates(text: string): string[] {
  const found = text.match(/(?:(?<!\w)[A-Za-z]:[\\/][^\s"'|&;<>]*|~[\\/][^\s"'|&;<>]*|(?<![\w.:/])\/[^\s"'|&;<>]+|(?:\.\.[\\/])+[^\s"'|&;<>]*)/g)
  return found ?? []
}

/** Risk from the tool's tier and readOnly flag plus command and path heuristics. */
export function assessRiskDetailed(spec: Pick<ToolSpec, 'name' | 'tier' | 'readOnly'>, input: unknown, cwd: string): RiskAssessment {
  const rank = tierRank(spec.tier)
  const reasons: string[] = []
  let level = 0 // 0 low, 1 medium, 2 high
  const raise = (to: number, why: string): void => {
    if (to > level) level = to
    if (!reasons.includes(why)) reasons.push(why)
  }

  const record = isRecord(input) ? input : {}
  const commands: string[] = []
  for (const f of COMMAND_FIELDS) if (typeof record[f] === 'string') commands.push(record[f] as string)
  if (typeof input === 'string' && SHELL_TOOLS.has(spec.name.toLowerCase())) commands.push(input)

  // A shell command is judged by what it does; any other write at T3/T4 is judged by its tier.
  if (!spec.readOnly && rank >= 3 && commands.length === 0) raise(1, rank === 4 ? 'an outward action' : 'changes a protected note')

  for (const cmd of commands) {
    for (const [re, why] of HIGH) if (re.test(cmd)) raise(2, why)
    for (const [re, why] of MEDIUM) if (re.test(cmd)) raise(1, why)
    if (SECRET_PATHS.test(cmd)) raise(2, 'touches a secrets path')
    for (const p of pathCandidates(cmd)) {
      if (SECRET_PATHS.test(p)) raise(2, 'touches a secrets path')
      else if (isOutside(p, cwd)) raise(1, 'touches a path outside the working directory')
    }
  }

  if (!spec.readOnly) {
    for (const f of PATH_FIELDS) {
      const v = record[f]
      if (typeof v !== 'string' || !v) continue
      if (SECRET_PATHS.test(v)) raise(2, 'touches a secrets path')
      else if (isOutside(v, cwd)) raise(1, 'writes outside the working directory')
    }
  }

  return { level: (['low', 'medium', 'high'] as const)[level] ?? 'low', reasons }
}

export const assessRisk = (spec: Pick<ToolSpec, 'name' | 'tier' | 'readOnly'>, input: unknown, cwd: string): Risk => assessRiskDetailed(spec, input, cwd).level

// ------------------------------------------------------------------ cards

const AREA: Record<ToolSpec['server'], Approval['area']> = { brain: 'brain', calendar: 'life', mail: 'life', contacts: 'life', finance: 'money', worklog: 'work', news: 'life', stage: 'brain' }
const SENSITIVE_SERVERS = new Set<ToolSpec['server']>(['mail', 'finance'])

/** Tools whose input is personal text she wrote down (ToolSpec.privateInput): see hasPrivateInput and auditTarget. */
const PRIVATE_INPUT = new Set([...TOOL_SURFACE, ...STAGE_TOOL_SURFACE].filter((s) => s.privateInput).map((s) => s.name))
export const hasPrivateInput = (tool: string): boolean => PRIVATE_INPUT.has(tool)

/**
 * What an audit entry says a tool call was about. Ordinarily the tool and the start of its input (secrets masked). For a
 * tool whose input is personal text it is the tool and at most one fixed word about it, never the text: an audit entry
 * outlives the thing it records, and forgetting a memory must not leave a copy of it in the log.
 */
export function auditTarget(tool: string, input: unknown): string {
  if (hasPrivateInput(tool)) {
    const kind = isRecord(input) && typeof input.kind === 'string' && /^[a-z_]{1,24}$/.test(input.kind) ? ` (${input.kind})` : ''
    return truncate(`${tool}${kind}`, 140)
  }
  return truncate(oneLine(redactSecrets(`${tool} ${safeJson(input)}`)), 140)
}

function approvalKind(tool: string): Approval['kind'] {
  if (tool === 'mail_send' || tool === 'mail_draft_reply') return 'email_draft'
  if (tool === 'calendar_propose_event') return 'calendar_event'
  return 'tool_permission'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function describe(spec: ToolSpec, input: unknown, ev: PermissionRequestEvent, who: string): { title: string; detail: string; preview: string; refId?: string } {
  const i = isRecord(input) ? input : {}
  const clip = (s: string, n = 600) => truncate(redactSecrets(s), n)
  switch (spec.name) {
    case 'mail_send':
      return { title: ev.title ?? 'Send an email', detail: ev.description ?? `${who} wants to send a drafted email. It goes out only if you approve.`, preview: clip(`Draft ${str(i.draftId) || '(unknown)'}`), ...(str(i.draftId) ? { refId: str(i.draftId) } : {}) }
    case 'mail_draft_reply':
      return { title: ev.title ?? 'Draft a reply', detail: ev.description ?? `${who} prepared a draft reply. Sending is a separate approval.`, preview: clip(str(i.body)), ...(str(i.threadId) ? { refId: str(i.threadId) } : {}) }
    case 'calendar_propose_event':
      return { title: ev.title ?? `Add "${truncate(oneLine(str(i.title)), 60)}" to your calendar`, detail: ev.description ?? 'Adds an event to your calendar.', preview: clip(`${str(i.title)} (${str(i.start)} to ${str(i.end)})`) }
    case 'brain_upsert_note':
      return { title: ev.title ?? `Edit note ${truncate(str(i.path), 80)}`, detail: ev.description ?? 'Changes a knowledge or project note. Every change is a git commit you can undo.', preview: clip(str(i.bodyPatch) || safeJson(i.frontmatterPatch ?? {}, 2)) }
    case 'brain_propose':
      return { title: ev.title ?? `Propose a change to ${truncate(str(i.targetPath), 80)}`, detail: ev.description ?? 'Strategy notes change only through proposals you review.', preview: clip(Array.isArray(i.diff) ? i.diff.map(String).join('\n') : str(i.rationale)) }
    case 'worklog_create_task':
      return { title: ev.title ?? `Add a card: ${truncate(oneLine(str(i.title)), 80)}`, detail: ev.description ?? 'Adds a kanban card.', preview: clip(str(i.title)) }
    case 'character_remember':
      // Fixed wording: the backend's own title and description are generated from the input and may quote it. The card shows
      // what she wants to write down (you must see it to decide) and nothing keeps it once you have.
      return { title: 'Remember something about you', detail: `${who} wants to write this down in her memory. You can see and forget everything she remembers in Settings, Stage.`, preview: clip(`${str(i.kind) || 'note'}: ${str(i.text)}`) }
    default: {
      const command = COMMAND_FIELDS.map((f) => str(i[f])).find(Boolean)
      return {
        title: ev.title ?? `${who} wants to use ${spec.name}`,
        detail: ev.description ?? spec.description,
        preview: clip(command ?? oneLine(safeJson(input)), 500),
      }
    }
  }
}

export function createPermissionBroker(deps: BrokerDeps): PermissionBroker {
  const allowed = new Map(deps.tools.map((b) => [b.spec.name, b.spec]))
  const entries = new Map<string, { approval: Approval; requestId: string; tool: string; target: string; sensitive: boolean; privateInput: boolean }>()
  const byRequest = new Map<string, string>()

  const audit = (entry: Omit<AuditEntry, 'id' | 'at'>): void => {
    try {
      deps.store.audit({ at: deps.now().toISOString(), ...entry })
    } catch {
      // An audit failure must never turn into an approval or a crash.
    }
  }

  const finish = (id: string, status: 'approved' | 'denied'): void => {
    const e = entries.get(id)
    if (!e) return
    const decided: Approval = { ...e.approval, status }
    // What she wanted to write down was on the card only while you decided. Nothing keeps it afterwards, here or in storage.
    if (e.privateInput) delete decided.preview
    e.approval = decided
    byRequest.delete(e.requestId)
    try {
      if (e.privateInput) deps.store.saveApproval(decided) // an upsert: the stored row loses its preview
      deps.store.setApprovalStatus(id, status)
    } catch (err) {
      audit({ actor: 'mira', action: 'approval.persist', target: id, outcome: 'blocked', detail: truncate(errorText(err), 120) })
    }
    deps.emit({ type: 'approval.resolved', id, status })
  }

  return {
    request(ev) {
      const known = TOOL_SURFACE.find((s) => s.name === ev.tool)
      const privateInput = hasPrivateInput(ev.tool)
      const sensitive = (known ? SENSITIVE_SERVERS.has(known.server) : false) || privateInput
      const target = auditTarget(ev.tool, ev.input)

      if (known?.locked) {
        audit({ actor: 'mira', action: `tool:${ev.tool}`, target, outcome: 'blocked', detail: 'Locked: this action can never be enabled.', sensitive })
        return { kind: 'denied', reason: 'locked', decision: { behavior: 'deny', message: `${ev.tool} is permanently locked and can never be used. Tell the user plainly that you cannot do this, and offer to explain the numbers instead.` } }
      }
      const spec = allowed.get(ev.tool)
      if (!spec) {
        audit({ actor: 'mira', action: `tool:${ev.tool}`, target, outcome: 'blocked', detail: "Not in this lane's tool list.", sensitive })
        return { kind: 'denied', reason: 'not_allowed', decision: { behavior: 'deny', message: `${ev.tool} is not available to you. Tell the user plainly that you cannot do this.` } }
      }

      // The same backend request twice (a retry) must not create a second card.
      const existingId = byRequest.get(ev.requestId)
      const existing = existingId ? entries.get(existingId) : undefined
      if (existing) return { kind: 'pending', approval: existing.approval }

      const risk = assessRiskDetailed(spec, ev.input, deps.cwd)
      const d = describe(spec, ev.input, ev, deps.assistantName?.().replace(/\s+/g, ' ').trim() || 'The assistant')
      const flag = risk.level !== 'low' && risk.reasons[0] ? ` Flagged ${risk.level} risk: ${risk.reasons.join(', ')}.` : ''
      const approval: Approval = {
        id: deps.newId('ap'),
        kind: approvalKind(spec.name),
        title: truncate(oneLine(redactSecrets(d.title)), 120),
        detail: truncate(oneLine(redactSecrets(d.detail)) + flag, 300),
        requestedAt: deps.now().toISOString(),
        status: 'pending',
        risk: risk.level,
        tier: (['T1', 'T1', 'T2', 'T3', 'T4'] as const)[tierRank(spec.tier)] ?? 'T4',
        ...(d.preview ? { preview: d.preview } : {}),
        ...(privateInput ? { sensitive: true } : {}),
        area: AREA[spec.server],
        ...(d.refId ? { refId: d.refId } : {}),
      }
      entries.set(approval.id, { approval, requestId: ev.requestId, tool: spec.name, target, sensitive, privateInput })
      byRequest.set(ev.requestId, approval.id)
      deps.store.saveApproval(approval)
      deps.emit({ type: 'approval.new', approval })
      return { kind: 'pending', approval }
    },

    decide(approvalId, decision) {
      const e = entries.get(approvalId)
      if (!e || e.approval.status !== 'pending') return undefined
      finish(approvalId, decision)
      audit({ actor: 'you', action: `tool:${e.tool}`, target: e.target, outcome: decision, sensitive: e.sensitive })
      return {
        requestId: e.requestId,
        decision: decision === 'approved' ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user denied this request. Do not retry it; ask what they would like instead.' },
      }
    },

    approvalFor(requestId) {
      return byRequest.get(requestId)
    },

    expire(approvalId, reason) {
      const e = entries.get(approvalId)
      if (!e || e.approval.status !== 'pending') return false
      finish(approvalId, 'denied')
      audit({ actor: 'mira', action: `tool:${e.tool}`, target: e.target, outcome: 'denied', detail: truncate(reason, 120), sensitive: e.sensitive })
      return true
    },

    expireAll(reason) {
      const ids = [...entries.values()].filter((e) => e.approval.status === 'pending').map((e) => e.approval.id)
      for (const id of ids) this.expire(id, reason)
      return ids
    },

    pending() {
      return [...entries.values()].filter((e) => e.approval.status === 'pending').map((e) => e.approval)
    },

    owns(approvalId) {
      return entries.has(approvalId)
    },
  }
}
