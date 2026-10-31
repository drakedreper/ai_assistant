#!/usr/bin/env node
/**
 * Spike (a): time to first token (TTFT).
 *
 * Question: is a persistent Agent SDK streaming session fast enough for a voice loop, compared with a
 * direct Messages API call to the same model at the same effort with the same system prompt?
 * Gate (from docs/PLAN.md): SDK-session p50 TTFT of about 1.2 s or better. Over it, add the Voice lane.
 *
 * What it does
 *   1. direct:  POST https://api.anthropic.com/v1/messages with stream=true (plain fetch, no dependency)
 *               and times request-send to the first text_delta.
 *   2. sdk:     starts ONE long-lived query() with streaming input (a push-style async iterable), sends the
 *               same utterances one at a time, and times push-to-first text_delta for each turn.
 *   Turn 1 of each path is a warm-up (it includes process spawn for the SDK and cache writes for both) and
 *   is reported separately, not in p50/p95.
 *
 * Needs (only when YOU run it): Node >= 22, ANTHROPIC_API_KEY in the environment, network access, and for
 * the sdk path `npm install` in this folder. It makes about 2 x (turns + warmup) small API calls: cents.
 * It never writes the key anywhere and never runs on import.
 *
 * Usage
 *   node ttft.mjs                       # both paths, 12 measured turns after 2 warm-ups
 *   node ttft.mjs --only direct         # no SDK install needed
 *   node ttft.mjs --turns 20 --gap-ms 2000 --json results/ttft-run1.json
 *   node ttft.mjs --system preset       # SDK uses the claude_code preset + persona append (heavier prompt)
 *   node ttft.mjs --model claude-sonnet-5-5 --effort medium
 *
 * Caveats to check against the current docs when you run it (names changed across SDK versions):
 *   - the `output_config.effort` request field (direct path) and the `effort` SDK option;
 *   - the SDKUserMessage shape and the option that disables built-in tools (`tools` / `allowedTools`);
 *   If the API or SDK rejects a field, fix the one line and note it in your results: the comparison is only
 *   meaningful when both paths use the same model, effort and system prompt.
 */
import { performance } from 'node:perf_hooks'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE_P50_MS = 1200
const ANTHROPIC_VERSION = '2023-06-01'

const UTTERANCES = [
  'Good morning. What is the first thing I should know today?',
  'Remind me why we picked a local-first design.',
  'Give me one sentence on how to start a hard task.',
  'Suggest a name for a small grey cat. Just one.',
  'Say something encouraging, briefly.',
  'How long should a focus block be?',
  'What is a kind way to say no to a meeting?',
  'Describe a good evening routine in one line.',
  'Why do backups matter?',
  'Pick a colour for a cosy study and say why.',
  'What should I do when I feel stuck?',
  'Give me a quick tip for writing clear email.',
  'Say goodnight in your own words.',
  'What is one small win I can get in ten minutes?',
]

// ---------- args ----------
function parseArgs(argv) {
  const o = { turns: 12, warmup: 2, gapMs: 1500, model: 'claude-haiku-5-5', effort: 'low', system: 'string', only: 'both', json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--turns') o.turns = Number(next())
    else if (a === '--warmup') o.warmup = Number(next())
    else if (a === '--gap-ms') o.gapMs = Number(next())
    else if (a === '--model') o.model = next()
    else if (a === '--effort') o.effort = next()
    else if (a === '--system') o.system = next()
    else if (a === '--only') o.only = next()
    else if (a === '--json') o.json = next()
    else if (a === '--help' || a === '-h') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0) }
    else throw new Error(`Unknown argument: ${a}`)
  }
  if (!['both', 'direct', 'sdk'].includes(o.only)) throw new Error('--only must be both, direct or sdk')
  if (!['string', 'preset'].includes(o.system)) throw new Error('--system must be string or preset')
  return o
}

// ---------- stats ----------
function pct(sorted, p) {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}
function summarize(label, values) {
  const s = [...values].sort((a, b) => a - b)
  return { label, n: s.length, p50: pct(s, 50), p95: pct(s, 95), min: s[0] ?? NaN, max: s[s.length - 1] ?? NaN }
}
const ms = (v) => (Number.isFinite(v) ? `${v.toFixed(0)} ms` : 'n/a')

