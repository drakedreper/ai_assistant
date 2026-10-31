#!/usr/bin/env node
/**
 * Spike (b): a tiny, dependency-free receiver for Claude Code `http` hooks.
 *
 * It does only what the real daemon's hook endpoint must do, and nothing else:
 *   - binds to 127.0.0.1 (never 0.0.0.0);
 *   - checks a bearer token (Authorization: Bearer <SPIKE_HOOK_TOKEN>) and the Host header;
 *   - ALWAYS answers 200 with `{}` as soon as the request body has arrived, so a hook can never block
 *     or break a Claude Code session, whatever the payload or token. (The real daemon may return 401
 *     for a bad token, since a non-2xx reply is non-blocking; this spike answers 200 and records the
 *     failure instead, so you can see every delivery.)
 *   - appends one JSON line per delivery to results/hooks-log.jsonl, after the reply has been sent.
 *
 * Configuration (environment variables)
 *   SPIKE_HOOK_TOKEN   required. The bearer token. Must also be set in the shell that starts `claude`.
 *   SPIKE_PORT         default 7433.
 *   SPIKE_LOG          default ./results/hooks-log.jsonl next to this file.
 *   SPIKE_FULL=1       keep full tool_input / tool_response / prompt text in the log. Default: redacted to
 *                      type and size, because payloads can contain file contents and secrets.
 *   SPIKE_DELAY_MS     TEST ONLY. Delay the reply to simulate a hung receiver (see README, test 4).
 *
 * Run:  node receiver.mjs      Stop with Ctrl+C (prints a summary).
 */
import http from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST = '127.0.0.1'
const PORT = Number(process.env.SPIKE_PORT ?? 7433)
const TOKEN = process.env.SPIKE_HOOK_TOKEN
const DELAY_MS = Number(process.env.SPIKE_DELAY_MS ?? 0)
const FULL = process.env.SPIKE_FULL === '1'
const LOG = process.env.SPIKE_LOG ?? join(HERE, 'results', 'hooks-log.jsonl')
const MAX_BODY = 1_000_000 // bytes; anything larger is cut and flagged

if (!TOKEN || TOKEN.length < 16) {
  console.error('Set SPIKE_HOOK_TOKEN (at least 16 characters) in this shell before starting, for example in PowerShell:')
  console.error("  $env:SPIKE_HOOK_TOKEN = -join ((48..57) + (97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })")
  console.error('Then start `claude` from a shell where the same variable is set.')
  process.exit(2)
}

mkdirSync(dirname(LOG), { recursive: true })

const byEvent = new Map()
const sessions = new Set()
let count = 0
let unauthorized = 0
let firstAt = null
let lastAt = null

function safeEqual(a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Replace bulky or sensitive fields with their type and size unless SPIKE_FULL=1. */
function redact(payload) {
  if (FULL || payload === null || typeof payload !== 'object') return payload
  const out = { ...payload }
  for (const key of ['tool_input', 'tool_response', 'prompt', 'last_assistant_message']) {
    if (key in out) {
      const v = out[key]
      const size = typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length
      out[key] = { redacted: true, type: typeof v, approxChars: size }
    }
  }
  return out
}

function record(req, event, rawBody, truncated) {
  const receivedAt = new Date()
  const auth = req.headers.authorization ?? ''
  const authorized = auth.startsWith('Bearer ') && safeEqual(auth.slice(7), TOKEN)
  const host = (req.headers.host ?? '').toLowerCase()
  const hostOk = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`

  let payload = null
  let parseError = false
  if (authorized && rawBody) {
    try { payload = JSON.parse(rawBody) } catch { parseError = true }
  }
  if (!authorized) unauthorized++

  const name = payload?.hook_event_name ?? event
  const entry = {
    n: ++count,
    receivedAt: receivedAt.toISOString(),
    urlEvent: event,
    authorized,
    hostOk,
    parseError,
    truncated,
    bytes: rawBody.length,
    eventMismatch: payload?.hook_event_name ? payload.hook_event_name !== event : false,
    session_id: payload?.session_id,
    hook_event_name: payload?.hook_event_name,
    tool_name: payload?.tool_name,
    tool_use_id: payload?.tool_use_id,
    agent_id: payload?.agent_id,
    agent_type: payload?.agent_type,
    cwd: payload?.cwd,
    transcript_path: payload?.transcript_path,
    permission_mode: payload?.permission_mode,
    // Only authorised bodies are stored at all.
    payload: authorized ? redact(payload) : undefined,
  }
  appendFileSync(LOG, JSON.stringify(entry) + '\n')

  byEvent.set(name, (byEvent.get(name) ?? 0) + 1)
  if (payload?.session_id) sessions.add(payload.session_id)
  firstAt ??= receivedAt
  lastAt = receivedAt
  const t = receivedAt.toTimeString().slice(0, 8)
  const flag = authorized ? '' : '  [UNAUTHORIZED]'
  console.log(`${t}  ${String(name).padEnd(20)} ${String(payload?.session_id ?? '-').slice(0, 8).padEnd(9)} ${payload?.tool_name ?? ''}${flag}`)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }
  if (req.method === 'GET' && url.pathname === '/summary') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(summary(), null, 2))
    return
  }

  const m = /^\/hooks\/([A-Za-z]+)$/.exec(url.pathname)
  if (req.method !== 'POST' || !m) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  const event = m[1]

  const chunks = []
  let size = 0
  let truncated = false
  req.on('data', (c) => {
    size += c.length
    if (size <= MAX_BODY) chunks.push(c)
    else truncated = true
  })
  req.on('end', () => {
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      // Record after the reply so logging can never slow the hook down.
      setImmediate(() => record(req, event, Buffer.concat(chunks).toString('utf8'), truncated))
    }
    if (DELAY_MS > 0) setTimeout(reply, DELAY_MS)
    else reply()
  })
  req.on('error', () => { /* a dropped connection is not our problem */ })
})

function summary() {
  return {
    startedAt: firstAt?.toISOString() ?? null,
    lastDeliveryAt: lastAt?.toISOString() ?? null,
    total: count,
    unauthorized,
    distinctSessions: sessions.size,
    byEvent: Object.fromEntries([...byEvent.entries()].sort()),
    log: LOG,
  }
}

function shutdown() {
  const s = summary()
  console.log('\nSummary')
  console.log(JSON.stringify(s, null, 2))
  try { writeFileSync(join(dirname(LOG), 'hooks-summary.json'), JSON.stringify(s, null, 2)) } catch { /* ignore */ }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(PORT, HOST, () => {
  console.log(`Hook receiver listening on http://${HOST}:${PORT}  (log: ${LOG})`)
  console.log(`redaction ${FULL ? 'OFF (full payloads are logged)' : 'on'}; reply delay ${DELAY_MS} ms`)
  console.log('Waiting for hooks. Ctrl+C prints a summary.\n')
})
