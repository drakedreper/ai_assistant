import { describe, expect, it } from 'vitest'
import { buildTerminalEnv, isDaemonInternalVar } from '../src/terminal/env'

describe('isDaemonInternalVar', () => {
  it('removes the daemon namespaces, whatever follows', () => {
    for (const n of ['DAEMON_PORT', 'DAEMON_ANYTHING', 'AI_ASSISTANT_HOOK_TOKEN', 'AIA_X', 'MIRA_STAGE_TOKEN', 'mira_lowercase', 'daemon_port']) expect(isDaemonInternalVar(n), n).toBe(true)
  })
  it('removes every variable of the daemon configuration table', () => {
    for (const n of ['DATA_DIR', 'DEV_ORIGINS', 'WEB_DIST', 'CLAUDE_BACKEND', 'CLAUDE_AUTH_MODE', 'DEMO', 'LOG_LEVEL', 'RETENTION_DAYS', 'BUDGET_SECRETARY_USD', 'BUDGET_GLOBAL_USD', 'STALE_RUNNING_MINUTES', 'STALE_IDLE_MINUTES', 'TERMINAL_MAX', 'TERMINAL_IDLE_MINUTES', 'TERMINAL_SCROLLBACK_KB', 'TERMINAL_CLAUDE_COMMAND', 'ANTHROPIC_API_KEY']) {
      expect(isDaemonInternalVar(n), n).toBe(true)
    }
  })
  it('removes token-shaped names with a daemon-flavoured prefix', () => {
    for (const n of ['STAGE_TOKEN', 'HOOK_TOKEN', 'EXCHANGE_CODE', 'SESSION_TOKEN', 'COOKIE_SECRET', 'STAGE_AUTH_KEY', 'HOOK_SECRET', 'X_HOOK_TOKEN', 'MY_STAGE_TOKEN', 'APP_EXCHANGE_CODE', 'stage_token']) {
      expect(isDaemonInternalVar(n), n).toBe(true)
    }
  })
  it('removes the package manager\'s "inside an npm script" markers but keeps other npm settings', () => {
    for (const n of ['npm_lifecycle_event', 'npm_lifecycle_script', 'npm_package_name', 'npm_package_json', 'npm_command', 'npm_execpath', 'npm_node_execpath', 'npm_config_user_agent', 'INIT_CWD', 'PNPM_SCRIPT_SRC_DIR']) {
      expect(isDaemonInternalVar(n), n).toBe(true)
    }
    for (const n of ['npm_config_registry', 'npm_config_cache', 'PNPM_HOME', 'NPM_TOKEN']) expect(isDaemonInternalVar(n), n).toBe(false)
  })
  it("keeps the user's own variables, credentials and Claude settings", () => {
    for (const n of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'AWS_SESSION_TOKEN', 'AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'NPM_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EXECUTABLE', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'SESSION_MANAGER', 'STAGE_NAME', 'HOOKS_PATH', 'NODE_ENV', 'TERM_PROGRAM', 'DATA_HOME', 'LOGLEVEL']) {
      expect(isDaemonInternalVar(n), n).toBe(false)
    }
  })
})

describe('buildTerminalEnv', () => {
  const daemonEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/ana',
    LANG: 'en_US.UTF-8',
    GITHUB_TOKEN: 'ghp_userOwnCredentialStaysAvailable',
    DAEMON_PORT: '7421',
    DATA_DIR: '/home/ana/.local/share/ai-assistant',
    ANTHROPIC_API_KEY: 'sk-ant-api03-PLANTED-SECRET-VALUE',
    AI_ASSISTANT_HOOK_TOKEN: 'PLANTED-HOOK-TOKEN-0123456789012345678901234567890',
    STAGE_TOKEN: 'PLANTED-STAGE-TOKEN',
    EXCHANGE_CODE: 'PLANTED-EXCHANGE-CODE',
    MIRA_SESSION: 'PLANTED-SESSION',
    TERMINAL_CLAUDE_COMMAND: '["node","x.js"]',
  }

  it('drops the planted daemon secrets and keeps the rest', () => {
    const env = buildTerminalEnv(daemonEnv, { platform: 'linux' })
    const dump = JSON.stringify(env)
    for (const planted of ['PLANTED-SECRET-VALUE', 'PLANTED-HOOK-TOKEN', 'PLANTED-STAGE-TOKEN', 'PLANTED-EXCHANGE-CODE', 'PLANTED-SESSION', '7421', 'ai-assistant']) {
      expect(dump, planted).not.toContain(planted)
    }
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/ana', LANG: 'en_US.UTF-8', GITHUB_TOKEN: 'ghp_userOwnCredentialStaysAvailable' })
  })

  it('sets TERM and COLORTERM, overriding whatever the daemon had', () => {
    const env = buildTerminalEnv({ ...daemonEnv, TERM: 'dumb', COLORTERM: '' }, { platform: 'linux' })
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
  })

  it('returns only string values and drops invalid names and undefined', () => {
    const env = buildTerminalEnv({ OK: '1', UNDEF: undefined, '': 'x', 'A=B': 'y', '=C:': 'C:\\x', NULV: 'a\0b' }, { platform: 'linux' })
    expect(Object.keys(env).sort()).toEqual(['COLORTERM', 'OK', 'TERM'])
    for (const v of Object.values(env)) expect(typeof v).toBe('string')
  })

  it('treats Windows names case-insensitively and keeps one spelling of a duplicate', () => {
    const env = buildTerminalEnv({ Path: 'C:\\Windows', PATH: 'C:\\Other', Term: 'dumb', daemon_port: '1', Ai_Assistant_Hook_Token: 'zzz', SystemRoot: 'C:\\Windows' }, { platform: 'win32' })
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toHaveLength(1)
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'TERM')).toEqual(['TERM'])
    expect(env.TERM).toBe('xterm-256color')
    expect(Object.keys(env).some((k) => /daemon|assistant/i.test(k))).toBe(false)
    expect(env.SystemRoot).toBe('C:\\Windows')
  })

  it('lets callers add variables, but never a daemon-internal one', () => {
    const env = buildTerminalEnv({ PATH: '/bin' }, { platform: 'linux', extra: { FOO: 'bar', DAEMON_X: 'no', ANTHROPIC_API_KEY: 'no' } })
    expect(env.FOO).toBe('bar')
    expect(env.DAEMON_X).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('does not mutate its input', () => {
    const copy = { ...daemonEnv }
    buildTerminalEnv(daemonEnv, { platform: 'linux' })
    expect(daemonEnv).toEqual(copy)
  })
})
