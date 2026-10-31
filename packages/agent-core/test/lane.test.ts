import { describe, expect, it } from 'vitest'
import type { AgentBackend, ChatMessage, OpenSessionOptions } from '@ai-assistant/shared'
import { createFakeBackend, BackendError, buildStablePrompt, createSecretaryLane } from '../src'
import { ManualBackend, MemoryStore, NOW, TAG_RE, fakeTimers, makeHarness, trace, turnOf, until, visibleChatText } from './helpers'

const lastAssistant = (store: MemoryStore): ChatMessage => store.messages().filter((m) => m.role === 'assistant').at(-1)!
const textParts = (m: ChatMessage) => m.parts.filter((p) => p.type === 'text') as Array<{ type: 'text'; text: string; emotion?: string }>

/** Run one user turn to the end on a lane that uses the fake backend. */
async function ask(h: ReturnType<typeof makeHarness>, text: string, modality: 'text' | 'voice' = 'text') {
  await h.lane.send(turnOf(text, modality))
  await h.lane.whenIdle()
}

describe('a normal reply', () => {
  it('emits the events in the order the UI relies on', async () => {
    const h = makeHarness()
    await h.lane.start()
    await ask(h, 'hello')
    const t = trace(h.emitted)

    expect(t[0]).toBe('chat.message:user')
    expect(t[1]).toBe('avatar:pose:thinking')
    expect(t.slice(-2)).toEqual(['chat.done', 'avatar:pose:idle'])
    // the assistant message exists before any delta
    expect(t.indexOf('chat.message:assistant')).toBeGreaterThan(1)
    expect(t.indexOf('chat.message:assistant')).toBeLessThan(t.indexOf('chat.delta'))
    // an expression precedes the first text of each sentence group, and speaking starts before the first speak
    expect(t.indexOf('avatar:expression:happy')).toBeLessThan(t.indexOf('chat.message:assistant'))
    expect(t.indexOf('avatar:pose:speaking')).toBeLessThan(t.indexOf('avatar:speak:happy'))
    expect(t.filter((x) => x === 'avatar:pose:speaking')).toHaveLength(1)
    expect(t.filter((x) => x === 'chat.done')).toHaveLength(1)
  })

  it('builds one assistant message with a text part per tagged sentence, tags stripped', async () => {
    const h = makeHarness()
    await ask(h, 'hello')
    const m = lastAssistant(h.store)
    expect(m.role).toBe('assistant')
    const parts = textParts(m)
    expect(parts.map((p) => p.emotion)).toEqual(['happy', 'relaxed', 'neutral'])
    expect(parts[0]?.text).toBe('Good morning!')
    expect(parts.map((p) => p.text).join(' ')).not.toMatch(/\[/)
  })

  it('the live events reproduce the stored message exactly (chat.message replaces, chat.delta appends)', async () => {
    const h = makeHarness({ fake: { chunkSize: 3 } })
    await ask(h, 'hello')
    let live: ChatMessage | undefined
    for (const e of h.emitted) {
      if (e.type === 'chat.message' && e.message.role === 'assistant') live = structuredClone(e.message)
      if (e.type === 'chat.delta' && live) {
        const last = live.parts.at(-1)
        expect(last?.type).toBe('text')
        if (last?.type === 'text') last.text += e.text
      }
    }
    expect(live).toEqual(lastAssistant(h.store))
  })

  it('speaks each finished sentence, with its emotion and without its tag', async () => {
    const h = makeHarness()
    await ask(h, 'hello')
    const speaks = h.avatar().filter((e) => e.type === 'speak')
    expect(speaks.map((s) => (s.type === 'speak' ? s.text : ''))).toEqual(['Good morning!', 'I am running in offline demo mode, so I only know a few tricks.', 'Ask about your calendar, what needs you, your notes or your runway.'])
    expect(speaks.map((s) => (s.type === 'speak' ? s.emotion : ''))).toEqual(['happy', 'relaxed', 'neutral'])
  })

  it('persists the user message, the assistant message and every change to it', async () => {
    const h = makeHarness()
    await ask(h, 'hello')
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(h.store.messages()[0]?.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(h.store.upserts).toBeGreaterThan(5) // not just the final state
  })

  it('records the voice modality of the user message and tells the model the message was spoken', async () => {
    const h = makeHarness({ backend: new ManualBackend() })
    await h.lane.start()
    const mb = h.backend as unknown as ManualBackend
    await h.lane.send(turnOf('turn on the lights', 'voice'))
    expect(h.store.messages()[0]).toMatchObject({ role: 'user', modality: 'voice' })
    expect(mb.last.sent[0]?.context).toMatch(/spoken aloud/)
  })

  it('never lets a raw tag reach the UI or the store, however the stream is chopped', async () => {
    for (const chunkSize of [1, 2, 3, 5, 8, 50]) {
      const h = makeHarness({ fake: { chunkSize } })
      await ask(h, 'hello')
      await ask(h, "what's on my calendar today and what needs me")
      for (const text of visibleChatText(h)) expect(text, `chunkSize ${chunkSize}`).not.toMatch(TAG_RE)
    }
  })

  it('goes back to ready, with the cost recorded', async () => {
    const h = makeHarness({ fake: { costPerTurnUsd: 0.5 } })
    await ask(h, 'hello')
    expect(h.lane.status().state).toBe('ready')
    expect(h.budget.status().lanes.find((l) => l.lane === 'secretary')?.spentTodayUsd).toBe(0.5)
    await ask(h, 'thanks')
    expect(h.budget.status().globalSpentTodayUsd).toBe(1)
  })
})

describe('tag handling on a hand-driven stream', () => {
  async function driven() {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('hi'))
    return { h, mb, s: mb.last }
  }

  it('reassembles a tag split across deltas ("[ha" then "ppy] Hi")', async () => {
    const { h, s } = await driven()
    s.push({ type: 'text_delta', text: '[ha' }, { type: 'text_delta', text: 'ppy] Hi' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(textParts(lastAssistant(h.store))).toEqual([{ type: 'text', text: 'Hi', emotion: 'happy' }])
    expect(h.avatar()).toContainEqual({ type: 'expression', emotion: 'happy', intensity: 0.85 })
    expect(h.avatar()).toContainEqual({ type: 'speak', text: 'Hi', emotion: 'happy' })
  })

  it('an unknown tag at the start of a sentence is stripped and neutral; a literal bracket passes through', async () => {
    const { h, s } = await driven()
    s.push({ type: 'text_delta', text: '[excited] Hello! See [1] for details.' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(textParts(lastAssistant(h.store))).toEqual([{ type: 'text', text: 'Hello! See [1] for details.', emotion: 'neutral' }])
  })

  it('text without any tag is neutral and still spoken', async () => {
    const { h, s } = await driven()
    s.push({ type: 'text_delta', text: 'No tag here.' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(textParts(lastAssistant(h.store))[0]).toMatchObject({ text: 'No tag here.', emotion: 'neutral' })
    expect(h.avatar()).toContainEqual({ type: 'speak', text: 'No tag here.', emotion: 'neutral' })
  })

  it('an unfinished sentence at the end of the turn is still spoken', async () => {
    const { h, s } = await driven()
    s.push({ type: 'text_delta', text: '[sad] Half a thought' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(h.avatar()).toContainEqual({ type: 'speak', text: 'Half a thought', emotion: 'sad' })
  })

  it('a turn with no text at all ends cleanly without an empty message', async () => {
    const { h, s } = await driven()
    s.push({ type: 'turn_end' })
    await h.lane.whenIdle()
    expect(h.store.messages().map((m) => m.role)).toEqual(['user'])
    expect(trace(h.emitted).slice(-1)).toEqual(['avatar:pose:idle'])
    expect(h.lane.status().state).toBe('ready')
  })
})

describe('tool calls', () => {
  it('a round trip: chip running, then done, with the spoken acknowledgement before the tool finishes', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('calendar?'))
    const s = mb.last
    s.push(
      { type: 'text_delta', text: '[thinking] Let me check your calendar.' },
      { type: 'tool_start', toolUseId: 't1', tool: 'calendar_agenda', input: { from: '2026-11-02', to: '2026-11-02' } },
    )
    await until(() => h.emitted.some((e) => e.type === 'chat.message' && e.message.parts.some((p) => p.type === 'tool')))
    // her acknowledgement was spoken at tool_start, not after the tool finished
    expect(h.avatar()).toContainEqual({ type: 'speak', text: 'Let me check your calendar.', emotion: 'thinking' })
    const running = lastAssistant(h.store)
    expect(running.parts.map((p) => p.type)).toEqual(['text', 'tool'])
    expect(running.parts[1]).toEqual({ type: 'tool', tool: 'calendar_agenda', summary: 'checking your calendar', status: 'running' })

    s.push({ type: 'tool_end', toolUseId: 't1', ok: true }, { type: 'text_delta', text: '[happy] Four things today.' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    const done = lastAssistant(h.store)
    expect(done.parts.map((p) => p.type)).toEqual(['text', 'tool', 'text'])
    expect(done.parts[1]).toMatchObject({ status: 'done', summary: 'checked your calendar' })
    expect(textParts(done).map((p) => p.text)).toEqual(['Let me check your calendar.', 'Four things today.'])
  })

  it('text after a tool starts a new part even without a new tag (deltas never append across a chip)', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('x'))
    mb.last.push({ type: 'text_delta', text: '[happy] Before.' }, { type: 'tool_start', toolUseId: 't', tool: 'brain_search', input: { query: 'q' } }, { type: 'tool_end', toolUseId: 't', ok: true }, { type: 'text_delta', text: 'After.' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    const parts = lastAssistant(h.store).parts
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'text'])
    expect(parts[2]).toMatchObject({ text: 'After.', emotion: 'happy' }) // the emotion carries over
  })

  it('an end-to-end round trip with the fake backend and the mock tools', async () => {
    const h = makeHarness()
    await ask(h, "What's on my calendar today?")
    const m = lastAssistant(h.store)
    expect(m.parts.map((p) => p.type)).toEqual(['text', 'tool', 'text'])
    expect(m.parts[1]).toMatchObject({ type: 'tool', tool: 'calendar_agenda', status: 'done', summary: 'checked your calendar' })
    expect(textParts(m)[1]?.text).toContain('4 events between 2026-11-02')
  })

  it('a failed tool shows as an error chip', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('x'))
    mb.last.push({ type: 'tool_start', toolUseId: 't', tool: 'mail_search', input: { query: 'x' } }, { type: 'tool_end', toolUseId: 't', ok: false, summary: 'provider timed out' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(lastAssistant(h.store).parts[0]).toMatchObject({ type: 'tool', status: 'error', summary: 'searching your mail (failed: provider timed out)' })
  })

  it('audits every auto-approved tool call, saying what went to the cloud', async () => {
    const h = makeHarness()
    await ask(h, 'how is my runway?')
    const entry = h.store.auditLog.find((e) => e.action === 'tool:finance_summary')
    expect(entry).toMatchObject({ actor: 'mira', outcome: 'auto', sensitive: true })
    expect(entry?.sentToCloud).toMatch(/Aggregates only/)
    expect(entry?.at).toBe(NOW.toISOString())
  })

  it('chip text for long queries is truncated', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('x'))
    mb.last.push({ type: 'tool_start', toolUseId: 't', tool: 'brain_search', input: { query: 'a'.repeat(300) } }, { type: 'turn_end' })
    await h.lane.whenIdle()
    const chip = lastAssistant(h.store).parts[0]
    expect(chip?.type === 'tool' && chip.summary.length).toBeLessThan(80)
  })
})

describe('permissions and approvals', () => {
  async function untilApproval(h: ReturnType<typeof makeHarness>) {
    await until(() => h.emitted.some((e) => e.type === 'approval.new'), 'approval.new')
    return h.of('approval.new')[0]!.approval
  }

  it('a permission request becomes an approval card in the chat and the queue, and the turn waits', async () => {
    const h = makeHarness()
    await h.lane.send(turnOf('please send the reply to Priya'))
    const a = await untilApproval(h)
    expect(a).toMatchObject({ kind: 'email_draft', status: 'pending', tier: 'T4', title: 'Send the reply to Priya', refId: 'draft-priya-reply' })
    expect(h.store.approvals.get(a.id)?.status).toBe('pending')
    const msg = lastAssistant(h.store)
    expect(msg.parts.find((p) => p.type === 'approval')).toEqual({ type: 'approval', approvalId: a.id })
    expect(h.avatar()).toContainEqual({ type: 'lookAt', target: 'screen' })
    expect(h.lane.status().state).toBe('busy')
    expect(h.types()).not.toContain('chat.done')
  })

  it('approve: the tool runs, the card resolves, the chip completes and the turn finishes', async () => {
    const h = makeHarness()
    await h.lane.send(turnOf('send it'))
    const a = await untilApproval(h)
    expect(h.lane.decideApproval(a.id, 'approved')).toBe(true)
    await h.lane.whenIdle()
    expect(h.of('approval.resolved')).toEqual([{ type: 'approval.resolved', id: a.id, status: 'approved' }])
    expect(h.store.approvals.get(a.id)?.status).toBe('approved')
    expect(h.store.auditLog.find((e) => e.actor === 'you')).toMatchObject({ action: 'tool:mail_send', outcome: 'approved' })
    const m = lastAssistant(h.store)
    expect(m.parts.find((p) => p.type === 'tool')).toMatchObject({ tool: 'mail_send', status: 'done' })
    expect(textParts(m).at(-1)?.text).toMatch(/Done\./)
    expect(h.lane.status().state).toBe('ready')
    expect(h.types().at(-2)).toBe('chat.done')
  })

  it('deny: the tool never runs, the chip says denied and the reply declines', async () => {
    const h = makeHarness()
    await h.lane.send(turnOf('send it'))
    const a = await untilApproval(h)
    expect(h.lane.decideApproval(a.id, 'denied')).toBe(true)
    await h.lane.whenIdle()
    expect(h.of('approval.resolved')[0]).toMatchObject({ id: a.id, status: 'denied' })
    expect(h.store.approvals.get(a.id)?.status).toBe('denied')
    const m = lastAssistant(h.store)
    expect(m.parts.find((p) => p.type === 'tool')).toMatchObject({ tool: 'mail_send', status: 'error', summary: 'sending the email (denied)' })
    expect(textParts(m).at(-1)?.text).toMatch(/I will not do that/)
    expect(h.store.auditLog.find((e) => e.actor === 'you')).toMatchObject({ outcome: 'denied' })
  })

  it('a locked tool is denied without ever asking: no card, an audit entry, the model told no', async () => {
    const h = makeHarness()
    await ask(h, 'pay the electricity bill')
    expect(h.types()).not.toContain('approval.new')
    expect(h.store.approvals.size).toBe(0)
    expect(h.store.auditLog.find((e) => e.action === 'tool:finance_move_money')).toMatchObject({ outcome: 'blocked', actor: 'mira' })
    const m = lastAssistant(h.store)
    expect(m.parts.find((p) => p.type === 'tool' && p.tool === 'finance_move_money')).toMatchObject({ status: 'error', summary: 'trying to move money (blocked)' })
    expect(m.parts.some((p) => p.type === 'approval')).toBe(false)
    expect(h.lane.status().state).toBe('ready')
  })

  it('the backend is told "deny" for a tool outside the lane, immediately', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('x'))
    mb.last.push({ type: 'permission_request', requestId: 'r1', tool: 'Bash', input: { command: 'rm -rf /' } })
    await until(() => mb.last.decisions.length === 1)
    expect(mb.last.decisions[0]?.[0]).toBe('r1')
    expect(mb.last.decisions[0]?.[1]).toMatchObject({ behavior: 'deny' })
    expect(h.types()).not.toContain('approval.new')
    expect(h.store.auditLog[0]).toMatchObject({ action: 'tool:Bash', outcome: 'blocked' })
  })

  it('decideApproval is false for approvals that are not the lane\'s, and idempotent for its own', async () => {
    const h = makeHarness()
    expect(h.lane.decideApproval('ap-rm-backup', 'approved')).toBe(false)
    await h.lane.send(turnOf('send it'))
    const a = await untilApproval(h)
    expect(h.lane.decideApproval(a.id, 'approved')).toBe(true)
    expect(h.lane.decideApproval(a.id, 'denied')).toBe(true) // already handled: nothing more happens
    await h.lane.whenIdle()
    expect(h.of('approval.resolved')).toHaveLength(1)
    expect(h.store.approvals.get(a.id)?.status).toBe('approved')
  })

  it('a card the backend stopped waiting for (timeout) is closed when its tool ends', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('x'))
    mb.last.push({ type: 'tool_start', toolUseId: 'r1', tool: 'mail_send', input: { draftId: 'd' } }, { type: 'permission_request', requestId: 'r1', tool: 'mail_send', input: { draftId: 'd' } })
    const a = await untilApproval(h)
    mb.last.push({ type: 'tool_end', toolUseId: 'r1', ok: false, summary: 'Nobody answered in time' })
    await until(() => h.store.approvals.get(a.id)?.status === 'denied')
    expect(h.of('approval.resolved')).toEqual([{ type: 'approval.resolved', id: a.id, status: 'denied' }])
    expect(lastAssistant(h.store).parts.find((p) => p.type === 'tool')).toMatchObject({ status: 'error', summary: 'sending the email (no answer)' })
    expect(h.store.auditLog.find((e) => e.outcome === 'denied' && e.actor === 'mira')?.detail).toMatch(/closed without an answer/)
  })

  it('cards still pending when the turn ends are denied rather than left dangling', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('x'))
    mb.last.push({ type: 'permission_request', requestId: 'r1', tool: 'mail_send', input: { draftId: 'd' } })
    const a = await untilApproval(h)
    mb.last.push({ type: 'turn_end' })
    await h.lane.whenIdle()
    expect(h.store.approvals.get(a.id)?.status).toBe('denied')
  })

  it('the same request twice produces one card', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('x'))
    const ev = { type: 'permission_request' as const, requestId: 'dup', tool: 'mail_send', input: { draftId: 'd' } }
    mb.last.push(ev, ev)
    await until(() => h.of('approval.new').length >= 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.of('approval.new')).toHaveLength(1)
    expect(lastAssistant(h.store).parts.filter((p) => p.type === 'approval')).toHaveLength(1)
  })

  it('a permission request with no active turn is denied', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    mb.last.push({ type: 'permission_request', requestId: 'stray', tool: 'mail_send', input: {} })
    await until(() => mb.last.decisions.length === 1)
    expect(mb.last.decisions[0]?.[1]).toMatchObject({ behavior: 'deny' })
    expect(h.types()).not.toContain('approval.new')
  })
})

