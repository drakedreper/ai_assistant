#!/usr/bin/env node
/**
 * Live smoke test for the REAL Claude Agent SDK backend. It is NOT part of the test suite and it spends real tokens
 * (a few cents at most: the session is capped by SMOKE_BUDGET, default 0.25 USD). A human runs it once, on the PC
 * that has the key, to check the things the offline tests cannot: that the SDK accepts the options we pass, that
 * streaming deltas arrive, that our in-process MCP tools are callable, that canUseTool reaches us and that
 * interrupt() ends a turn.
 *
 * Run from the repository root (tsx runs the TypeScript sources directly):
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx packages/agent-core/scripts/live-smoke.mjs "What is on my calendar today?"
 *
 * Environment
 *   ANTHROPIC_API_KEY   required in the default api-key mode. Never printed.
 *   SMOKE_AUTH=local-login  use your own logged-in `claude` binary instead of a key (no key is injected, no
 *                       credential file is read). SMOKE_CLAUDE_EXE=<path> points at the binary.
 *   SMOKE_MODEL         default claude-sonnet-5-5
 *   SMOKE_EFFORT        low | medium | high (default low)
 *   SMOKE_BUDGET        hard cap for the session in USD (default 0.25)
 *   SMOKE_APPROVE=1     approve permission requests (default: deny them, which is the safe answer)
 *   SMOKE_INTERRUPT_MS  interrupt the turn after this many milliseconds (tests barge-in)
 *   SMOKE_TIMEOUT_MS    give up after this long (default 90000)
 *
 * What to look for in the output: a `session` line, `delta` lines whose text begins with an emotion tag, a
 * `tool_start`/`tool_end` pair for the calendar question, an `approval?` line when you ask it to send an email
 * ("send the reply to Priya"), and a final `turn_end` with a small cost. The tool results come from the mock
 * fixtures, so nothing real is read or sent.
 */
import { createMockToolBindings, createSdkBackend, buildStablePrompt, EmotionStreamParser } from '../src/index.ts'
import { buildSnapshot } from '@ai-assistant/shared/fixtures'

const message = process.argv.slice(2).join(' ').trim() || 'Good morning! What is on my calendar today?'
const authMode = process.env.SMOKE_AUTH === 'local-login' ? 'local-login' : 'api-key'
const apiKey = process.env.ANTHROPIC_API_KEY

if (authMode === 'api-key' && !apiKey) {
  console.error('ANTHROPIC_API_KEY is not set. Set it (or use SMOKE_AUTH=local-login) and run again.')
  process.exit(2)
}

const approve = process.env.SMOKE_APPROVE === '1'
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000)
const interruptMs = process.env.SMOKE_INTERRUPT_MS ? Number(process.env.SMOKE_INTERRUPT_MS) : undefined
const short = (value, max = 120) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const settings = buildSnapshot(new Date()).settings
const tools = createMockToolBindings().filter((b) => b.spec.lanes.includes('secretary') && !b.spec.locked)

const backend = createSdkBackend({ permissionTimeoutMs: 60_000 })
console.log(`# opening a ${authMode} session with ${tools.length} mock tools (cap ${process.env.SMOKE_BUDGET ?? '0.25'} USD)`)

const session = await backend.open({
  lane: 'secretary',
  systemPrompt: buildStablePrompt(settings.persona),
  model: process.env.SMOKE_MODEL ?? 'claude-sonnet-5-5',
  effort: process.env.SMOKE_EFFORT ?? 'low',
  cwd: process.cwd(),
  tools,
  authMode,
  maxBudgetUsd: Number(process.env.SMOKE_BUDGET ?? 0.25),
  ...(authMode === 'api-key' ? { apiKey } : {}),
  ...(authMode === 'local-login' && process.env.SMOKE_CLAUDE_EXE ? { claudeExecutable: process.env.SMOKE_CLAUDE_EXE } : {}),
})

const parser = new EmotionStreamParser()
let exitCode = 0
const watchdog = setTimeout(async () => {
  console.error(`# no result after ${timeoutMs} ms: interrupting and closing`)
  exitCode = 1
  await session.interrupt().catch(() => undefined)
  await session.close().catch(() => undefined)
}, timeoutMs)

if (interruptMs) setTimeout(() => session.interrupt().then(() => console.log('# interrupt() sent')), interruptMs)

console.log(`> ${message}`)
session.send({ text: message, modality: 'text' })

for await (const ev of session.events) {
  switch (ev.type) {
    case 'session':
      console.log(`session ${ev.sessionId}`)
      break
    case 'text_delta':
      console.log(`delta   ${JSON.stringify(ev.text)}`)
      for (const p of parser.push(ev.text)) {
        if (p.type === 'emotion') console.log(`        emotion -> ${p.emotion}`)
        if (p.type === 'sentence') console.log(`        speak [${p.emotion}] ${p.text}`)
      }
      break
    case 'tool_start':
      console.log(`tool_start ${ev.tool} ${short(ev.input)}`)
      break
    case 'tool_end':
      console.log(`tool_end   ${ev.toolUseId} ok=${ev.ok}${ev.summary ? ` (${ev.summary})` : ''}`)
      break
    case 'permission_request':
      console.log(`approval?  ${ev.tool} ${short(ev.input)} -> ${approve ? 'approving' : 'denying'}`)
      session.resolvePermission(ev.requestId, approve ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied by the smoke test.' })
      break
    case 'turn_end':
      for (const p of parser.flush()) if (p.type === 'sentence') console.log(`        speak [${p.emotion}] ${p.text}`)
      console.log(`turn_end   cost=${ev.costUsd ?? 'n/a'} usd (API-equivalent estimate) usage=${short(ev.usage ?? {})}${ev.interrupted ? ' INTERRUPTED' : ''}`)
      break
    case 'error':
      console.log(`error      kind=${ev.kind ?? 'n/a'} retryable=${ev.retryable} ${short(ev.message, 200)}`)
      exitCode = 1
      break
  }
  if (ev.type === 'turn_end' || ev.type === 'error') break
}

clearTimeout(watchdog)
await session.close()
console.log(exitCode === 0 ? '# OK' : '# finished with problems')
process.exit(exitCode)
