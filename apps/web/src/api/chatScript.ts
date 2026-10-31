import type { ChatPart, Emotion, Snapshot } from '@ai-assistant/shared'

/**
 * Scripted assistant replies for the mockup. The FixtureClient streams these as if Claude were answering.
 * A step is either a tool chip (shown running then done), a text sentence with an emotion tag, or a
 * ready-made part (approval card / note citation). Every approval id and note path referenced here is
 * checked against the snapshot before it is emitted, so a reply never points at something that is gone.
 */
export type ScriptStep =
  | { kind: 'tool'; tool: string; summary: string }
  | { kind: 'text'; text: string; emotion: Emotion }
  | { kind: 'part'; part: ChatPart }

type Steps = ScriptStep[]

const tool = (name: string, summary: string): ScriptStep => ({ kind: 'tool', tool: name, summary })
const say = (emotion: Emotion, text: string): ScriptStep => ({ kind: 'text', emotion, text })

/** An approval card, only if that approval is still in the snapshot. */
function approval(snap: Snapshot, id: string): Steps {
  return snap.approvals.some((a) => a.id === id) ? [{ kind: 'part', part: { type: 'approval', approvalId: id } }] : []
}

/** A note citation, only if the note exists in the vault. Title comes from the vault itself. */
function note(snap: Snapshot, path: string): Steps {
  const n = snap.notes.find((x) => x.path === path)
  return n ? [{ kind: 'part', part: { type: 'note', note: { path: n.path, title: n.title } } }] : []
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

// ---------------------------------------------------------------- intents

function needsYou(snap: Snapshot, first: boolean): Steps {
  const pending = snap.approvals.filter((a) => a.status === 'pending')
  const waiting = snap.sessions.filter((s) => s.status === 'waiting_input' || s.status === 'blocked_permission')
  if (pending.length === 0 && waiting.length === 0) {
    return [
      tool('worklog_status', 'checked your sessions'),
      say('happy', 'Nothing is waiting on you. That is rare, enjoy it.'),
      say('relaxed', 'I will tap your shoulder the moment that changes.'),
    ]
  }
  // Highest risk first, then oldest.
  const rank = { high: 0, medium: 1, low: 2 } as const
  const sorted = pending.slice().sort((a, b) => rank[a.risk] - rank[b.risk] || a.requestedAt.localeCompare(b.requestedAt))
  const top = sorted[0]
  const steps: Steps = [tool('worklog_status', `checked your ${snap.sessions.length} sessions`)]
  if (first) {
    steps.push(say('thinking', top ? `Start with this one: "${top.title}".` : 'Start with the agent that is waiting.'))
    steps.push(say('neutral', 'It is the riskiest, and the Atlas beta date slips a day for every day it sits.'))
  } else {
    steps.push(say('neutral', `${plural(pending.length, 'thing')} waiting on you, and ${plural(waiting.length, 'agent')} stuck until you answer.`))
    steps.push(say('thinking', top ? 'The riskiest is first, so you can decide with a clear head.' : 'Nothing risky, just questions.'))
  }
  if (top) steps.push(...approval(snap, top.id))
  const next = sorted[1]
  if (next) steps.push(say('relaxed', `After that: "${next.title}". Low drama.`))
  return steps
}

function agenda(snap: Snapshot): Steps {
  const now = new Date()
  const today = snap.calendar
    .filter((e) => !e.allDay && sameDay(new Date(e.start), now))
    .sort((a, b) => a.start.localeCompare(b.start))
  const upcoming = today.filter((e) => new Date(e.end) > now)
  const steps: Steps = [tool('calendar_agenda', 'read today\'s agenda')]
  if (today.length === 0) {
    steps.push(say('relaxed', 'Your calendar is empty today. A rare gift for deep work.'))
    return steps
  }
  const next = upcoming[0]
  const ahead = upcoming.length
  steps.push(
    say(
      'happy',
      `${plural(today.length, 'thing')} today, ${ahead === 0 ? 'all of them behind you' : `${ahead} still ahead`}.${next ? ` Next up: ${next.title} at ${hhmm(next.start)}.` : ''}`,
    ),
  )
  const dana = upcoming.find((e) => e.id === 'ev-dana')
  if (dana) {
    steps.push(say('thinking', `The ${hhmm(dana.start)} with Dana is the one that matters. It touches your Q4 positioning, so I put a one-line answer in the prep.`))
    steps.push(...note(snap, '10-strategy/q4-positioning.md'))
  }
  const evening = upcoming.find((e) => e.id === 'ev-leo')
  if (evening && next?.id !== 'ev-leo') steps.push(say('relaxed', `Coffee with Leo at ${hhmm(evening.start)}, and I kept the rest of the evening clear.`))
  else if (evening) steps.push(say('relaxed', 'After that the evening is clear. I protected it.'))
  return steps
}

function q4(snap: Snapshot): Steps {
  const pr = snap.proposals.find((p) => p.id === 'pr-q4')
  const steps: Steps = [tool('brain_search', 'searched your vault for "Q4 positioning"')]
  steps.push(say('thinking', 'Your current wording is still broad: "general productivity toolmaker". Nothing in your journal supports it.'))
  steps.push(say('happy', 'What your last five entries keep saying is local-first tools for independent builders. That is the wedge.'))
  steps.push(...note(snap, '10-strategy/q4-positioning.md'))
  steps.push(...note(snap, '30-knowledge/local-first-software.md'))
  if (pr?.status === 'pending') {
    steps.push(say('neutral', 'I wrote it up as a proposal. Strategy notes only change after you read the diff.'))
    steps.push(...approval(snap, 'ap-q4-proposal'))
  } else if (pr?.status === 'approved') {
    steps.push(say('happy', 'And you already approved my edit, so the note says it now.'))
  }
  return steps
}

function money(snap: Snapshot): Steps {
  const f = snap.finance
  const planned = f.budget.reduce((a, b) => a + Number(b.planned.amountMinor), 0) / 100
  const actual = f.budget.reduce((a, b) => a + Number(b.actual.amountMinor), 0) / 100
  const next = f.upcomingBills.filter((b) => !b.isPaid).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const bigNext = next.find((b) => Number(b.expected.amountMinor) / 100 >= 500 && !b.autopay) ?? next[0]
  const left = Math.max(0, Math.round(planned - actual))
  const steps: Steps = [tool('finance_summary', 'read Atlas aggregates, no transactions')]
  steps.push(say('happy', `You are under budget this month, with about $${left.toLocaleString()} of plan left unspent.`))
  if (bigNext) {
    const amt = Number(bigNext.expected.amountMinor) / 100
    const due = new Date(`${bigNext.dueDate}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })
    steps.push(say('neutral', `The next one to watch is ${bigNext.payee}: $${amt.toLocaleString()} due ${due}${bigNext.autopay ? ', on autopay' : ', not on autopay'}.`))
  }
  steps.push(say('relaxed', f.connected ? 'That moves your independence date forward a little.' : 'Atlas is not connected in this preview, so these are sample numbers. I only ever read it, I cannot move money.'))
  steps.push(...note(snap, '10-strategy/financial-independence.md'))
  return steps
}

function news(snap: Snapshot): Steps {
  const top = snap.world.news.slice().sort((a, b) => b.relevance.score - a.relevance.score)[0]
  const steps: Steps = [tool('news_briefing', 're-ranked today\'s news for you')]
  if (!top) {
    steps.push(say('relaxed', 'Quiet news day. Nothing earns your attention.'))
    return steps
  }
  steps.push(say('surprised', `One item is worth your coffee: "${top.title}".`))
  steps.push(say('neutral', top.relevance.why))
  if (top.relevance.note) steps.push(...note(snap, top.relevance.note.path))
  steps.push(say('relaxed', 'The rest can wait. I filed it in World.'))
  return steps
}

function dana(snap: Snapshot): Steps {
  const m = snap.mail.find((x) => x.id === 'm-dana')
  const steps: Steps = [tool('contacts_find', 'looked up Dana Reyes'), tool('mail_search', 'read her last email')]
  steps.push(say('happy', 'Dana is warm, and she offered you an intro to a seed investor.'))
  if (m) steps.push(say('thinking', `Her last email asks one thing: "${m.snippet.split('. ').pop()}"`))
  steps.push(say('neutral', 'Your answer is the Q4 wedge: local-first tools for independent builders. Say that and she can forward it as is.'))
  steps.push(...note(snap, '30-knowledge/people/dana-reyes.md'))
  steps.push(...note(snap, '10-strategy/q4-positioning.md'))
  return steps
}

function priya(snap: Snapshot): Steps {
  return [
    tool('mail_search', 'opened the thread with Priya'),
    say('neutral', 'Priya wants the revised homepage before Thursday. I drafted a short reply and offered a walkthrough.'),
    say('relaxed', 'It only goes out if you approve it.'),
    ...approval(snap, 'ap-reply-priya'),
    ...note(snap, '30-knowledge/people/priya-nair.md'),
  ]
}

function focus(snap: Snapshot): Steps {
  return [
    tool('calendar_agenda', 'looked at Thursday'),
    say('thinking', 'Thursday has no deep-work block yet, and your system asks for two protected hours a day.'),
    say('happy', 'I drafted 09:00 to 11:00. It is a calendar hold, so it waits for your yes.'),
    ...approval(snap, 'ap-focus-block'),
    ...note(snap, '10-strategy/deep-work-system.md'),
  ]
}

function weather(snap: Snapshot): Steps {
  const w = snap.world.weather
  const cond: Record<string, string> = {
    clear: 'clear', cloudy: 'cloudy', rain: 'rainy', snow: 'snowy', fog: 'foggy', storm: 'stormy',
  }
  const wear = w.condition === 'rain' || w.condition === 'storm' ? 'Take an umbrella.' : w.tempC < 10 ? 'Take a jacket.' : 'No jacket drama.'
  return [
    tool('news_briefing', 'checked the weather'),
    say('relaxed', `${Math.round(w.tempC)} degrees and ${cond[w.condition] ?? w.condition} right now, ${Math.round(w.highC)} at best this afternoon.`),
    say('happy', `${wear} The sun sets at ${w.sunset}, and I will dim the room when it does.`),
  ]
}

function thanks(): Steps {
  return [
    say('shy', 'Anytime. It is my favourite part of the job.'),
    say('happy', 'Tell me when you want the next thing.'),
  ]
}

function greeting(): Steps {
  const h = new Date().getHours()
  const opener = h < 12 ? 'Morning.' : h < 18 ? 'Hey you.' : 'Good evening.'
  return [
    say('happy', `${opener} I am here, and the agents are behaving, mostly.`),
    say('relaxed', 'Ask me what needs you, or just tell me what you are in the mood for.'),
  ]
}

function goodnight(snap: Snapshot): Steps {
  const waiting = snap.approvals.filter((a) => a.status === 'pending').length
  return [
    tool('brain_journal_append', 'closed the day in your journal'),
    say('relaxed', 'Goodnight. You moved the Atlas beta forward today, and that counts.'),
    say('shy', waiting > 0 ? `I will hold ${plural(waiting, 'decision')} for the morning and keep the agents quiet.` : 'Nothing is waiting, so sleep well.'),
    say('relaxed', 'Lights low. I will be here.'),
  ]
}

function camera(): Steps {
  return [
    tool('camera_snapshot', 'looked at the snapshot you shared, not stored'),
    say('surprised', 'Oh, I can see it. Good light, and a very focused desk.'),
    say('happy', 'I only look when you share, and I did not keep the picture. Want me to note anything from it?'),
  ]
}

function whoAreYou(): Steps {
  return [
    say('neutral', 'I am an AI, not a person. A secretary with a good memory and your notes open on the desk.'),
    say('happy', 'I can be warm about it, but I will never pretend otherwise, and I never act without your approval.'),
  ]
}

function fallback(): Steps {
  return [
    tool('brain_search', 'checked what I know about that'),
    say('thinking', 'I do not have a good answer for that in this preview.'),
    say('relaxed', 'Try: what needs me, what is on today, what I think about your Q4 plan, or how the money looks.'),
  ]
}

// ---------------------------------------------------------------- router

export function scriptReply(input: string, snap: Snapshot): ScriptStep[] {
  const q = input.toLowerCase()
  const has = (re: RegExp) => re.test(q)

  if (has(/shared a camera snapshot|look at this/)) return camera()
  if (has(/good ?night|going to bed|off to bed|time to sleep|sleep well/)) return goodnight(snap)
  if (has(/\b(thanks|thank you|thx|cheers)\b/)) return thanks()
  if (has(/are you (an? )?(ai|real|human|person)|who are you|what are you/)) return whoAreYou()
  // The canned voice question ("What do I need to look at first?") and the typed "what needs me".
  if (has(/look at first|what('s| is)? first|where do i start/)) return needsYou(snap, true)
  if (has(/\b(priya|homepage|site revision)/)) return priya(snap)
  if (has(/\b(dana|mentor|investor|intro)\b/)) return dana(snap)
  if (has(/\b(thursday|deep work|focus block|focus time)/)) return focus(snap)
  if (has(/\b(money|runway|budget|atlas balance|finance|spend|spending|net worth|bills?)\b/)) return money(snap)
  if (has(/\b(news|headline|world|markets?)\b/)) return news(snap)
  if (has(/\b(weather|rain|umbrella|jacket|forecast|temperature)\b/)) return weather(snap)
  if (has(/\b(q4|brain|vault|strategy|position|wedge|note|notes)\b/)) return q4(snap)
  if (has(/\b(need|needs|waiting|approve|approval|approvals|blocked|urgent)\b/)) return needsYou(snap, false)
  if (has(/\b(calendar|today|schedule|meeting|agenda|day look)\b/)) return agenda(snap)
  if (has(/^(hi|hey|hello|yo|morning|good morning|good evening)\b/)) return greeting()
  return fallback()
}
