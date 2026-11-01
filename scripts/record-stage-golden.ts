/**
 * Records REAL stage traffic: starts the daemon in-process (the same harness the tests use: the real lane with the fake
 * Claude, the stage on), connects as a Unity-like stage over a real WebSocket with the stage token, answers every
 * command the way a stage must, sends a chat message, and writes what the backend sent to
 *
 *   unity/Packages/com.mira.stage/Tests~/golden/recorded/
 *     NNN-<command type>.json   every text frame, as received
 *     frames/NNN-audio.b64, NNN-face.b64   the first binary frames of each kind (base64), and frames/index.json
 *     manifest.json
 *
 * The C# tests replay these through the client, and apps/daemon/test/stage.golden.test.ts checks they still parse with
 * the current schema. Record again when the contract changes:
 *
 *   pnpm --filter @ai-assistant/daemon exec tsx ../../scripts/record-stage-golden.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { decodeFrame } from '../packages/stage-core/src/protocol/frames'
import { makeStageDaemon } from '../apps/daemon/src/stage/testing'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'unity/Packages/com.mira.stage/Tests~/golden/recorded')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const CAPABILITIES = {
  engine: 'unity',
  engineVersion: '6000.0.0f1',
  rigFamilies: ['vrm1'],
  face: { arkit52: true, visemes: false, audioToFaceOnStage: false },
  render: { strandHair: false, clothSim: false, runtimeAssetLoading: true, embeddedStream: false },
  tracking: { face: false, body: false },
  constructs: [],
  maxCharacters: 2,
}

async function main(): Promise<void> {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(path.join(out, 'frames'), { recursive: true })
  const dataDir = mkdtempSync(path.join(tmpdir(), 'record-golden-'))
  const d = await makeStageDaemon({ dataDir })
  const ws = new WebSocket(d.wsUrl, { headers: { Authorization: `Bearer ${d.stageToken}` }, perMessageDeflate: false })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const t0 = Date.now()
  const stageNow = () => Date.now() - t0
  const send = (o: unknown): void => ws.send(JSON.stringify(o))
  send({ type: 'hello', protocol: 'mira-stage/1', capabilities: CAPABILITIES, stageClockMs: stageNow() })

  let n = 0
  const files: string[] = []
  const frames: Array<{ file: string; kind: string; utteranceIdHash: number; tStartMs: number; bytes: number }> = []
  const kept = { audio: 0, face: 0 }
  const speaking = new Map<string, { totalMs: number | undefined; receivedMs: number; started: boolean; hash: number }>()

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const r = decodeFrame(data)
      if (!r.ok) return
      const kind = r.frame.kind === 1 ? 'audio' : r.frame.kind === 2 ? 'face' : 'body'
      if ((kind === 'audio' || kind === 'face') && kept[kind] < (kind === 'audio' ? 3 : 2)) {
        kept[kind]++
        const file = `${String(++n).padStart(3, '0')}-${kind}.b64`
        writeFileSync(path.join(out, 'frames', file), `${data.toString('base64')}\n`)
        frames.push({ file, kind, utteranceIdHash: r.frame.utteranceIdHash, tStartMs: r.frame.tStartMs, bytes: data.length })
      }
      // play it virtually, like a stage: speak.started on the first audio, speak.ended when all of it has arrived
      if (r.frame.kind === 1) {
        for (const [id, u] of speaking) {
          if (u.hash !== r.frame.utteranceIdHash) continue
          u.receivedMs += (r.frame.payload.byteLength / 2 / 24_000) * 1000
          if (!u.started) {
            u.started = true
            send({ type: 'speak.started', utteranceId: id, stageMs: stageNow() })
          }
          if (u.totalMs !== undefined && u.receivedMs + 1 >= u.totalMs) {
            speaking.delete(id)
            send({ type: 'speak.ended', utteranceId: id, stageMs: stageNow(), interrupted: false })
          }
        }
      }
      return
    }
    const text = data.toString('utf8')
    const cmd = JSON.parse(text) as { id: string; type: string; assets?: Array<{ id: string }>; asset?: { id: string }; utteranceId?: string; audio?: { totalMs?: number } }
    const file = `${String(++n).padStart(3, '0')}-${cmd.type}.json`
    files.push(file)
    writeFileSync(path.join(out, file), `${JSON.stringify(cmd, null, 2)}\n`)
    for (const a of [...(cmd.assets ?? []), ...(cmd.asset ? [cmd.asset] : [])]) send({ type: 'asset.loaded', assetId: a.id, ms: 5 })
    send({ type: 'command.done', id: cmd.id })
    if (cmd.type === 'perform.speak' && cmd.utteranceId) {
      const { fnv1a32 } = fnv
      speaking.set(cmd.utteranceId, { totalMs: cmd.audio?.totalMs, receivedMs: 0, started: false, hash: fnv1a32(cmd.utteranceId) })
    }
  })

  await sleep(2500) // the look: her, you, the void
  const chat = await d.call('/api/chat', { json: { text: 'Hello, what is on my calendar today?', modality: 'text' } })
  if (chat.status !== 202) throw new Error(`chat answered ${chat.status}`)
  await sleep(7000) // the performance

  ws.terminate()
  await d.stop()
  rmSync(dataDir, { recursive: true, force: true })
  writeFileSync(path.join(out, 'frames', 'index.json'), `${JSON.stringify(frames, null, 2)}\n`)
  writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify({ recordedAt: new Date().toISOString(), protocol: 'mira-stage/1', capabilitiesSent: CAPABILITIES, commands: files }, null, 2)}\n`)
  const types = [...new Set(files.map((f) => f.replace(/^\d+-|\.json$/g, '')))]
  console.log(`recorded ${files.length} commands (${types.join(', ')}) and ${frames.length} binary frames into ${path.relative(root, out)}`)
  console.log(`files: ${readdirSync(out).length} entries`)
  process.exit(0)
}

// FNV-1a 32, the utterance id hash of the binary frame header (packages/stage-core/src/protocol/frames.ts)
const fnv = {
  fnv1a32(s: string): number {
    let h = 0x811c9dc5
    for (const b of Buffer.from(s, 'utf8')) {
      h ^= b
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h >>> 0
  },
}

main().catch((e) => {
  console.error('ABORTED:', String((e as Error).message ?? e).slice(0, 400))
  process.exit(1)
})
