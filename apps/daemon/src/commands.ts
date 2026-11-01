import type { ChatMessage, Emotion, Persona, Task, TaskColumn } from '@ai-assistant/shared'
import { buildSnapshot } from '@ai-assistant/shared/fixtures'
import { HttpError, type DaemonContext } from './context'
import { KV, type ProposalDecisions, type TrustCounts } from './snapshot'
import { redactText } from './store/redact'

export type DecisionInput = 'approved' | 'denied' | 'rejected'

export interface TaskPatch {
  column?: TaskColumn
  title?: string
  description?: string
  priority?: Task['priority']
}

/** Which trust rule an approval of this kind counts towards. */
const TRUST_RULE_BY_KIND: Record<string, string | undefined> = {
  tool_permission: 'tr-agent',
  email_draft: 'tr-send',
  calendar_event: 'tr-cal',
}

/**
 * Every state-changing operation behind the REST API. Each one validates, persists, writes an audit entry and
 * publishes the matching ServerEvent. Semantics follow apps/web/src/api/fixtureClient.ts.
 */
export class Commands {
  /** Set by the composition root: the stage stops talking when the user interrupts (barge-in). */
  onInterrupt: (() => void) | undefined

  constructor(private readonly ctx: DaemonContext) {}

  // ---------------------------------------------------------------- helpers

  private nowIso(): string {
    return this.ctx.now().toISOString()
  }

  private audit(entry: { actor?: 'you' | 'mira' | 'agent' | 'job'; action: string; target: string; outcome: 'approved' | 'denied' | 'auto' | 'blocked'; detail?: string; sentToCloud?: string; sensitive?: boolean }): void {
    this.ctx.store.insertAudit({
      id: this.ctx.newId('au'),
      at: this.nowIso(),
      actor: entry.actor ?? 'you',
      action: entry.action,
      target: redactText(entry.target, 160),
      outcome: entry.outcome,
      ...(entry.detail ? { detail: redactText(entry.detail, 200) } : {}),
      ...(entry.sentToCloud ? { sentToCloud: entry.sentToCloud } : {}),
      ...(entry.sensitive ? { sensitive: true } : {}),
    })
  }

  publishSettings(): void {
    this.ctx.bus.publish({ type: 'settings.update', settings: this.ctx.snapshots.settings() })
  }

  /** Mira speaks unprompted (used after decisions that are fixture-backed). */
  private say(text: string, emotion: Emotion): void {
    const msg: ChatMessage = {
      id: this.ctx.newId('a'),
      role: 'assistant',
      createdAt: this.nowIso(),
      modality: 'text',
      parts: [{ type: 'text', text, emotion }],
    }
    this.ctx.store.upsertChat(msg)
    this.ctx.bus.publish({ type: 'chat.message', message: structuredClone(msg) })
    this.ctx.bus.publish({ type: 'avatar', event: { type: 'expression', emotion, intensity: 0.8 } })
  }

  private bumpTrust(kind: string, status: 'approved' | 'denied'): void {
    const ruleId = TRUST_RULE_BY_KIND[kind]
    if (!ruleId) return
    const counts = this.ctx.store.kvGet<TrustCounts>(KV.trustCounts) ?? {}
    const c = counts[ruleId] ?? { approvals: 0, rejections: 0 }
    if (status === 'approved') c.approvals++
    else c.rejections++
    counts[ruleId] = c
    this.ctx.store.kvSet(KV.trustCounts, counts, this.nowIso())
  }

  // ---------------------------------------------------------------- chat

