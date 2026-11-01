/**
 * Asset locators are engine-specific references (a path in the stage's content pack, a glTF/VRM path or a URL). They
 * come from manifests on disk, which are untrusted. A locator is accepted only if it cannot escape the content root
 * and cannot reach anything but an allowlisted scheme.
 *
 * Windows is the target, so BOTH "/" and "\" separate segments and "C:\" style drives and UNC paths are recognised
 * (this is reasoned about and unit-tested with Windows-style strings; nothing here touches the real file system).
 *
 * THE RULES ARE THE SAME EVERYWHERE A PATH APPEARS. A bare relative locator ("props/chair"), the remainder of an
 * `asset:` or `pack:` locator ("asset:props/chair") and the part of an absolute locator below the content root all go
 * through ONE check (`relativePathProblem`): a plain relative path, no drive, no leading separator, no UNC, no ":" (drive
 * letters, alternate data streams), no ".." segment, no control or invisible characters, no reserved device names, no
 * trailing dot or space, none of Windows' forbidden characters. `asset://host/x` is therefore refused: after the scheme
 * it is a network-style path, exactly like a bare `//host/x`.
 *
 * PERCENT-ENCODING. A consumer may percent-decode a locator (once, twice, or until nothing changes), and may fold
 * compatibility characters (a fullwidth "．" or "／") to ASCII. So the check does not look at the string as written
 * only: it derives every form a consumer could see (NFKC folding and percent-decoding, repeated until a fixed point,
 * at most `MAX_DECODE_ROUNDS` decodings; anything that still decodes after that is refused as nested too deeply) and
 * REQUIRES EVERY FORM TO BE SAFE. A malformed escape ("%zz", a lone "%", invalid UTF-8) is refused. For a relative
 * path an encoded backslash is refused too (a raw one is a separator and is normalised to "/"; an encoded one would
 * survive normalisation and become a separator only after decoding).
 *
 * HOSTS. `https:` (and `http:`/`ws:`... if the owner allows them) locators need a host; by default only public-looking
 * DNS names are accepted: loopback, private and link-local literals (including decimal and hex forms), single-label
 * intranet names and ".local"/".internal"/".lan" names are refused, so an engine stage that fetches a locator cannot be
 * pointed at the daemon, the router or a cloud metadata service. `allowedHosts` turns that into an explicit allowlist.
 */

export const DEFAULT_ALLOWED_SCHEMES: readonly string[] = ['asset', 'pack', 'https']

export interface LocatorOptions {
  /** Absolute content root (any separator style). Absolute locators are accepted only inside it. */
  contentRoot?: string
  /** URL schemes accepted (lowercase, no colon). Default: asset, pack, https. */
  allowedSchemes?: readonly string[]
  /**
   * Hosts a URL locator may use ("cdn.example.com", or "*.example.com" for any subdomain). When given, ONLY these hosts
   * are accepted (even ones that look local, which is how a developer opts in to `localhost`). When omitted, any
   * public-looking DNS name is accepted and local, private and numeric hosts are refused.
   */
  allowedHosts?: readonly string[]
}

export type LocatorCheck =
  | { ok: true; kind: 'relative' | 'absolute' | 'url'; normalized: string }
  | { ok: false; reason: string }

const MAX_LOCATOR = 1024
/** At most this many percent-decodings are looked through; a string that still decodes after them is refused. */
export const MAX_DECODE_ROUNDS = 4
/** Control characters (C0, DEL, C1), invisible format characters (bidi marks and overrides, zero-width), line and paragraph separators, lone surrogates. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/
const UNC = /^[\\/]{2}/
/** Schemes whose remainder is a network authority and path rather than a path inside the content pack. */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'ws', 'wss', 'ftp'])
const RESERVED_STEM = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i

const fail = (reason: string): LocatorCheck => ({ ok: false, reason })

function decodeOnce(s: string): string | undefined {
  try {
    return decodeURIComponent(s)
  } catch {
    return undefined
  }
}

/** Segments after splitting on both separators; "." and empty segments are dropped, ".." is reported. */
function segmentsOf(path: string): { segs: string[]; traversal: boolean } {
  const segs: string[] = []
  let traversal = false
  for (const s of path.split(/[\\/]+/)) {
    if (s === '' || s === '.') continue
    if (s === '..') traversal = true
    segs.push(s)
  }
  return { segs, traversal }
}

interface Form {
  s: string
  /** False for the string as written; true for anything derived from it (decoded or folded). */
  derived: boolean
}

/**
 * The string as written plus every form a consumer could derive from it: NFKC folding and percent-decoding, repeated
 * until nothing changes. Bounded: `MAX_DECODE_ROUNDS` decodings at most.
 */
