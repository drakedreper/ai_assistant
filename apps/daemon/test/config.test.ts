import { describe, expect, it } from 'vitest'
import { DEFAULT_DAEMON_PORT } from '@ai-assistant/shared'
import { ConfigError, describeConfig, loadConfig, resolveDataDir } from '../src/config'

const linux = { platform: 'linux' as const, homedir: '/home/ada', exists: () => false, moduleDir: '/repo/apps/daemon/src' }
const win = { platform: 'win32' as const, homedir: 'C:\\Users\\ada', exists: () => false, moduleDir: 'C:\\repo\\apps\\daemon\\src' }

describe('loadConfig', () => {
  it('has safe defaults: fake backend, api-key auth, default port, loopback only, not demo', () => {
    const c = loadConfig({}, linux)
    expect(c.port).toBe(DEFAULT_DAEMON_PORT)
    expect(c.port).toBe(7421)
    expect(c.host).toBe('127.0.0.1')
    expect(c.backend).toBe('fake')
    expect(c.authMode).toBe('api-key')
    expect(c.demo).toBe(false)
    expect(c.apiKey).toBeUndefined()
    expect(c.claudeExecutable).toBeUndefined()
    expect(c.allowedDevOrigins).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173'])
    expect(c.dbFile.endsWith('app.db')).toBe(true)
  })

  it('resolves the data dir per platform', () => {
    expect(loadConfig({}, linux).dataDir).toBe('/home/ada/.local/share/ai-assistant')
    expect(loadConfig({ XDG_DATA_HOME: '/data/xdg' }, linux).dataDir).toBe('/data/xdg/ai-assistant')
    expect(loadConfig({ APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, win).dataDir).toBe('C:\\Users\\ada\\AppData\\Roaming\\ai-assistant')
    expect(loadConfig({}, win).dataDir).toBe('C:\\Users\\ada\\AppData\\Roaming\\ai-assistant'.replace('Roaming', 'Roaming'))
    expect(resolveDataDir({ DATA_DIR: '/srv/mira' }, 'linux', '/home/ada')).toBe('/srv/mira')
    expect(resolveDataDir({ DATA_DIR: 'D:\\mira', APPDATA: 'C:\\x' }, 'win32', 'C:\\Users\\ada')).toBe('D:\\mira')
  })

  it('reads the backend, auth mode, port and executable from the environment', () => {
    const c = loadConfig({ CLAUDE_BACKEND: 'SDK', CLAUDE_AUTH_MODE: 'local-login', DAEMON_PORT: '8123', CLAUDE_EXECUTABLE: 'C:\\Tools\\claude.exe' }, linux)
    expect(c.backend).toBe('sdk')
    expect(c.authMode).toBe('local-login')
    expect(c.port).toBe(8123)
    expect(c.claudeExecutable).toBe('C:\\Tools\\claude.exe')
  })

  it('rejects invalid values with a ConfigError that does not echo secrets', () => {
    expect(() => loadConfig({ CLAUDE_BACKEND: 'maybe' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ CLAUDE_AUTH_MODE: 'oauth' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ DAEMON_PORT: '0' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ DAEMON_PORT: '70000' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ DAEMON_PORT: 'abc' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ DAEMON_PORT: '80.5' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ LOG_LEVEL: 'loud' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ DEV_ORIGINS: 'ftp://x' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ DEV_ORIGINS: 'not a url' }, linux)).toThrow(ConfigError)
    expect(() => loadConfig({ BUDGET_GLOBAL_USD: '-1' }, linux)).toThrow(ConfigError)
    try {
      loadConfig({ CLAUDE_BACKEND: 'x', ANTHROPIC_API_KEY: 'sk-ant-secret-secret' }, linux)
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('sk-ant')
    }
  })

  it('DEMO switches to a separate demo database', () => {
    expect(loadConfig({ DEMO: '1' }, linux).demo).toBe(true)
    expect(loadConfig({ DEMO: 'true' }, linux).demo).toBe(true)
    expect(loadConfig({ DEMO: '0' }, linux).demo).toBe(false)
    expect(loadConfig({ DEMO: '1' }, linux).dbFile.endsWith('demo.db')).toBe(true)
    expect(loadConfig({ DEMO: '1' }, win).dbFile).toBe('C:\\Users\\ada\\AppData\\Roaming\\ai-assistant\\demo.db')
  })

  it('reads ANTHROPIC_API_KEY but never exposes it through serialization or the described summary', () => {
    const key = 'sk-ant-api03-THIS-MUST-NEVER-BE-LOGGED'
    const c = loadConfig({ ANTHROPIC_API_KEY: key }, linux)
    expect(c.apiKey).toBe(key)
    expect(JSON.stringify(c)).not.toContain('THIS-MUST-NEVER')
    expect(JSON.stringify(describeConfig(c))).not.toContain('THIS-MUST-NEVER')
    expect(describeConfig(c).keySet).toBe(true)
    expect(Object.keys(c)).not.toContain('apiKey')
    expect(loadConfig({ ANTHROPIC_API_KEY: '   ' }, linux).apiKey).toBeUndefined()
  })

  it('uses apps/web/dist only when index.html exists there', () => {
    const present = loadConfig({}, { ...linux, exists: (p) => p.endsWith('index.html') })
    expect(present.webDist?.replace(/\\/g, '/')).toBe('/repo/apps/web/dist')
    expect(loadConfig({}, linux).webDist).toBeUndefined()
    const custom = loadConfig({ WEB_DIST: '/srv/web' }, { ...linux, exists: (p) => p === '/srv/web/index.html' })
    expect(custom.webDist).toBe('/srv/web')
  })

  it('accepts custom dev origins and normalises them', () => {
    const c = loadConfig({ DEV_ORIGINS: 'http://localhost:4000/, http://127.0.0.1:4000' }, linux)
    expect(c.allowedDevOrigins).toEqual(['http://localhost:4000', 'http://127.0.0.1:4000'])
  })

  it('has sane staleness defaults and allows overriding them', () => {
    const d = loadConfig({}, linux)
    expect(d.staleRunningMs).toBe(10 * 60_000)
    expect(d.staleIdleMs).toBe(6 * 3_600_000)
    const c = loadConfig({ STALE_RUNNING_MINUTES: '3' }, linux)
    expect(c.staleRunningMs).toBe(180_000)
  })
})