  async sendChat(input: { text: string; modality: 'text' | 'voice' }): Promise<void> {
    const { lane, config } = this.ctx
    const st = lane.status()
    if (st.state === 'stopped' || st.state === 'error') {
      throw new HttpError(503, 'lane_unavailable', st.error ? `The chat lane is unavailable: ${redactText(st.error, 200)}` : 'The chat lane is unavailable')
    }
    this.audit({
      action: 'Sent chat message',
      target: 'Secretary lane',
      outcome: 'auto',
      detail: `${input.text.length} chars, ${input.modality}`,
      ...(config.backend === 'sdk' ? { sentToCloud: `Chat text (${input.text.length} chars) to Claude` } : {}),
    })
    try {
      await lane.send({ text: input.text, modality: input.modality })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      this.ctx.log.warn('lane.send failed', { error: message })
      throw new HttpError(502, 'lane_error', `The chat lane could not take that message: ${redactText(message, 200)}`)
    }
  }

  async interruptChat(): Promise<void> {
    try {
      this.onInterrupt?.()
    } catch {
      /* the stage must never get in the way of an interrupt */
    }
    try {
      await this.ctx.lane.interrupt()
    } catch (err) {
      throw new HttpError(502, 'lane_error', `Interrupt failed: ${redactText(err instanceof Error ? err.message : 'unknown error', 200)}`)
    }
    this.audit({ action: 'Interrupted the reply', target: 'Secretary lane', outcome: 'auto' })
  }

  // ---------------------------------------------------------------- approvals

  decideApproval(id: string, decision: DecisionInput): { id: string; status: 'approved' | 'denied' } {
    const { store, bus, lane } = this.ctx
    const row = store.getApproval(id)
    if (!row) throw new HttpError(404, 'not_found', 'No such approval')
    const { approval, origin } = row
    if (approval.status !== 'pending') throw new HttpError(409, 'already_resolved', `This approval is already ${approval.status}`)
    const status: 'approved' | 'denied' = decision === 'approved' ? 'approved' : 'denied'

    if (origin === 'hook') {
      throw new HttpError(
        409,
        'not_answerable_here',
        'This permission request comes from a Claude Code session the daemon does not own. Hooks are non-blocking, so the request can only be answered in that terminal.',
      )
    }

    if (origin === 'lane') {
      const before = bus.latestSeq
      let handled: boolean
      try {
        handled = lane.decideApproval(id, status)
      } catch (err) {
        throw new HttpError(502, 'lane_error', `The chat lane could not apply that decision: ${redactText(err instanceof Error ? err.message : 'unknown error', 200)}`)
      }
      if (!handled) {
        // The turn that asked is gone (daemon restart or interrupt). Close the card so the queue does not keep a dead item.
        store.setApprovalStatus(id, 'denied', this.nowIso())
        if (approval.sensitive) store.upsertApproval({ ...approval, status: 'denied', preview: undefined }, 'lane') // no copy of private text stays behind
        bus.publish({ type: 'approval.resolved', id, status: 'denied' })
        throw new HttpError(409, 'stale_approval', 'That request belongs to a Claude turn that is no longer running, so it was closed as denied')
      }
      store.setApprovalStatus(id, status, this.nowIso())
      // The lane normally announces the resolution itself; make sure the UI hears about it exactly once from us if it did not.
      const announced = bus.eventsAfter(before).some((e) => e.type === 'approval.resolved' && e.id === id)
      if (!announced) bus.publish({ type: 'approval.resolved', id, status })
    } else {
      this.resolveLocalApproval(approval.id, approval.kind, approval.sessionId, approval.refId, status)
    }

    this.bumpTrust(approval.kind, status)
    this.audit({
      action: status === 'approved' ? `Approved ${approval.kind.replace(/_/g, ' ')}` : `Denied ${approval.kind.replace(/_/g, ' ')}`,
      target: approval.title,
      outcome: status,
      ...(origin === 'lane' && this.ctx.config.backend === 'sdk' ? { detail: 'Decision returned to the Claude session' } : {}),
    })
    this.publishSettings()
    return { id, status }
  }

