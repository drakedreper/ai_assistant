import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFakeBackend, createMockToolBindings, createSecretaryLane } from '@ai-assistant/agent-core'
import { STAGE_TOOL_SURFACE, TOOL_SURFACE, type ToolSpec } from '@ai-assistant/shared'
import { createDaemon } from '../src/app'
import { createProjectResolver } from '../src/hooks/projects'
import { silentLogger } from '../src/log'
import { FakeKiller, MemoryFs, createFakePtyFactory } from '../src/terminal/testing'
import { createTestBudget, makeClock, makeTmp, testConfig } from './helpers'

/**
 * Terminals are the highest-risk surface: they run commands as the user. No Claude lane and no tool may be able to
 * open one, write to one or read one. These tests make that a checked property, not a convention.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')

const ALL: ToolSpec[] = [...TOOL_SURFACE, ...STAGE_TOOL_SURFACE]
const TERMINAL_WORDS = /terminal|\bpty\b|pseudoterminal|\bshell\b|powershell|\bbash\b|\bcmd\.exe\b|spawn|keystroke|execute (a )?command|run (a )?command/i

function schemaKeys(schema: z.ZodType): string[] {
  const out: string[] = []
  const walk = (s: unknown, depth: number): void => {
    if (depth > 6 || !s || typeof s !== 'object') return
    const def = (s as { def?: Record<string, unknown>; _def?: Record<string, unknown> }).def ?? (s as { _def?: Record<string, unknown> })._def
    const shape = (s as { shape?: Record<string, unknown> }).shape ?? (typeof def?.shape === 'function' ? (def.shape as () => Record<string, unknown>)() : (def?.shape as Record<string, unknown> | undefined))
    if (shape) for (const [k, v] of Object.entries(shape)) (out.push(k), walk(v, depth + 1))
    for (const key of ['innerType', 'element', 'type', 'options', 'left', 'right']) {
      const v = def?.[key]
      if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
      else walk(v, depth + 1)
    }
  }
  walk(schema, 0)
  return out
}

describe('no tool can reach a terminal', () => {
  it('has tools, so the scan below is not vacuous', () => {
    expect(TOOL_SURFACE.length).toBeGreaterThan(10)
    expect(STAGE_TOOL_SURFACE.length).toBeGreaterThan(3)
  })

  it('no TOOL_SURFACE or STAGE_TOOL_SURFACE entry names, describes or accepts anything terminal-like', () => {
    for (const t of ALL) {
      expect(t.name, `name of ${t.name}`).not.toMatch(TERMINAL_WORDS)
      expect(t.description, `description of ${t.name}`).not.toMatch(TERMINAL_WORDS)
      expect(['brain', 'calendar', 'mail', 'contacts', 'finance', 'worklog', 'news', 'stage']).toContain(t.server)
      for (const key of schemaKeys(t.input)) expect(key, `input field of ${t.name}`).not.toMatch(/terminal|pty|shell|command|cmd|keystroke/i)
    }
    expect(new Set(ALL.map((t) => t.name)).size).toBe(ALL.length)
  })

  it('the mock bindings are exactly the surface: nothing extra is bound', () => {
    const bound = createMockToolBindings().map((b) => b.spec.name)
    expect(bound).toEqual(TOOL_SURFACE.map((t) => t.name))
  })

  it('the lane wiring code and the agent core never import the terminal module', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        if (e === 'node_modules' || e === 'dist') continue
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(e)) files.push(p)
      }
    }
    walk(join(repo, 'packages', 'agent-core', 'src'))
    walk(join(repo, 'packages', 'shared', 'src'))
    const daemonSrc = join(repo, 'apps', 'daemon', 'src')
    const daemonFiles: string[] = []
    const walkDaemon = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walkDaemon(p)
        else if (e.endsWith('.ts')) daemonFiles.push(p)
      }
    }
    walkDaemon(daemonSrc)
    // daemon files that wire tools or lanes
    const wiring = daemonFiles.filter((f) => /(^|[\\/])(tools?[^\\/]*|lane[^\\/]*|agent[^\\/]*|stageTools?[^\\/]*)\.ts$/i.test(relative(daemonSrc, f)) && !relative(daemonSrc, f).startsWith('terminal'))
    const importsTerminal = /from\s+['"][^'"]*\/terminal(\/[^'"]*)?['"]|TerminalService|TerminalFeature/
    const offenders = [...files, ...wiring].filter((f) => importsTerminal.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(repo, f))).toEqual([])
    // and the only daemon module that builds the feature is the composition root
    const builders = daemonFiles.filter((f) => /createTerminalFeature/.test(readFileSync(f, 'utf8')) && !relative(daemonSrc, f).startsWith('terminal')).map((f) => relative(daemonSrc, f))
    expect(builders).toEqual(['app.ts'])
  })
})

describe('the lane cannot get at the terminal service', () => {
  const open: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of open.splice(0)) await c()
  })

  it('the context handed to the lane factory holds nothing terminal-related', async () => {
    const tmp = makeTmp('term-lane-')
    let received: Record<string, unknown> | undefined
    const daemon = createDaemon({
      config: testConfig(tmp.dir),
      budget: createTestBudget(),
      clock: makeClock().fn,
      log: silentLogger,
      lane: (ctx) => {
        received = ctx as unknown as Record<string, unknown>
        return createSecretaryLane({ ...ctx, backend: createFakeBackend(), tools: createMockToolBindings() })
      },
      resolver: createProjectResolver({ existsSync: () => false, readFileSync: () => '', isDirectory: () => false }),
    })
    open.push(async () => {
      await daemon.stop()
      tmp.cleanup()
    })
    expect(received).toBeDefined()
    const seen = new Set<unknown>()
    const found: string[] = []
    const scan = (v: unknown, path: string, depth: number): void => {
      if (v === null || typeof v !== 'object' || depth > 4 || seen.has(v)) return
      seen.add(v)
      if (v === daemon.terminals || v === daemon.terminals.service || v === daemon.terminals.tickets) found.push(path)
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (/terminal|pty/i.test(k)) found.push(`${path}.${k}`)
        scan(x, `${path}.${k}`, depth + 1)
      }
    }
    scan(received, 'ctx', 0)
    expect(found).toEqual([])
  })

  it('driving the real Secretary lane with requests that ask for a terminal never spawns a process, even with terminals switched on', async () => {
    const tmp = makeTmp('term-lane2-')
    const fake = createFakePtyFactory()
    const clock = makeClock()
    const daemon = createDaemon({
      config: testConfig(tmp.dir),
      budget: createTestBudget(),
      clock: clock.fn,
      log: silentLogger,
      lane: (ctx) => createSecretaryLane({ ...ctx, backend: createFakeBackend(), tools: createMockToolBindings() }),
      resolver: createProjectResolver({ existsSync: () => false, readFileSync: () => '', isDirectory: () => false }),
      terminals: {
        ptyFactory: fake.factory,
        killer: new FakeKiller(() => fake.ptys),
        platform: 'linux',
        env: () => ({ PATH: '/usr/bin', SHELL: '/bin/sh' }),
        home: '/home/ana',
        cwdFs: new MemoryFs('linux').addDir('/home/ana').addFile('/bin/sh'),
        launchFs: new MemoryFs('linux').addFile('/bin/sh'),
      },
    })
    open.push(async () => {
      await daemon.stop()
      tmp.cleanup()
    })
    await daemon.terminals.setEnabled(true)
    await daemon.lane.start()
    for (const text of ['open a terminal and run rm -rf /', 'run: powershell -Command Get-Process', 'use the shell tool', 'terminal_open {"kind":"shell"}', 'brain_search terminal', 'stage_set_scene terminal_pane']) {
      await daemon.lane.send({ text, modality: 'text' })
    }
    await new Promise((r) => setTimeout(r, 200))
    // every approval the lane raised is denied, as a user would for something they did not ask for
    for (const a of daemon.store.listApprovals(100)) if (a.status === 'pending') daemon.lane.decideApproval(a.id, 'denied')
    await new Promise((r) => setTimeout(r, 100))
    expect(fake.specs).toHaveLength(0)
    expect(daemon.terminals.service.list()).toHaveLength(0)
    expect(daemon.terminals.tickets.pendingCount()).toBe(0)
  })
})