describe('interrupt (barge-in)', () => {
  it('ends the turn cleanly mid-stream: chat.done, idle, and no deltas afterwards', async () => {
    const h = makeHarness({ fake: { latencyMs: 15, chunkSize: 4 } })
    await h.lane.send(turnOf('hello'))
    await until(() => h.types().includes('chat.delta'))
    await h.lane.interrupt()
    const marker = h.mark()
    await new Promise((r) => setTimeout(r, 80))
    expect(h.emitted.slice(marker).filter((e) => e.type === 'chat.delta' || (e.type === 'avatar' && e.event.type === 'speak'))).toEqual([])
    const t = trace(h.emitted)
    expect(t.filter((x) => x === 'chat.done')).toHaveLength(1)
    expect(t.at(-1)).toBe('avatar:pose:idle')
    expect(h.lane.status().state).toBe('ready')
    // the partial text that was already shown stays
    expect(textParts(lastAssistant(h.store))[0]?.text).toBe('Good morning!'.slice(0, textParts(lastAssistant(h.store))[0]!.text.length))
  })

  it('the lane works normally after an interrupt, and the cost of the cut-off turn is still recorded', async () => {
    const h = makeHarness({ fake: { latencyMs: 10, chunkSize: 4, costPerTurnUsd: 0.25 } })
    await h.lane.send(turnOf('hello'))
    await until(() => h.types().includes('chat.delta'))
    await h.lane.interrupt()
    await h.lane.whenIdle()
    expect(h.budget.status().globalSpentTodayUsd).toBe(0.25)
    await ask(h, 'thanks')
    expect(textParts(lastAssistant(h.store)).map((p) => p.text).join(' ')).toMatch(/Happy to help/)
    expect(h.budget.status().globalSpentTodayUsd).toBe(0.5)
  })

  it('does nothing when no turn is running, and a second interrupt is a no-op', async () => {
    const h = makeHarness()
    await h.lane.start()
    await h.lane.interrupt()
    expect(h.emitted).toEqual([])
    const slow = makeHarness({ fake: { latencyMs: 15, chunkSize: 4 } })
    await slow.lane.send(turnOf('hello'))
    await until(() => slow.types().includes('chat.delta'))
    await Promise.all([slow.lane.interrupt(), slow.lane.interrupt()])
    expect(slow.types().filter((t) => t === 'chat.done')).toHaveLength(1)
  })

  it('interrupting while an approval is pending denies it and ends the turn', async () => {
    const h = makeHarness()
    await h.lane.send(turnOf('send it'))
    await until(() => h.types().includes('approval.new'))
    const id = h.of('approval.new')[0]!.approval.id
    await h.lane.interrupt()
    expect(h.store.approvals.get(id)?.status).toBe('denied')
    expect(h.types()).toContain('chat.done')
    expect(h.lane.status().state).toBe('ready')
  })

  it('a message sent while the lane is busy is queued behind the interrupted turn, not lost', async () => {
    const h = makeHarness({ fake: { latencyMs: 10, chunkSize: 4 } })
    await h.lane.send(turnOf('hello'))
    await until(() => h.types().includes('chat.delta'))
    const pendingInterrupt = h.lane.interrupt()
    await h.lane.send(turnOf('thanks'))
    await pendingInterrupt
    await h.lane.whenIdle()
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(textParts(h.store.messages()[3]!).map((p) => p.text).join(' ')).toMatch(/Happy to help/)
  })

  it('if the backend never confirms the interrupt the lane ends the turn itself, and later stale events cannot end the NEXT turn', async () => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { timers } })
    await h.lane.start()
    await h.lane.send(turnOf('one'))
    mb.last.push({ type: 'text_delta', text: '[happy] Wait' })
    await until(() => h.types().includes('chat.message'))
    const interrupting = h.lane.interrupt()
    await until(() => timers.pending().length === 1)
    expect(mb.last.interrupts).toBe(1)
    timers.fire() // the interrupt wait expires
    await interrupting
    expect(h.types().filter((t) => t === 'chat.done')).toHaveLength(1)
    expect(h.lane.status().state).toBe('ready')

    // a new turn starts; then the old turn's late events arrive first, as the backend's ordering guarantees
    await h.lane.send(turnOf('two'))
    expect(mb.last.sent).toHaveLength(2)
    mb.last.push({ type: 'text_delta', text: ' stale text' }, { type: 'turn_end', costUsd: 0.4, interrupted: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.lane.status().state).toBe('busy') // turn two was not ended by turn one's terminal event
    expect(visibleChatText(h).join(' ')).not.toContain('stale text')
    expect(h.budget.status().globalSpentTodayUsd).toBe(0.4) // but its cost was recorded

    mb.last.push({ type: 'text_delta', text: '[happy] Second answer.' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(textParts(lastAssistant(h.store)).map((p) => p.text)).toEqual(['Second answer.'])
  })
})

