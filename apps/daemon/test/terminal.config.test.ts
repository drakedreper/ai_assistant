import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config'

const ctx = { platform: 'linux' as const, homedir: '/home/test', exists: () => false, moduleDir: '/nowhere' }
const load = (env: Record<string, string>) => loadConfig({ DATA_DIR: '/tmp/x', ...env }, ctx)

describe('terminal configuration', () => {
  it('has safe defaults', () => {
    const t = load({}).terminals
    expect(t).toMatchObject({
      maxTerminals: 4,
      idleTimeoutMs: 240 * 60_000,
      scrollbackBytes: 256 * 1024,
      maxInputFrameBytes: 64 * 1024,
      ticketTtlMs: 30_000,
      authTimeoutMs: 5_000,
    })
    expect(t.claudeCommandOverride).toBeUndefined()
    expect(t.allowDevOrigins).toBe(false)
    expect(t.inputBurstBytes).toBeGreaterThan(t.maxInputFrameBytes)
    expect(t.maxBufferedBytes).toBeGreaterThan(t.maxInputFrameBytes)
  })

  it('reads the three limits and the test override', () => {
    const t = load({ TERMINAL_MAX: '2', TERMINAL_IDLE_MINUTES: '10', TERMINAL_SCROLLBACK_KB: '64', TERMINAL_CLAUDE_COMMAND: ' ["node","x.js"] ' }).terminals
    expect(t).toMatchObject({ maxTerminals: 2, idleTimeoutMs: 600_000, scrollbackBytes: 64 * 1024, claudeCommandOverride: '["node","x.js"]' })
  })

  it('TERMINAL_ALLOW_DEV_ORIGINS is an explicit opt-in', () => {
    expect(load({ TERMINAL_ALLOW_DEV_ORIGINS: '1' }).terminals.allowDevOrigins).toBe(true)
    expect(load({ TERMINAL_ALLOW_DEV_ORIGINS: 'false' }).terminals.allowDevOrigins).toBe(false)
  })

  it('refuses nonsense with a ConfigError that names the variable', () => {
    for (const [name, value] of [['TERMINAL_MAX', '0'], ['TERMINAL_MAX', '17'], ['TERMINAL_MAX', '2.5'], ['TERMINAL_MAX', 'many'], ['TERMINAL_IDLE_MINUTES', '0'], ['TERMINAL_SCROLLBACK_KB', '8'], ['TERMINAL_SCROLLBACK_KB', '99999'], ['TERMINAL_SCROLLBACK_KB', '100.5']] as const) {
      expect(() => load({ [name]: value }), `${name}=${value}`).toThrowError(ConfigError)
      expect(() => load({ [name]: value }), `${name}=${value}`).toThrowError(new RegExp(name))
    }
  })

  it('terminals stay off until switched on: there is no environment variable that enables them', () => {
    const t = load({ TERMINALS: '1', TERMINAL_ENABLED: '1', TERMINALS_ENABLED: 'true' }) as unknown as Record<string, unknown>
    expect(JSON.stringify(t)).not.toMatch(/enabled/i)
  })
})