  /** Fixture-backed approvals (demo data, proposals): behaves like FixtureClient.decideApproval. */
  private resolveLocalApproval(id: string, kind: string, sessionId: string | undefined, refId: string | undefined, status: 'approved' | 'denied'): void {
    const { store, bus, projection } = this.ctx
    store.setApprovalStatus(id, status, this.nowIso())
    bus.publish({ type: 'approval.resolved', id, status })
    if (sessionId) {
      const s = projection.getSession(sessionId)
      if (s && s.status === 'blocked_permission') projection.patchSession(sessionId, { status: status === 'approved' ? 'running' : 'waiting_input' })
    }
    if (kind === 'brain_proposal' && refId) this.applyProposalDecision(refId, status === 'approved' ? 'approved' : 'rejected', false)
    this.say(
      status === 'approved' ? (kind === 'email_draft' ? 'Okay, marked as approved. Real sending arrives with the mail connector.' : 'Done. I noted your approval.') : 'Denied. I noted that.',
      status === 'approved' ? 'happy' : 'neutral',
    )
  }

  // ---------------------------------------------------------------- proposals (fixture-backed until the real vault, Phase 2)

  decideProposal(id: string, decision: DecisionInput): { id: string; status: 'approved' | 'rejected' } {
    const status = decision === 'approved' ? 'approved' : 'rejected'
    const proposal = this.ctx.snapshots.proposals().find((p) => p.id === id)
    if (!proposal) throw new HttpError(404, 'not_found', 'No such proposal')
    if (proposal.status !== 'pending') throw new HttpError(409, 'already_resolved', `This proposal is already ${proposal.status}`)
    this.applyProposalDecision(id, status, true)
    this.audit({ action: status === 'approved' ? 'Approved proposal' : 'Rejected proposal', target: proposal.targetPath, outcome: status === 'approved' ? 'approved' : 'denied', detail: 'Mock proposal: no vault write happened' })
    this.publishSettings()
    return { id, status }
  }

  private applyProposalDecision(id: string, status: 'approved' | 'rejected', resolveLinked: boolean): void {
    const { store, bus } = this.ctx
    const decidedAt = this.nowIso()
    const decisions = store.kvGet<ProposalDecisions>(KV.proposals) ?? {}
    decisions[id] = { status, decidedAt }
    store.kvSet(KV.proposals, decisions, decidedAt)
    const proposal = this.ctx.snapshots.proposals().find((p) => p.id === id)
    if (proposal) bus.publish({ type: 'proposal.update', proposal })
    if (resolveLinked) {
      for (const ap of store.pendingApprovalsByRef(id)) {
        const linked: 'approved' | 'denied' = status === 'approved' ? 'approved' : 'denied'
        store.setApprovalStatus(ap.id, linked, decidedAt)
        bus.publish({ type: 'approval.resolved', id: ap.id, status: linked })
      }
      this.say(
        status === 'approved'
          ? 'Marked as approved. The real vault arrives in Phase 2, so nothing was written to your notes yet.'
          : 'Rejected. I will not bring that wording back unless you ask.',
        status === 'approved' ? 'happy' : 'neutral',
      )
    }
  }

  // ---------------------------------------------------------------- tasks

  listTasks(): Task[] {
    return this.ctx.store.listTasks()
  }

  createTask(input: { title: string; projectId?: string | undefined; column?: TaskColumn | undefined }): Task {
    const { store, bus } = this.ctx
    if (input.projectId && !this.ctx.snapshots.projects().some((p) => p.id === input.projectId)) {
      throw new HttpError(400, 'unknown_project', 'projectId does not match any project')
    }
    const task: Task = {
      id: this.ctx.newId('t'),
      title: input.title.trim(),
      column: input.column ?? 'todo',
      priority: 'medium',
      sessionIds: [],
      source: 'manual',
      ...(input.projectId ? { projectId: input.projectId } : {}),
    }
    store.insertTask(task, this.nowIso())
    bus.publish({ type: 'task.update', task: structuredClone(task) })
    this.audit({ action: 'Created task', target: task.title, outcome: 'auto' })
    return task
  }