describe('budget', () => {
  it('over budget: an explanatory system message, no backend call', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, dailyBudgetUsd: 1 })
    h.budget.record('secretary', 1)
    await h.lane.start()
    await h.lane.send(turnOf('hello'))
    expect(mb.last.sent).toEqual([])
    const msgs = h.store.messages()
    expect(msgs.map((m) => m.role)).toEqual(['user', 'system'])
    expect(textParts(msgs[1]!)[0]?.text).toMatch(/secretary lane's daily budget of \$1\.00 is used up/)
    expect(trace(h.emitted)).toEqual(['chat.message:user', 'chat.message:system'])
    expect(h.lane.status().state).toBe('ready')
  })

  it('the global cap blocks too, and the lane recovers once the budget does', async () => {
    const h = makeHarness({ globalDailyCapUsd: 2 })
    h.budget.record('reader', 2)
    await ask(h, 'hello')
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'system'])
    expect(textParts(h.store.messages()[1]!)[0]?.text).toMatch(/global daily cap/)
    h.budget.configure({ globalDailyCapUsd: 50 })
    await ask(h, 'hello')
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'system', 'user', 'assistant'])
  })

  it('a turn that pushes the lane over budget finishes, and the NEXT message is refused', async () => {
    const h = makeHarness({ dailyBudgetUsd: 1, fake: { costPerTurnUsd: 1.5 } })
    await ask(h, 'hello')
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'assistant'])
    await ask(h, 'again')
    expect(h.store.messages().at(-1)?.role).toBe('system')
  })

  it('queued messages are checked against the budget when their turn comes', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, dailyBudgetUsd: 1 })
    await h.lane.start()
    await h.lane.send(turnOf('first'))
    await h.lane.send(turnOf('second'))
    mb.last.push({ type: 'text_delta', text: 'ok.' }, { type: 'turn_end', costUsd: 5 })
    await h.lane.whenIdle()
    expect(mb.last.sent.map((t) => t.text)).toEqual(['first'])
    expect(h.store.messages().filter((m) => m.role === 'system')).toHaveLength(1)
  })
})