function formsOf(raw: string): { forms: Form[] } | { error: string } {
  const forms: Form[] = [{ s: raw, derived: false }]
  let cur = raw
  for (let round = 0; ; round++) {
    const folded = cur.normalize('NFKC')
    if (folded !== cur) {
      forms.push({ s: folded, derived: true })
      cur = folded
    }
    if (!cur.includes('%')) break
    if (round >= MAX_DECODE_ROUNDS) return { error: 'percent-encoding is nested too deeply' }
    const decoded = decodeOnce(cur)
    if (decoded === undefined) return { error: 'malformed percent-encoding' }
    forms.push({ s: decoded, derived: true })
    cur = decoded
  }
  return { forms }
}

const note = (problem: string, derived: boolean): string => (derived ? `${problem} (after decoding)` : problem)

type Normalized = { ok: true; normalized: string } | { ok: false; reason: string }

/** What is wrong with one form of a RELATIVE path, if anything. */
function plainRelativeProblem(f: Form): string | undefined {
  const s = f.s
  if (HIDDEN.test(s)) return note('locator contains control characters', f.derived)
  if (/^[\\/]/.test(s)) return note('absolute or network paths are not allowed here', f.derived)
  if (f.derived && s.includes('\\')) return 'an encoded backslash is not allowed'
  if (s.includes(':')) return note('":" is not allowed in a relative locator', f.derived)
  const { segs, traversal } = segmentsOf(s)
  if (traversal) return note('path traversal ("..") is not allowed', f.derived)
  if (segs.length === 0) return note('locator has no path', f.derived)
  // Windows reserved device names (with or without an extension) and trailing dots/spaces are file-system tricks.
  for (const seg of segs) {
    const stem = (seg.split('.')[0] ?? '').trimEnd()
    if (RESERVED_STEM.test(stem)) return note(`reserved name "${seg.slice(0, 40)}"`, f.derived)
    if (/[. ]$/.test(seg)) return note('segment ends with a dot or space', f.derived)
    if (/[<>"|?*]/.test(seg)) return note('segment has characters that are not allowed on Windows', f.derived)
  }
  return undefined
}

/** The problem with a relative path in ANY form a consumer could see, or undefined when every form is a plain relative path. */
export function relativePathProblem(raw: string): string | undefined {
  const all = formsOf(raw)
  if ('error' in all) return all.error
  for (const f of all.forms) {
    const p = plainRelativeProblem(f)
    if (p) return p
  }
  return undefined
}

/**
 * Check a relative path AND the form it is stored in. Normalising drops "." and empty segments, which can expose a
 * leading encoded separator ("./%2fetc" becomes "%2fetc"), so the normalised string must pass on its own.
 */
function normalizeRelative(raw: string): Normalized {
  const problem = relativePathProblem(raw)
  if (problem) return { ok: false, reason: problem }
  const normalized = segmentsOf(raw).segs.join('/')
  if (normalized !== raw) {
    const again = relativePathProblem(normalized)
    if (again) return { ok: false, reason: again }
  }
  return { ok: true, normalized }
}

/** The same fixed-point look at a URL (or absolute path) as a whole: control characters, ".." segments and encoded backslashes in any form. */
function wholeProblem(raw: string): string | undefined {
  const all = formsOf(raw)
  if ('error' in all) return all.error
  for (const f of all.forms) {
    if (HIDDEN.test(f.s)) return note('locator contains control characters', f.derived)
    if (f.derived && f.s.includes('\\')) return 'an encoded backslash is not allowed'
    if (segmentsOf(f.s).traversal) return note('path traversal ("..") is not allowed', f.derived)
  }
  return undefined
}

function isAbsolutePath(s: string): boolean {
  return s.startsWith('/') || s.startsWith('\\') || DRIVE.test(s)
}

/** Canonical comparison form: forward slashes, no trailing slash, lower-cased when it is a drive path (Windows is case-insensitive). */
function canonAbs(p: string): string {
  const slashed = p.replace(/\\/g, '/').replace(/\/+/g, '/')
  const trimmed = slashed.length > 1 && slashed.endsWith('/') ? slashed.slice(0, -1) : slashed
  return DRIVE.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

export function validateLocator(locator: unknown, opts: LocatorOptions = {}): LocatorCheck {
  if (typeof locator !== 'string') return fail('locator must be a string')
  if (locator.length === 0) return fail('locator is empty')
  if (locator.length > MAX_LOCATOR) return fail('locator is too long')
  if (HIDDEN.test(locator)) return fail('locator contains control characters')
  if (locator.trim() !== locator) return fail('locator has leading or trailing whitespace')
  // "\\host", "//host" and the mixed "\/host", "/\host" are all UNC prefixes on Windows
  if (UNC.test(locator)) return fail('network (UNC) paths are not allowed')

  const allowed = new Set((opts.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES).map((s) => s.toLowerCase()))

  // Windows drive letters look like a one-letter scheme; decide that first.
  if (DRIVE.test(locator)) return checkAbsolute(locator, opts)

  const m = SCHEME.exec(locator)
  if (m) {
    const scheme = m[1]!.toLowerCase()
    if (!allowed.has(scheme)) return fail(`scheme "${scheme}:" is not allowed`)
    const rest = locator.slice(m[0].length)
    return NETWORK_SCHEMES.has(scheme) ? checkUrl(scheme, rest, locator, opts) : checkPackPath(scheme, rest)
  }

  if (isAbsolutePath(locator)) return checkAbsolute(locator, opts)

  const n = normalizeRelative(locator)
  return n.ok ? { ok: true, kind: 'relative', normalized: n.normalized } : fail(n.reason)
}

/** `asset:` / `pack:` (and any other allowed non-network scheme): what follows is a plain relative path inside the content pack. */
function checkPackPath(scheme: string, rest: string): LocatorCheck {
  if (/^[\\/]/.test(rest)) {
    return fail(`${scheme}: locators are plain relative paths such as "${scheme}:props/chair"; a leading "/" or "//" (a network-style path) is not allowed`)
  }
  const n = normalizeRelative(rest)
  return n.ok ? { ok: true, kind: 'url', normalized: `${scheme}:${n.normalized}` } : fail(n.reason)
}

function hostMatches(host: string, entry: string): boolean {
  const e = entry.toLowerCase().replace(/\.$/, '')
  if (e.startsWith('*.')) return host.endsWith(e.slice(1)) && host.length > e.length - 1
  return host === e
}

/** Why a host may not be fetched by a stage, or undefined when it is fine. */
function hostProblem(rawHost: string, allowedHosts: readonly string[] | undefined): string | undefined {
  const host = rawHost.toLowerCase().replace(/\.$/, '')
  if (allowedHosts !== undefined) return allowedHosts.some((e) => hostMatches(host, e)) ? undefined : `host "${host.slice(0, 80)}" is not on the allowed list`
  const labels = host.split('.')
  if (labels.some((l) => l.length === 0 || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-'))) return 'the host name is not valid'
  if (labels.length < 2) return 'single-label (intranet) hosts are not allowed'
  const last = labels[labels.length - 1]!
  // a last label that is a number (decimal, or 0x hex) makes browsers and resolvers read the whole host as an IPv4 address
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return 'IP-address hosts are not allowed'
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa)$/.test(host)) return 'local and intranet hosts are not allowed'
  return undefined
}

function checkUrl(scheme: string, rest: string, locator: string, opts: LocatorOptions): LocatorCheck {
  if (/^\/\/[^/]*@/.test(rest)) return fail('credentials in a URL are not allowed')
  if (/^\/\/\//.test(rest)) return fail('empty authority is not allowed')
  const m = /^\/\/([A-Za-z0-9.-]+)(?::(\d{1,5}))?(?=\/|$)/.exec(rest)
  if (!m) return fail(`${scheme} locator needs a host`)
  if (m[2] !== undefined && Number(m[2]) > 65535) return fail('the port is not valid')
  const bad = hostProblem(m[1]!, opts.allowedHosts)
  if (bad) return fail(bad)
  const problem = wholeProblem(rest.slice(m[0].length))
  if (problem) return fail(problem)
  return { ok: true, kind: 'url', normalized: locator }
}

function checkAbsolute(locator: string, opts: LocatorOptions): LocatorCheck {
  if (!opts.contentRoot) return fail('absolute paths are not allowed without a content root')
  const whole = wholeProblem(locator)
  if (whole) return fail(whole)
  const root = canonAbs(opts.contentRoot)
  const full = canonAbs(locator)
  if (full !== root && !full.startsWith(root + '/')) return fail('absolute path is outside the content root')
  if (full === root) return fail('locator points at the content root itself')
  // what lies below the root follows the relative-path rules like any other path (reserved names, ":", trailing dots...)
  const below = relativePathProblem(full.slice(root.length + 1))
  if (below) return fail(below)
  const normalized = locator.replace(/\\/g, '/').replace(/\/+/g, '/')
  const again = wholeProblem(normalized)
  if (again) return fail(again)
  return { ok: true, kind: 'absolute', normalized }
}

const THUMB_DATA = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const MAX_THUMB_DATA = 256 * 1024

/** Thumbnails may also be small raster data URIs (never SVG: it can carry script). */
export function validateThumbnail(thumb: unknown, opts: LocatorOptions = {}): LocatorCheck {
  if (typeof thumb === 'string' && thumb.startsWith('data:')) {
    if (thumb.length > MAX_THUMB_DATA) return fail('thumbnail data URI is too large')
    return THUMB_DATA.test(thumb) ? { ok: true, kind: 'url', normalized: thumb } : fail('only png, jpeg or webp base64 data URIs are allowed')
  }
  return validateLocator(thumb, opts)
}
