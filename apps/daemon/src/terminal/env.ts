/**
 * The environment a terminal child gets: the user's own environment (the daemon's, which was inherited from the
 * shell that started it) MINUS everything that belongs to the daemon.
 *
 * Why: a terminal runs arbitrary programs as the user, and so does anything those programs spawn. The daemon's
 * own secrets and control variables have no business in there: a project's dev server, an npm script or a
 * misbehaving tool would otherwise inherit them and could log or send them.
 *
 * The rule (documented in apps/daemon/README.md, "Terminal"):
 *   1. Prefixes owned by this product are removed whatever follows: DAEMON_*, AI_ASSISTANT_* (the hook token
 *      variable of `hooks install`), AIA_*, MIRA_*.
 *   2. Every variable of the daemon's own configuration table is removed: DATA_DIR, DEV_ORIGINS, WEB_DIST,
 *      CLAUDE_BACKEND, CLAUDE_AUTH_MODE, DEMO, LOG_LEVEL, RETENTION_DAYS, BUDGET_*, STALE_*, TERMINAL_*.
 *   3. ANTHROPIC_API_KEY is removed. The daemon reads it for its own chat lane (with a budget). The user's own
 *      `claude` in a terminal signs in by itself (subscription login, or a key the user sets inside that terminal),
 *      so the daemon never hands its key to it and never silently switches a subscription login to API billing.
 *   4. Token-shaped names with a daemon-flavoured prefix are removed: STAGE_*, HOOK_*, EXCHANGE_*, SESSION_*,
 *      COOKIE_* when the name ends in TOKEN, SECRET, CODE, KEY or PASSWORD (for example STAGE_TOKEN, HOOK_TOKEN,
 *      EXCHANGE_CODE), and X_HOOK_TOKEN / X_STAGE_TOKEN / X_EXCHANGE_CODE style names. AWS_SESSION_TOKEN and
 *      friends are the USER's credentials and stay (the match is anchored at the start of the name).
 *   5. Launcher artefacts: when the daemon was started with `pnpm start` / `npm run`, the package manager marked its
 *      environment ("we are inside an npm script"): npm_lifecycle_*, npm_package_*, npm_command, npm_execpath,
 *      npm_node_execpath, npm_config_user_agent, INIT_CWD, PNPM_SCRIPT_SRC_DIR. They would make tools in the terminal
 *      behave as if they ran inside that script, so they are removed. (Other npm_config_* settings stay.)
 *   6. Names that are not valid for a child process (empty, containing "=" after the first character, NUL) and
 *      Windows' hidden per-drive variables (names starting with "=") are dropped.
 *   CLAUDE_CONFIG_DIR and CLAUDE_EXECUTABLE are deliberately kept: they are the user's own Claude Code settings.
 *
 * On Windows names are case-insensitive, so every comparison is on the upper-cased name.
 */

const OWNED_PREFIXES = ['DAEMON_', 'AI_ASSISTANT_', 'AIA_', 'MIRA_'] as const

const DAEMON_CONFIG_NAMES = new Set([
  'DATA_DIR',
  'DEV_ORIGINS',
  'WEB_DIST',
  'CLAUDE_BACKEND',
  'CLAUDE_AUTH_MODE',
  'DEMO',
  'LOG_LEVEL',
  'RETENTION_DAYS',
  'ANTHROPIC_API_KEY',
])
const DAEMON_CONFIG_PREFIXES = ['BUDGET_', 'STALE_', 'TERMINAL_'] as const

const LAUNCHER_NAMES = new Set(['NPM_COMMAND', 'NPM_EXECPATH', 'NPM_NODE_EXECPATH', 'NPM_CONFIG_USER_AGENT', 'INIT_CWD', 'PNPM_SCRIPT_SRC_DIR'])
const LAUNCHER_PREFIXES = ['NPM_LIFECYCLE_', 'NPM_PACKAGE_'] as const

const SECRET_SUFFIX = '(?:TOKEN|SECRET|CODE|KEY|PASSWORD)'
const TOKEN_AT_START = new RegExp(`^(?:STAGE|HOOK|EXCHANGE|SESSION|COOKIE)_[A-Z0-9_]*${SECRET_SUFFIX}$`)
const TOKEN_PREFIXED = new RegExp(`^[A-Z0-9_]+_(?:HOOK|STAGE|EXCHANGE)_${SECRET_SUFFIX}$`)

/** True when a variable belongs to the daemon (or is one of its secrets) and must not reach a terminal child. */
export function isDaemonInternalVar(name: string): boolean {
  const n = name.toUpperCase()
  if (OWNED_PREFIXES.some((p) => n.startsWith(p))) return true
  if (DAEMON_CONFIG_NAMES.has(n)) return true
  if (DAEMON_CONFIG_PREFIXES.some((p) => n.startsWith(p))) return true
  if (TOKEN_AT_START.test(n) || TOKEN_PREFIXED.test(n)) return true
  if (LAUNCHER_NAMES.has(n) || LAUNCHER_PREFIXES.some((p) => n.startsWith(p))) return true
  return false
}

function isValidName(name: string): boolean {
  if (name.length === 0 || name.startsWith('=')) return false
  return !name.includes('=') && !name.includes('\0')
}

export interface TerminalEnvOptions {
  platform: NodeJS.Platform
  /** Added last (they win), for example a marker variable. Names that look daemon-internal are still refused. */
  extra?: Record<string, string>
}

/**
 * Build the child environment. The result only contains string values. TERM and COLORTERM are set so colour-aware
 * programs (Claude Code's UI included) draw with 256 colours and truecolor, which xterm.js supports.
 */
export function buildTerminalEnv(parent: Readonly<Record<string, string | undefined>>, opts: TerminalEnvOptions): Record<string, string> {
  const out: Record<string, string> = {}
  // On Windows the same variable can appear twice with different case in a copied environment; the last one wins in
  // the process, so keep one entry per upper-cased name and preserve the original spelling of the first.
  const seen = new Map<string, string>()
  for (const [name, value] of Object.entries(parent)) {
    if (typeof value !== 'string' || value.includes('\0')) continue
    if (!isValidName(name)) continue
    if (isDaemonInternalVar(name)) continue
    if (opts.platform === 'win32') {
      const key = name.toUpperCase()
      const first = seen.get(key)
      if (first !== undefined) delete out[first]
      seen.set(key, name)
    }
    out[name] = value
  }
  const set = (name: string, value: string): void => {
    if (opts.platform === 'win32') {
      const existing = seen.get(name.toUpperCase())
      if (existing !== undefined && existing !== name) delete out[existing]
      seen.set(name.toUpperCase(), name)
    }
    out[name] = value
  }
  set('TERM', 'xterm-256color')
  set('COLORTERM', 'truecolor')
  for (const [name, value] of Object.entries(opts.extra ?? {})) {
    if (!isValidName(name) || isDaemonInternalVar(name) || value.includes('\0')) continue
    set(name, value)
  }
  return out
}