describe('resume', () => {
  it('persists the backend session id and reuses it after a restart', async () => {
    const store = new MemoryStore()
    const backend = createFakeBackend({ now: () => NOW })
    const first = makeHarness({ backend, store })
    await ask(first, 'hello')
    expect(store.sessionIds.get('secretary')).toBe('fake-secretary-1')
    expect(first.lane.status().backendSessionId).toBe('fake-secretary-1')
    await first.lane.stop()
    expect(backend.opened[0]?.resumeSessionId).toBeUndefined()

    const second = makeHarness({ backend, store })
    await second.lane.start()
    expect(backend.opened[1]?.resumeSessionId).toBe('fake-secretary-1')
    await ask(second, 'thanks')
    expect(store.sessionIds.get('secretary')).toBe('fake-secretary-1')
    expect(second.lane.status().backendSessionId).toBe('fake-secretary-1')
  })

  it('a session open across midnight is renewed on the next message, resuming the same conversation', async () => {
    const h = makeHarness()
    await ask(h, 'hello')
    expect(h.backend.opened).toHaveLength(1)
    h.clock.date = new Date(2026, 10, 2, 23, 50)
    await ask(h, 'thanks')
    expect(h.backend.opened).toHaveLength(1) // same day: same session
    h.clock.date = new Date(2026, 10, 3, 7, 30)
    await ask(h, 'good morning')
    expect(h.backend.opened).toHaveLength(2)
    expect(h.backend.opened[1]?.resumeSessionId).toBe('fake-secretary-1')
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  })

  it('the renewed session carries the new date in its first turn context', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('one'))
    mb.last.push({ type: 'turn_end' })
    await h.lane.whenIdle()
    h.clock.date = new Date(2026, 10, 3, 8, 0)
    await h.lane.send(turnOf('two'))
    expect(mb.sessions).toHaveLength(2)
    expect(mb.sessions[0]?.closed).toBe(true)
    expect(mb.last.sent[0]?.context).toBe('Today is Tuesday, 2026-11-03. It is morning for the user.')
  })

  it('a resumed session does not get the chat history re-sent as context', async () => {
    const store = new MemoryStore()
    store.saveBackendSessionId('secretary', 'prev')
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, store })
    await h.lane.send(turnOf('hello again'))
    expect(mb.opened[0]?.resumeSessionId).toBe('prev')
    expect(mb.last.sent[0]?.context).not.toMatch(/Earlier in this conversation/)
  })

  it('if the old session cannot be resumed it starts fresh and seeds the first turn with the recent chat', async () => {
    const store = new MemoryStore()
    store.saveBackendSessionId('secretary', 'gone')
    store.upsertChat({ id: 'old-1', role: 'user', createdAt: NOW.toISOString(), modality: 'text', parts: [{ type: 'text', text: 'Remind me about the Atlas migration.' }] })
    store.upsertChat({ id: 'old-2', role: 'assistant', createdAt: NOW.toISOString(), modality: 'text', parts: [{ type: 'text', text: 'Done, it is at the top of tomorrow.', emotion: 'happy' }] })
    const mb = new ManualBackend()
    mb.failOpen = (o) => (o.resumeSessionId ? new Error('No conversation found with session ID: gone') : undefined)
    const h = makeHarness({ backend: mb, store })
    await h.lane.send(turnOf('where were we?'))
    expect(mb.opened.map((o) => o.resumeSessionId)).toEqual(['gone', undefined])
    const context = mb.last.sent[0]?.context ?? ''
    expect(context).toContain('Earlier in this conversation')
    expect(context).toContain('User: Remind me about the Atlas migration.')
    expect(context).toContain('You: Done, it is at the top of tomorrow.')
    // the new id replaces the stale one
    expect(store.sessionIds.get('secretary')).toBe('manual-1')
  })

  it('a transient failure while resuming keeps the old session id for the next attempt', async () => {
    const store = new MemoryStore()
    store.saveBackendSessionId('secretary', 'prev')
    const mb = new ManualBackend()
    mb.failOpen = () => new BackendError('connect ECONNREFUSED', 'process', true)
    const h = makeHarness({ backend: mb, store, lane: { timers: fakeTimers() } })
    await h.lane.start()
    expect(mb.opened.map((o) => o.resumeSessionId)).toEqual(['prev']) // no fresh session was started in its place
    expect(store.sessionIds.get('secretary')).toBe('prev')
    expect(h.lane.status().state).toBe('error')
  })

  it('an auth failure while resuming is not retried without resume (it would fail the same way)', async () => {
    const store = new MemoryStore()
    store.saveBackendSessionId('secretary', 'prev')
    const mb = new ManualBackend()
    mb.failOpen = () => new BackendError('No API key', 'auth', false)
    const h = makeHarness({ backend: mb, store })
    await h.lane.start()
    expect(mb.opened).toHaveLength(1)
    expect(h.lane.status()).toMatchObject({ state: 'error', error: 'No API key' })
  })
})