// ---------- direct Messages API path ----------
async function directTurn(history, userText, o, systemText) {
  const body = {
    model: o.model,
    max_tokens: 120,
    stream: true,
    // cache_control lets the persona prefix be cached after the first call (minimum prefix is 512 tokens).
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: [...history, { role: 'user', content: userText }],
    output_config: { effort: o.effort },
  }
  const t0 = performance.now()
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  })
  const tHeaders = performance.now() - t0
  if (!res.ok) throw new Error(`Messages API ${res.status}: ${(await res.text()).slice(0, 300)}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let firstEvent = null
  let firstText = null
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = raw.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      let evt
      try { evt = JSON.parse(line.slice(5).trim()) } catch { continue }
      if (evt.type === 'content_block_delta') {
        const now = performance.now() - t0
        firstEvent ??= now
        if (evt.delta?.type === 'text_delta') {
          firstText ??= now
          text += evt.delta.text
        }
      }
    }
  }
  return { firstText, firstEvent, headers: tHeaders, total: performance.now() - t0, text }
}

async function runDirect(o, systemText, utterances) {
  const history = []
  const rows = []
  for (let i = 0; i < utterances.length; i++) {
    const r = await directTurn(history, utterances[i], o, systemText)
    history.push({ role: 'user', content: utterances[i] }, { role: 'assistant', content: r.text || '(empty)' })
    rows.push({ turn: i + 1, warmup: i < o.warmup, ...r })
    console.log(`direct turn ${String(i + 1).padStart(2)}${i < o.warmup ? ' (warm-up)' : '           '} first text ${ms(r.firstText)}  headers ${ms(r.headers)}  total ${ms(r.total)}`)
    if (i < utterances.length - 1) await sleep(o.gapMs)
  }
  return rows
}

// ---------- Agent SDK persistent-session path ----------
async function runSdk(o, systemText, utterances) {
  // Dynamic import so `--only direct` works without installing the SDK.
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  // Push-style async iterable = streaming input mode (one long-lived session).
  const queue = []
  let wake = null
  let closed = false
  let sessionId = ''
  const input = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0) {
            if (closed) return { value: undefined, done: true }
            await new Promise((r) => { wake = r })
          }
          return { value: queue.shift(), done: false }
        },
        async return() { closed = true; return { value: undefined, done: true } },
      }
    },
  }
  const push = (text) => {
    // Shape follows the SDK's streaming-input docs; verify against the reference for the pinned version.
    queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId })
    wake?.()
    wake = null
  }

  const q = query({
    prompt: input,
    options: {
      model: o.model,
      effort: o.effort, // if your SDK version has no such option it is ignored; then results are NOT like for like
      systemPrompt: o.system === 'preset'
        ? { type: 'preset', preset: 'claude_code', append: systemText }
        : systemText,
      settingSources: [], // no CLAUDE.md, skills, user hooks or project settings: the leanest session
      includePartialMessages: true, // stream_event / content_block_delta / text_delta
      allowedTools: [],
      tools: [], // disable built-in tools so the request is comparable to the direct call
    },
  })
  const it = q[Symbol.asyncIterator]()

  const rows = []
  for (let i = 0; i < utterances.length; i++) {
    const t0 = performance.now()
    push(utterances[i])
    let firstText = null
    let firstEvent = null
    let text = ''
    for (;;) {
      const { value: msg, done } = await it.next()
      if (done) throw new Error('SDK stream ended before a result message')
      if (msg.session_id && !sessionId) sessionId = msg.session_id
      if (msg.type === 'stream_event') {
        const e = msg.event
        if (e?.type === 'content_block_delta') {
          const now = performance.now() - t0
          firstEvent ??= now
          if (e.delta?.type === 'text_delta') {
            firstText ??= now
            text += e.delta.text
          }
        }
      } else if (msg.type === 'result') {
        if (msg.is_error) throw new Error(`SDK result error: ${msg.subtype ?? 'unknown'}`)
        rows.push({ turn: i + 1, warmup: i < o.warmup, firstText, firstEvent, total: performance.now() - t0, text, costUsd: msg.total_cost_usd })
        console.log(`sdk    turn ${String(i + 1).padStart(2)}${i < o.warmup ? ' (warm-up)' : '           '} first text ${ms(firstText)}  total ${ms(performance.now() - t0)}`)
        break
      }
    }
    if (i < utterances.length - 1) await sleep(o.gapMs)
  }

  closed = true
  wake?.()
  try { await q.interrupt?.() } catch { /* session already idle */ }
  try { await it.return?.() } catch { /* ignore */ }
  return rows
}

// ---------- main ----------
async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set. Set it in this shell only, for example in PowerShell:')
    console.error('  $env:ANTHROPIC_API_KEY = Read-Host "key"   (or paste it; never write it into a file)')
    process.exit(2)
  }
  const systemText = readFileSync(join(HERE, 'persona-prompt.txt'), 'utf8').trim()
  if (systemText.length < 2400) console.warn('Warning: persona-prompt.txt is short; prompts under about 512 tokens are not cached, which changes the comparison.')

  const total = o.warmup + o.turns
  if (total > UTTERANCES.length) {
    // Recycle utterances if more turns were requested than we have.
    while (UTTERANCES.length < total) UTTERANCES.push(...UTTERANCES)
  }
  const utterances = UTTERANCES.slice(0, total)

  console.log(`model ${o.model}, effort ${o.effort}, system ${o.system}, ${o.warmup} warm-up + ${o.turns} measured turns, gap ${o.gapMs} ms\n`)

  const out = { startedAt: new Date().toISOString(), options: o, node: process.version, platform: process.platform, direct: null, sdk: null }
  if (o.only !== 'sdk') out.direct = await runDirect(o, systemText, utterances)
  if (o.only !== 'direct') out.sdk = await runSdk(o, systemText, utterances)

  const stats = []
  const measured = (rows) => rows.filter((r) => !r.warmup && r.firstText != null).map((r) => r.firstText)
  const warm = (rows) => rows.filter((r) => r.warmup && r.firstText != null).map((r) => r.firstText)
  if (out.direct) stats.push(summarize('direct Messages API', measured(out.direct)))
  if (out.sdk) stats.push(summarize('persistent Agent SDK session', measured(out.sdk)))

  console.log('\nTime to first text token (measured turns only)')
  console.log('path                            n      p50       p95       min       max')
  for (const s of stats) {
    console.log(`${s.label.padEnd(30)} ${String(s.n).padStart(3)}  ${ms(s.p50).padStart(8)}  ${ms(s.p95).padStart(8)}  ${ms(s.min).padStart(8)}  ${ms(s.max).padStart(8)}`)
  }
  if (out.direct) console.log(`warm-up turns (direct): ${warm(out.direct).map(ms).join(', ')}`)
  if (out.sdk) console.log(`warm-up turns (sdk):    ${warm(out.sdk).map(ms).join(', ')}`)
  console.log('Note: with fewer than 20 samples p95 is close to the maximum; treat it as indicative.')

  const sdkStat = stats.find((s) => s.label.startsWith('persistent'))
  const directStat = stats.find((s) => s.label.startsWith('direct'))
  if (sdkStat && directStat) console.log(`\nSDK overhead at p50: ${ms(sdkStat.p50 - directStat.p50)}`)
  if (sdkStat) {
    const pass = sdkStat.p50 <= GATE_P50_MS
    console.log(`\nGATE: SDK-session p50 <= ${GATE_P50_MS} ms ... ${pass ? 'PASS' : 'FAIL'} (${ms(sdkStat.p50)})`)
    if (!pass) console.log('Result: add the Voice lane (direct Messages API, Haiku 5.5, low effort) in Phase 1, and keep the SDK for tool work.')
    else console.log('Result: the Secretary session can serve voice turns directly; the Voice lane stays off.')
  } else {
    console.log('\nGATE not evaluated (run without --only direct to measure the SDK path).')
  }

  if (o.json) {
    mkdirSync(dirname(o.json), { recursive: true })
    writeFileSync(o.json, JSON.stringify({ ...out, stats }, null, 2))
    console.log(`\nWrote ${o.json}`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`)
  process.exit(1)
})
