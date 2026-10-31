import { describe, expect, it } from 'vitest'
import { createMemoryTransportPair, createSimulatorStage, createVirtualTime, runStageConformance } from '../src'
import type { ConformanceHarness, MakeStage } from '../src'
import { T0 } from './helpers'

/** The simulator, exposed to the shared conformance suite exactly like an engine stage would be. */
export const makeSimHarness: MakeStage = (): ConformanceHarness => {
  const vt = createVirtualTime(T0)
  const pair = createMemoryTransportPair({ timers: vt.timers })
  const sim = createSimulatorStage({ transport: pair.stage, clock: vt.clock, timers: vt.timers, clockOffsetMs: 5000 })
  return {
    transport: pair.backend,
    clock: vt.clock,
    timers: vt.timers,
    start: () => sim.start(),
    advance: async (ms) => {
      vt.advance(ms)
      await Promise.resolve()
    },
    dispose: () => sim.stop(),
  }
}

runStageConformance(makeSimHarness, { describe, it, expect })

describe('conformance suite adapts to declared capabilities', () => {
  const limited = (caps: Parameters<typeof createSimulatorStage>[0]['capabilities']): MakeStage => () => {
    const vt = createVirtualTime(T0)
    const pair = createMemoryTransportPair({ timers: vt.timers })
    const sim = createSimulatorStage({ transport: pair.stage, clock: vt.clock, timers: vt.timers, capabilities: caps })
    return { transport: pair.backend, clock: vt.clock, timers: vt.timers, start: () => sim.start(), advance: async (ms) => { vt.advance(ms); await Promise.resolve() }, dispose: () => sim.stop() }
  }
  // A stage that draws no constructs, takes no backend face frames and supports one rig: still conformant.
  runStageConformance(limited({ constructs: [], rigFamilies: ['metahuman'], face: { arkit52: false, visemes: false, audioToFaceOnStage: true } }), { describe: (n, f) => describe(`limited stage: ${n}`, f), it, expect })
})

// ---------------------------------------------------------------------------------- the suite has teeth

/** Run the conformance suite outside the test runner and return what failed. */
async function runCollecting(make: MakeStage): Promise<{ passed: string[]; failed: string[] }> {
  const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
  const prefix: string[] = []
  runStageConformance(make, {
    describe: (n, f) => {
      prefix.push(n)
      f()
      prefix.pop()
    },
    it: (n, fn) => {
      tests.push({ name: `${prefix.join(' > ')} > ${n}`, fn })
    },
    expect: expect as never,
  })
  const passed: string[] = []
  const failed: string[] = []
  for (const t of tests) {
    try {
      await t.fn()
      passed.push(t.name)
    } catch {
      failed.push(t.name)
    }
  }
  return { passed, failed }
}

/** A simulator whose answers are rewritten on the way up, to impersonate a broken engine stage. */
function brokenStage(rewrite: (ev: Record<string, unknown>) => Record<string, unknown> | undefined): MakeStage {
  return () => {
    const vt = createVirtualTime(T0)
    const pair = createMemoryTransportPair({ timers: vt.timers })
    const sim = createSimulatorStage({ transport: pair.stage, clock: vt.clock, timers: vt.timers })
    const t = pair.backend
    const wrapped = {
      ...t,
      sendText: t.sendText.bind(t),
      sendBinary: t.sendBinary.bind(t),
      close: t.close.bind(t),
      onBinary: t.onBinary.bind(t),
      onText: (h: (d: string) => void) =>
        t.onText((raw) => {
          const out = rewrite(JSON.parse(raw) as Record<string, unknown>)
          if (out) h(JSON.stringify(out))
        }),
    }
    return { transport: wrapped, clock: vt.clock, timers: vt.timers, start: () => sim.start(), advance: async (ms: number) => { vt.advance(ms); await Promise.resolve() }, dispose: () => sim.stop() }
  }
}

describe('the conformance suite detects broken stages', () => {
  it('passes every test for the simulator', async () => {
    const r = await runCollecting(makeSimHarness)
    expect(r.failed).toEqual([])
    expect(r.passed.length).toBeGreaterThanOrEqual(15)
  })
  it('fails a stage that says "done" to commands it should have rejected', async () => {
    const r = await runCollecting(brokenStage((ev) => (ev.type === 'command.failed' ? { type: 'command.done', id: ev.id } : ev)))
    expect(r.failed.length).toBeGreaterThanOrEqual(3)
    expect(r.failed.some((n) => /invalid/.test(n))).toBe(true)
  })
  it('fails a stage that reports an interrupted utterance as finished normally', async () => {
    const r = await runCollecting(brokenStage((ev) => (ev.type === 'speak.ended' ? { ...ev, interrupted: false } : ev)))
    expect(r.failed.some((n) => /cancels mid-utterance/.test(n))).toBe(true)
  })
  it('fails a stage that never says hello, and one that speaks another protocol', async () => {
    const noHello = await runCollecting(brokenStage((ev) => (ev.type === 'hello' ? undefined : ev)))
    expect(noHello.failed.length).toBe(noHello.passed.length + noHello.failed.length)
    const wrong = await runCollecting(brokenStage((ev) => (ev.type === 'hello' ? { ...ev, protocol: 'mira-stage/9' } : ev)))
    expect(wrong.failed.length).toBeGreaterThan(0)
  })
  it('fails a stage that answers a command twice', async () => {
    const dup = brokenStage((ev) => ev)
    const twice: MakeStage = async () => {
      const h = await dup()
      const send = h.transport.onText.bind(h.transport)
      return { ...h, transport: { ...h.transport, onText: (fn: (d: string) => void) => send((d) => { fn(d); if (d.includes('command.done')) fn(d) }) } }
    }
    const r = await runCollecting(twice)
    expect(r.failed.some((n) => /exactly once/.test(n))).toBe(true)
  })
})