describe('session configuration', () => {
  it('opens the backend with the persona prompt, the lane model, only the lane\'s tools and the auth settings', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    const o: OpenSessionOptions = mb.opened[0]!
    expect(o.lane).toBe('secretary')
    expect(o.systemPrompt).toBe(buildStablePrompt(h.persona))
    expect(o.model).toBe('claude-sonnet-5-5')
    expect(o.effort).toBe('medium')
    expect(o.authMode).toBe('api-key')
    expect(o.apiKey).toBe('sk-ant-test-0000000000000000')
    expect(o.maxBudgetUsd).toBe(4)
    expect(o.claudeExecutable).toBeUndefined()
    const names = o.tools.map((b) => b.spec.name)
    expect(names).toContain('mail_send')
    expect(names).not.toContain('finance_move_money')
    for (const b of o.tools) expect(b.spec.lanes).toContain('secretary')
    expect(o.autoAllow).toEqual(o.tools.filter((b) => b.spec.tier === 'T0' || b.spec.tier === 'T1').map((b) => b.spec.name))
    expect(o.autoAllow).toContain('brain_journal_append')
    expect(o.autoAllow).not.toContain('mail_send')
  })

  it('picks up model and effort from the Claude connection settings', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    const lane = h.claude.lanes.find((l) => l.id === 'secretary')!
    lane.model = 'claude-haiku-5-5'
    lane.effort = 'high'
    await h.lane.start()
    expect(mb.opened[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
  })

  it('local-login: no key is passed along, the user\'s own executable is', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, mode: 'local-login' })
    ;(h.deps.env as { claudeExecutable?: string }).claudeExecutable = 'C:\\Users\\me\\.local\\bin\\claude.exe'
    const lane = createSecretaryLane(h.deps)
    await lane.start()
    expect(mb.opened[0]).toMatchObject({ authMode: 'local-login', claudeExecutable: 'C:\\Users\\me\\.local\\bin\\claude.exe' })
    expect(mb.opened[0]?.apiKey).toBeUndefined()
    await lane.stop()
  })

  it('api-key mode never passes the executable path', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    ;(h.deps.env as { claudeExecutable?: string }).claudeExecutable = 'C:\\claude.exe'
    const lane = createSecretaryLane(h.deps)
    await lane.start()
    expect(mb.opened[0]?.claudeExecutable).toBeUndefined()
    await lane.stop()
  })

  it('a custom isAutoApproved decides which tools run without a card', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { isAutoApproved: (s) => s.name === 'mail_send' } })
    await h.lane.start()
    expect(mb.opened[0]?.autoAllow).toEqual(['mail_send'])
  })

  it('the per-turn context carries the date once, then only when it changes', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    const s = mb.last
    await h.lane.send(turnOf('one'))
    s.push({ type: 'turn_end' })
    await h.lane.whenIdle()
    await h.lane.send(turnOf('two'))
    s.push({ type: 'turn_end' })
    await h.lane.whenIdle()
    expect(s.sent[0]?.context).toBe('Today is Monday, 2026-11-02. It is morning for the user.')
    expect(s.sent[1]?.context).toBeUndefined()
  })

  it('the system prompt itself carries no date (it must stay byte-stable)', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    expect(mb.opened[0]?.systemPrompt).not.toMatch(/2026/)
  })

  it('a lane switched off in Settings does not start and says so when asked to chat', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    h.claude.lanes.find((l) => l.id === 'secretary')!.enabled = false
    await h.lane.start()
    expect(h.lane.status()).toMatchObject({ state: 'stopped', error: 'The Secretary lane is switched off in Settings.' })
    await h.lane.send(turnOf('hello'))
    expect(mb.opened).toHaveLength(0)
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'system'])
  })

  it('reports the backend kind in its status', async () => {
    expect(makeHarness().lane.status().backend).toBe('fake')
  })
})