  patchTask(id: string, patch: TaskPatch): Task {
    const { store, bus } = this.ctx
    const task = store.getTask(id)
    if (!task) throw new HttpError(404, 'not_found', 'No such task')
    const next: Task = { ...task }
    if (patch.column) next.column = patch.column
    if (patch.title !== undefined) next.title = patch.title.trim()
    if (patch.description !== undefined) next.description = patch.description
    if (patch.priority) next.priority = patch.priority
    store.updateTask(next, this.nowIso())
    bus.publish({ type: 'task.update', task: structuredClone(next) })
    this.audit({ action: patch.column && patch.column !== task.column ? `Moved task to ${patch.column}` : 'Edited task', target: next.title, outcome: 'auto' })
    return next
  }

  deleteTask(id: string): void {
    const { store } = this.ctx
    const task = store.getTask(id)
    if (!task) throw new HttpError(404, 'not_found', 'No such task')
    store.deleteTask(id)
    this.audit({ action: 'Deleted task', target: task.title, outcome: 'auto' })
    this.ctx.announceReset()
  }

  // ---------------------------------------------------------------- settings

  setTrustMode(ruleId: string, mode: 'ask' | 'auto'): void {
    const fx = buildSnapshot(this.ctx.now()).settings.trustRules.find((r) => r.id === ruleId)
    if (!fx) throw new HttpError(404, 'not_found', 'No such trust rule')
    if (fx.locked) throw new HttpError(409, 'locked', fx.lockReason ?? 'This rule is locked and can never be promoted')
    const modes = this.ctx.store.kvGet<Record<string, 'ask' | 'auto'>>(KV.trustModes) ?? {}
    modes[ruleId] = mode
    this.ctx.store.kvSet(KV.trustModes, modes, this.nowIso())
    this.audit({ action: `Set "${fx.action}" to ${mode}`, target: ruleId, outcome: 'auto' })
    this.publishSettings()
  }

  setClaudeMode(mode: 'api-key' | 'local-login'): void {
    this.ctx.store.kvSet(KV.claudeMode, mode, this.nowIso())
    this.audit({ action: `Set Claude connection to ${mode}`, target: 'Settings', outcome: 'auto', detail: 'Takes effect for the next lane session (restart the daemon)' })
    this.publishSettings()
  }

  setGuestMode(on: boolean): void {
    this.ctx.store.kvSet(KV.guest, on, this.nowIso())
    this.audit({ action: on ? 'Turned Guest mode on' : 'Turned Guest mode off', target: 'Settings', outcome: 'auto' })
    this.publishSettings()
  }

  setWebcam(on: boolean): void {
    this.ctx.store.kvSet(KV.webcam, on, this.nowIso())
    this.audit({ action: on ? 'Allowed the webcam' : 'Turned the webcam off', target: 'Settings', outcome: 'auto', sensitive: true })
    this.publishSettings()
  }

  patchPersona(patch: Partial<Persona>): Persona {
    const current = this.ctx.snapshots.persona()
    const merged = { ...current, ...patch } as Persona
    this.ctx.store.kvSet(KV.persona, merged, this.nowIso())
    this.audit({ action: 'Edited persona', target: Object.keys(patch).join(', ') || 'persona', outcome: 'auto', detail: 'Applied by you from Settings' })
    this.publishSettings()
    return merged
  }

  // ---------------------------------------------------------------- learned facts

  forgetFact(id: string): void {
    const { store, bus } = this.ctx
    const all = buildSnapshot(this.ctx.now()).learned
    const forgotten = store.kvGet<string[]>(KV.forgotten) ?? []
    if (!all.some((f) => f.id === id) || forgotten.includes(id)) throw new HttpError(404, 'not_found', 'No such learned fact')
    forgotten.push(id)
    store.kvSet(KV.forgotten, forgotten, this.nowIso())
    this.audit({ action: 'Forgot a learned fact', target: id, outcome: 'auto' })
    bus.publish({ type: 'learned.update', learned: this.ctx.snapshots.learned() })
  }
}
