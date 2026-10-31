/**
 * Redaction. Hook payloads, tool_input and tool_response hold file contents and secrets in plaintext
 * (docs/PRIVACY.md section 4), so nothing is persisted or logged before it has been through here.
 * Order matters: secrets are masked first, then text is truncated, so a secret that straddles the cut
 * can never leak as a prefix.
 */

const KEY_FRAGMENTS = ['apikey', 'token', 'secret', 'password', 'passwd', 'authorization', 'credential', 'privatekey', 'cookie', 'bearer', 'accesskey']

/** True for object keys whose string values must never be stored (api_key, accessToken, Authorization...). */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (k.endsWith('tokens') || k === 'tokencount') return false // usage counters, not secrets
  return KEY_FRAGMENTS.some((f) => k.includes(f))
}

// Bounded repetition keeps this linear-ish on huge inputs (an unbounded `[A-Za-z0-9_.-]*` prefix is quadratic on a long run of letters).
const SENSITIVE_WORDS = '[A-Za-z0-9_.-]{0,40}?(?:api[_-]?key|token|secret|passw(?:or)?d|passwd|credential|private[_-]?key|access[_-]?key|authorization)[A-Za-z0-9_.-]{0,40}'
/** Cheap linear pre-check so the key=value rule only runs on text that mentions a secret-looking word at all. */
const HAS_SENSITIVE_WORD = /api[_-]?key|token|secret|passw|credential|private[_-]?key|access[_-]?key|authorization/i

interface Rule {
  re: RegExp
  rep: string | ((...m: string[]) => string)
  /** Only run when the text mentions a secret-looking word at all (cheap linear pre-check). */
  needsSensitiveWord?: boolean
}

const RULES: Rule[] = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, rep: '[REDACTED PRIVATE KEY]' },
  { re: /sk-ant-[A-Za-z0-9_-]{6,}/g, rep: 'sk-ant-***' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, rep: 'sk-***' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, rep: 'gh_***' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, rep: 'gh_***' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, rep: 'AKIA***' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, rep: 'xox-***' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, rep: '[JWT]' },
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, rep: (_m, scheme = '') => `${scheme} ***` },
  {
    re: new RegExp(`(["']?)(${SENSITIVE_WORDS})\\1(\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&"'}\\]]+)`, 'gi'),
    rep: (m, q = '', key = '', sep = '', value = '') => (/^\d{1,6}$/.test(value) ? m : `${q}${key}${q}${sep}***`),
    needsSensitiveWord: true,
  },
]

/** Mask anything that looks like a secret. `literals` are exact secrets the daemon itself holds (hook token, API key). */
export function maskSecrets(text: string, literals: readonly string[] = []): string {
  let out = text
  for (const lit of literals) {
    if (lit.length >= 8 && out.includes(lit)) out = out.split(lit).join('***')
  }
  const sensitive = HAS_SENSITIVE_WORD.test(out)
  for (const rule of RULES) {
    if (rule.needsSensitiveWord && !sensitive) continue
    out = out.replace(rule.re, rule.rep as never)
  }
  return out
}

/** Mask, then truncate to `max` characters. */
export function redactText(text: string, max = 500, literals: readonly string[] = []): string {
  // Only the first `max` characters survive, so never run the masking rules over a megabyte of tool output. The extra
  // 512 characters of look-ahead make sure a secret that straddles the cut is still matched whole before it is cut.
  const window = text.length > max + 512 ? text.slice(0, max + 512) : text
  const masked = maskSecrets(window, literals)
  if (masked.length <= max && window.length === text.length) return masked
  const dropped = text.length - Math.min(masked.length, max)
  return `${masked.slice(0, max)}... (+${dropped} chars)`
}

export interface RedactLimits {
  maxString: number
  maxDepth: number
  maxItems: number
  maxKeys: number
}

const DEFAULT_LIMITS: RedactLimits = { maxString: 500, maxDepth: 5, maxItems: 20, maxKeys: 40 }

/** Deep copy with secrets masked, strings truncated, and arrays, objects and depth bounded. Always JSON-safe. */
export function redactValue(value: unknown, limits: Partial<RedactLimits> = {}, literals: readonly string[] = [], depth = 0): unknown {
  const l = { ...DEFAULT_LIMITS, ...limits }
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
      return redactText(value, l.maxString, literals)
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'object':
      break
    default:
      return null // functions, symbols
  }
  if (depth >= l.maxDepth) return '[truncated: too deep]'
  if (Array.isArray(value)) {
    const items = value.slice(0, l.maxItems).map((v) => redactValue(v, l, literals, depth + 1))
    if (value.length > l.maxItems) items.push(`[+${value.length - l.maxItems} more items]`)
    return items
  }
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= l.maxKeys) {
      out['[truncated]'] = `+${Object.keys(value as object).length - l.maxKeys} more keys`
      break
    }
    if (isSensitiveKey(k) && v !== null && v !== undefined && typeof v !== 'number' && typeof v !== 'boolean') {
      out[k] = '[redacted]'
    } else {
      out[k] = redactValue(v, l, literals, depth + 1)
    }
  }
  return out
}

function approxBytes(v: unknown): number {
  if (typeof v === 'string') return v.length
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}

/** A tool_response body is kept only as a short, masked preview plus its size. */
export function summarizeBody(value: unknown, preview = 300, literals: readonly string[] = []): { preview: string; chars: number } {
  const chars = approxBytes(value)
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value) ?? ''
    } catch {
      text = '[unserializable]'
    }
  }
  return { preview: redactText(text, preview, literals), chars }
}

export const PAYLOAD_CAP = 16 * 1024

export interface RedactedPayload {
  payload: Record<string, unknown>
  json: string
}

/**
 * Redact a Claude Code hook payload for storage: tool_input keeps its structure with short strings,
 * tool_response becomes a preview plus size, prompts and messages are cut to a few hundred characters,
 * everything is secret-masked, and the whole thing is capped at PAYLOAD_CAP bytes.
 */
export function redactHookPayload(input: unknown, literals: readonly string[] = []): RedactedPayload {
  const src = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : { value: input }
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(src)) {
    if (n++ >= 60) break
    switch (k) {
      case 'tool_response':
      case 'tool_output':
        out[k] = v === undefined ? null : summarizeBody(v, 300, literals)
        break
      case 'tool_input':
        out[k] = redactValue(v, { maxString: 300, maxItems: 10, maxKeys: 20, maxDepth: 4 }, literals)
        break
      case 'prompt':
        out[k] = typeof v === 'string' ? redactText(v, 200, literals) : redactValue(v, {}, literals)
        break
      case 'last_assistant_message':
      case 'message':
      case 'error':
        out[k] = typeof v === 'string' ? redactText(v, 300, literals) : redactValue(v, { maxString: 300 }, literals)
        break
      default:
        out[k] = isSensitiveKey(k) && typeof v === 'string' ? '[redacted]' : redactValue(v, { maxString: 500, maxDepth: 4 }, literals)
    }
  }
  let json = JSON.stringify(out)
  if (json.length > PAYLOAD_CAP) {
    const slim: Record<string, unknown> = { truncated: true, bytes: json.length }
    for (const key of ['session_id', 'hook_event_name', 'cwd', 'tool_name', 'tool_use_id', 'agent_id', 'agent_type']) {
      if (typeof out[key] === 'string') slim[key] = out[key]
    }
    json = JSON.stringify(slim)
    return { payload: slim, json }
  }
  return { payload: out, json }
}