describe('failure and recovery', () => {
  it('a backend error becomes a friendly assistant message, state "error", and a restart that brings it back', async () => {
    const timers = fakeTimers()
    const h = makeHarness({ lane: { timers } })
    await h.lane.send(turnOf('please !error'))
    await h.lane.whenIdle()
    const m = lastAssistant(h.store)
    expect(textParts(m).at(-1)).toMatchObject({ emotion: 'sad', text: expect.stringMatching(/Something went wrong on my side/) })
    expect(JSON.stringify(m)).not.toContain('Simulated backend failure') // the technical text stays out of the chat
    expect(h.lane.status()).toMatchObject({ state: 'error', error: 'Simulated backend failure (!error).' })
    expect(h.types().at(-2)).toBe('chat.done')
    expect(timers.pending()).toHaveLength(1)
    expect(timers.pending()[0]?.ms).toBe(1)

    timers.fire()
    await until(() => h.lane.status().state === 'ready')
    expect(h.backend.opened).toHaveLength(2)
    expect(h.lane.status().error).toBeUndefined()
    await ask(h, 'thanks')
    expect(textParts(lastAssistant(h.store)).map((p) => p.text).join(' ')).toMatch(/Happy to help/)
  })

  it('the restart resumes the conversation: it reopens with the persisted session id', async () => {
    const timers = fakeTimers()
    const h = makeHarness({ lane: { timers } })
    await h.lane.send(turnOf('hello'))
    await h.lane.whenIdle()
    await h.lane.send(turnOf('!error'))
    await h.lane.whenIdle()
    timers.fire()
    await until(() => h.lane.status().state === 'ready')
    expect(h.backend.opened[1]?.resumeSessionId).toBe('fake-secretary-1')
  })

  it('a session that dies without a word (stream ends) is treated as a failure and restarted', async () => {
    const timers = fakeTimers()
    const h = makeHarness({ lane: { timers } })
    await h.lane.send(turnOf('!crash'))
    await until(() => h.lane.status().state === 'error')
    expect(textParts(lastAssistant(h.store)).at(-1)?.text).toMatch(/lost the thread/)
    timers.fire()
    await until(() => h.lane.status().state === 'ready')
    await ask(h, 'hello')
    expect(h.lane.status().state).toBe('ready')
  })

  it('a session that dies while idle is restarted quietly', async () => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { timers } })
    await h.lane.start()
    mb.last.end()
    await until(() => h.lane.status().state === 'error')
    expect(h.store.messages()).toEqual([]) // nothing was said: no turn was running
    timers.fire()
    await until(() => h.lane.status().state === 'ready')
    expect(mb.sessions).toHaveLength(2)
  })

  it('restarts are bounded, back off, and stop with one notice; a new message then tries again', async () => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { timers, maxRestarts: 3, backoffMs: (n) => 100 * n } })
    await h.lane.start()
    expect(h.lane.status().state).toBe('ready')
    mb.failOpen = () => new BackendError('connect ECONNREFUSED', 'process', true)
    mb.last.end() // the session dies
    await until(() => h.lane.status().state === 'error')

    for (let i = 1; i <= 3; i++) {
      expect(timers.pending()).toHaveLength(1)
      expect(timers.pending()[0]?.ms).toBe(100 * i)
      timers.fire()
      await until(() => mb.opened.length === 1 + i)
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(timers.pending()).toHaveLength(0) // gave up
    expect(h.lane.status().state).toBe('error')
    expect(h.store.messages().filter((m) => m.role === 'system')).toHaveLength(1)
    expect(textParts(h.store.messages()[0]!)[0]?.text).toMatch(/could not restore it/)

    // the network is back; a message from the user is an immediate extra attempt
    mb.failOpen = undefined
    await h.lane.send(turnOf('hello?'))
    expect(h.lane.status().state).toBe('busy')
    mb.last.push({ type: 'text_delta', text: '[happy] Here.' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(h.lane.status().state).toBe('ready')
    expect(textParts(lastAssistant(h.store)).map((p) => p.text)).toEqual(['Here.'])
  })

  it('the attempt counter resets after a successful turn', async () => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { timers, maxRestarts: 1 } })
    await h.lane.start()
    for (let round = 0; round < 3; round++) {
      mb.last.end()
      await until(() => h.lane.status().state === 'error')
      expect(timers.pending()).toHaveLength(1)
      timers.fire()
      await until(() => h.lane.status().state === 'ready')
      await h.lane.send(turnOf('hi'))
      mb.last.push({ type: 'text_delta', text: 'ok.' }, { type: 'turn_end' })
      await h.lane.whenIdle()
    }
    expect(mb.sessions).toHaveLength(4)
  })

  it('open failing at start() does not throw: the lane reports the error and retries', async () => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    mb.failOpen = (_o, attempt) => (attempt === 1 ? new Error('spawn claude ENOENT') : undefined)
    const h = makeHarness({ backend: mb, lane: { timers } })
    await expect(h.lane.start()).resolves.toBeUndefined()
    expect(h.lane.status()).toMatchObject({ state: 'error', error: 'spawn claude ENOENT' })
    timers.fire()
    await until(() => h.lane.status().state === 'ready')
  })

  it('a missing API key (non-retryable) is not retried, and the user is told what to do', async () => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    mb.failOpen = () => new BackendError('No Anthropic API key is configured.', 'auth', false)
    const h = makeHarness({ backend: mb, lane: { timers } })
    await h.lane.start()
    expect(timers.pending()).toHaveLength(0)
    await h.lane.send(turnOf('hello'))
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(textParts(h.store.messages()[1]!)[0]?.text).toMatch(/API key was rejected or is missing/)
    expect(mb.opened).toHaveLength(2) // the message triggered one more attempt
  })

  it.each([
    ['auth', /API key was rejected or is missing/, 'error', 0],
    ['billing', /out of credit/, 'error', 0],
    ['budget', /spending cap/, 'error', 0],
  ] as const)('a %s error: friendly message, lane in error, no automatic restart', async (kind, pattern, state, timerCount) => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { timers } })
    await h.lane.start()
    await h.lane.send(turnOf('hello'))
    mb.last.push({ type: 'error', message: `${kind} problem`, retryable: false, kind })
    await h.lane.whenIdle()
    expect(textParts(lastAssistant(h.store)).at(-1)?.text).toMatch(pattern)
    expect(h.lane.status().state).toBe(state)
    expect(timers.pending()).toHaveLength(timerCount)
    expect(mb.sessions[0]?.closed).toBe(true)
  })

  it.each([
    ['refusal', /cannot help with that one/],
    ['rate_limit', /rate limiting/],
    ['overloaded', /overloaded/],
  ] as const)('a %s error keeps the session: friendly message, lane stays ready', async (kind, pattern) => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { timers } })
    await h.lane.start()
    await h.lane.send(turnOf('hello'))
    mb.last.push({ type: 'error', message: 'x', retryable: kind !== 'refusal', kind })
    await h.lane.whenIdle()
    expect(textParts(lastAssistant(h.store)).at(-1)?.text).toMatch(pattern)
    expect(h.lane.status().state).toBe('ready')
    expect(mb.sessions[0]?.closed).toBe(false)
    expect(timers.pending()).toHaveLength(0)
    await h.lane.send(turnOf('again'))
    expect(mb.sessions[0]?.sent).toHaveLength(2)
  })

  it('the cost carried by an error is still recorded', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('hello'))
    mb.last.push({ type: 'error', message: 'x', retryable: false, kind: 'budget', costUsd: 4.2 })
    await h.lane.whenIdle()
    expect(h.budget.status().globalSpentTodayUsd).toBe(4.2)
  })

  it('messages queued behind a failed turn are dropped with one explanation, not sent into a dead session', async () => {
    const mb = new ManualBackend()
    const timers = fakeTimers()
    const h = makeHarness({ backend: mb, lane: { timers } })
    await h.lane.start()
    await h.lane.send(turnOf('one'))
    await h.lane.send(turnOf('two'))
    mb.last.push({ type: 'error', message: 'boom', retryable: true, kind: 'process' })
    await h.lane.whenIdle()
    expect(mb.sessions[0]?.sent.map((t) => t.text)).toEqual(['one'])
    expect(h.store.messages().filter((m) => m.role === 'system').map((m) => textParts(m)[0]?.text)).toEqual(['Your next message was not sent because I lost the connection. Please send it again.'])
  })

  it('error text is redacted in the status', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('hello'))
    mb.last.push({ type: 'error', message: 'request failed with key sk-ant-api03-SECRETSECRETSECRET1234', retryable: false, kind: 'unknown' })
    await h.lane.whenIdle()
    expect(h.lane.status().error).not.toContain('SECRETSECRET')
  })

  it('a store or subscriber that throws does not break the conversation', async () => {
    const h = makeHarness()
    h.store.upsertChat = () => {
      throw new Error('disk full')
    }
    h.store.audit = () => {
      throw new Error('disk full')
    }
    h.store.saveBackendSessionId = () => {
      throw new Error('disk full')
    }
    const emit = h.deps.emit
    let first = true
    h.deps.emit = (d) => {
      if (first) {
        first = false
        throw new Error('subscriber bug')
      }
      emit(d)
    }
    await ask(h, "what's on my calendar?")
    expect(h.types()).toContain('chat.done')
    expect(h.lane.status().state).toBe('ready')
  })
})

