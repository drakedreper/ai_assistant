import { describe, expect, it } from 'vitest'
import { buildHostEnv, buildTerminalEnv, isDaemonInternalVar, scrubNodeOptions, scrubNodePath } from '../src/terminal/env'

describe('isDaemonInternalVar', () => {
  it('removes the daemon namespaces, whatever follows', () => {
    for (const n of ['DAEMON_PORT', 'DAEMON_ANYTHING', 'AI_ASSISTANT_HOOK_TOKEN', 'AIA_X', 'MIRA_STAGE_TOKEN', 'mira_lowercase', 'daemon_port']) expect(isDaemonInternalVar(n), n).toBe(true)
  })
  it('removes every variable of the daemon configuration table', () => {
    for (const n of ['DATA_DIR', 'DEV_ORIGINS', 'WEB_DIST', 'CLAUDE_BACKEND', 'CLAUDE_AUTH_MODE', 'CLAUDE_CONVERSATION', 'OPEN_BROWSER', 'DEMO', 'LOG_LEVEL', 'RETENTION_DAYS', 'BUDGET_SECRETARY_USD', 'BUDGET_GLOBAL_USD', 'STALE_RUNNING_MINUTES', 'STALE_IDLE_MINUTES', 'TERMINAL_MAX', 'TERMINAL_IDLE_MINUTES', 'TERMINAL_SCROLLBACK_KB', 'TERMINAL_CLAUDE_COMMAND', 'ANTHROPIC_API_KEY']) {
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


describe('the launcher\'s module loaders do not reach a terminal (NODE_PATH-INHERITED)', () => {
  const ROOTS = ['/home/user/ai_assistant', '/home/user/ai_assistant/apps/daemon']
  const SHIM = '/home/user/ai_assistant/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/node_modules:/home/user/ai_assistant/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/node_modules:/home/user/ai_assistant/node_modules/.pnpm/node_modules'

  it('NODE_PATH: entries inside the daemon\'s own tree (the pnpm and tsx shim) go, the user\'s own stay', () => {
    expect(scrubNodePath(SHIM, 'linux', ROOTS)).toBeUndefined()
    expect(scrubNodePath(`${SHIM}:/usr/local/lib/node_modules_global:/opt/mine`, 'linux', ROOTS)).toBe('/usr/local/lib/node_modules_global:/opt/mine')
    // a pnpm virtual store is recognised even outside the roots (a global install elsewhere)
    expect(scrubNodePath('/somewhere/else/node_modules/.pnpm/ws@8/node_modules:/keep/me', 'linux', [])).toBe('/keep/me')
    // the roots themselves count, a sibling folder with the same prefix does not
    expect(scrubNodePath('/home/user/ai_assistant:/home/user/ai_assistant-notes', 'linux', ROOTS)).toBe('/home/user/ai_assistant-notes')
    // a filesystem root as a "daemon root" never wipes everything
    expect(scrubNodePath('/usr/lib/node', 'linux', ['/'])).toBe('/usr/lib/node')
    expect(scrubNodePath('', 'linux', ROOTS)).toBeUndefined()
  })

  it('NODE_PATH on Windows: ; separated, case-insensitive, backslashes', () => {
    const roots = ['C:\\Users\\Ana\\dev\\ai_assistant']
    const v = 'C:\\USERS\\ana\\dev\\AI_ASSISTANT\\node_modules\\.pnpm\\tsx@4\\node_modules;D:\\tools\\global;c:\\users\\ana\\dev\\ai_assistant\\apps\\daemon\\node_modules'
    expect(scrubNodePath(v, 'win32', roots)).toBe('D:\\tools\\global')
  })

  it('NODE_OPTIONS: only the code-loading flags go (with their values), in every spelling; the rest is the user\'s own', () => {
    expect(scrubNodeOptions('--use-openssl-ca')).toBe('--use-openssl-ca')
    expect(scrubNodeOptions('--require /repo/preflight.cjs --import file:///repo/loader.mjs --max-old-space-size=4096')).toBe('--max-old-space-size=4096')
    expect(scrubNodeOptions('--require=/repo/a.cjs -r /repo/b.cjs --loader=x --experimental-loader y --import=z')).toBeUndefined()
    expect(scrubNodeOptions('--use-openssl-ca --import "C:\\Program Files\\x\\loader.mjs" --no-warnings')).toBe('--use-openssl-ca --no-warnings')
    expect(scrubNodeOptions('--require')).toBeUndefined()
    expect(scrubNodeOptions('')).toBeUndefined()
  })

  it('buildTerminalEnv applies both rules, drops an emptied variable, and keeps unrelated ones', () => {
    const env = buildTerminalEnv(
      { PATH: '/usr/bin', NODE_PATH: SHIM, NODE_OPTIONS: '--require /repo/preflight.cjs --import file:///repo/loader.mjs', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem', NODE_ENV: 'development' },
      { platform: 'linux', daemonRoots: ROOTS },
    )
    expect(env.NODE_PATH).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env).toMatchObject({ PATH: '/usr/bin', NODE_EXTRA_CA_CERTS: '/etc/corp-ca.pem', NODE_ENV: 'development' })
    const partial = buildTerminalEnv({ NODE_PATH: `${SHIM}:/usr/local/lib/node_modules_global`, NODE_OPTIONS: '--use-openssl-ca --import tsx' }, { platform: 'linux', daemonRoots: ROOTS })
    expect(partial).toMatchObject({ NODE_PATH: '/usr/local/lib/node_modules_global', NODE_OPTIONS: '--use-openssl-ca' })
  })

  it('on Windows the scrub works on a differently cased variable name', () => {
    const env = buildTerminalEnv({ Path: 'C:\\Windows', node_path: 'C:\\dev\\ai\\node_modules\\.pnpm\\x', Node_Options: '--import tsx' }, { platform: 'win32', daemonRoots: ['C:\\dev\\ai'] })
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('NODE_PATH')
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('NODE_OPTIONS')
    expect(env.Path).toBe('C:\\Windows')
  })

  it('without daemonRoots a pnpm virtual-store entry is still removed', () => {
    expect(buildTerminalEnv({ NODE_PATH: SHIM }, { platform: 'linux' }).NODE_PATH).toBeUndefined()
  })
})

describe('buildHostEnv: the environment of a PTY host process', () => {
  it('has no secret and nothing of the daemon\'s configuration, but keeps the loader variables the daemon itself runs under', () => {
    const env = buildHostEnv({
      PATH: '/usr/bin',
      HOME: '/home/ana',
      SystemRoot: 'C:\\Windows',
      NODE_PATH: '/modules',
      NODE_OPTIONS: '--use-openssl-ca',
      ANTHROPIC_API_KEY: 'sk-ant-planted',
      AI_ASSISTANT_HOOK_TOKEN: 'planted-hook',
      STAGE_TOKEN: 'planted-stage',
      DAEMON_PORT: '7421',
      DATA_DIR: '/d',
      TERMINAL_CLAUDE_COMMAND: '["x"]',
      BUDGET_GLOBAL_USD: '10',
      MIRA_X: '1',
      EXCHANGE_CODE: 'planted',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/ana', SystemRoot: 'C:\\Windows', NODE_PATH: '/modules', NODE_OPTIONS: '--use-openssl-ca' })
  })

  it('drops undefined values and invalid names', () => {
    expect(buildHostEnv({ A: undefined, 'B=C': 'x', '': 'y', D: 'ok\0bad', E: 'fine' })).toEqual({ E: 'fine' })
  })
})