describe('queueing and lifecycle', () => {
  it('messages sent while a reply is streaming wait their turn, in order, each recorded at once', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('first'))
    await h.lane.send(turnOf('second'))
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'user']) // both visible immediately
    expect(mb.last.sent.map((t) => t.text)).toEqual(['first'])
    mb.last.push({ type: 'text_delta', text: '[happy] One.' }, { type: 'turn_end' })
    await until(() => mb.last.sent.length === 2)
    mb.last.push({ type: 'text_delta', text: '[sad] Two.' }, { type: 'turn_end' })
    await h.lane.whenIdle()
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'assistant'])
    expect(textParts(h.store.messages()[2]!)[0]?.text).toBe('One.')
    expect(textParts(h.store.messages()[3]!)[0]?.text).toBe('Two.')
  })

  it('send() starts the lane by itself when start() was never called', async () => {
    const h = makeHarness()
    await ask(h, 'hello')
    expect(h.store.messages().map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('start() twice opens one session', async () => {
    const h = makeHarness()
    await Promise.all([h.lane.start(), h.lane.start()])
    expect(h.backend.opened).toHaveLength(1)
  })

  it('status moves starting -> ready -> busy -> ready', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    expect(h.lane.status().state).toBe('stopped')
    await h.lane.start()
    expect(h.lane.status().state).toBe('ready')
    await h.lane.send(turnOf('hi'))
    expect(h.lane.status().state).toBe('busy')
    mb.last.push({ type: 'turn_end' })
    await h.lane.whenIdle()
    expect(h.lane.status().state).toBe('ready')
  })

  it('stop() ends the active turn, closes the session and refuses further work', async () => {
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb })
    await h.lane.start()
    await h.lane.send(turnOf('hi'))
    mb.last.push({ type: 'text_delta', text: '[happy] Hel' })
    await until(() => h.types().includes('chat.message'))
    await h.lane.stop()
    expect(mb.last.closed).toBe(true)
    expect(h.lane.status().state).toBe('stopped')
    expect(h.types().filter((t) => t === 'chat.done')).toHaveLength(1)
    await expect(h.lane.send(turnOf('again'))).rejects.toThrow(/stopped/)
    await expect(h.lane.start()).rejects.toThrow(/stopped/)
    await h.lane.stop() // idempotent
  })

  it('stop() cancels a pending restart', async () => {
    const timers = fakeTimers()
    const mb = new ManualBackend()
    const h = makeHarness({ backend: mb, lane: { timers } })
    await h.lane.start()
    mb.last.end()
    await until(() => timers.pending().length === 1)
    await h.lane.stop()
    expect(timers.pending()).toHaveLength(0)
    expect(mb.sessions).toHaveLength(1)
  })

  it('stop() denies cards that are still pending', async () => {
    const h = makeHarness()
    await h.lane.send(turnOf('send it'))
    await until(() => h.types().includes('approval.new'))
    const id = h.of('approval.new')[0]!.approval.id
    await h.lane.stop()
    expect(h.store.approvals.get(id)?.status).toBe('denied')
  })

  it('two lanes never share state', async () => {
    const a = makeHarness()
    const b = makeHarness()
    await ask(a, 'hello')
    expect(b.store.messages()).toEqual([])
    expect(b.emitted).toEqual([])
  })

  it('works with a backend that has no tools bound (nothing to call, nothing breaks)', async () => {
    const h = makeHarness({ tools: [] })
    await ask(h, "what's on my calendar?")
    expect(textParts(lastAssistant(h.store))[1]?.text ?? textParts(lastAssistant(h.store))[0]?.text).toMatch(/do not have a tool/)
  })

  it('a lane given an AgentBackend with a different shape still honours the interface (compile-time check)', () => {
    const backend: AgentBackend = createFakeBackend()
    expect(backend.kind).toBe('fake')
  })
})
