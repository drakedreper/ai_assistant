/**
 * Asset locators are engine-specific references (a path in the stage's content pack, a glTF/VRM path or a URL). They
 * come from manifests on disk, which are untrusted. A locator is accepted only if it cannot escape the content root
 * and cannot reach anything but an allowlisted scheme.
 *
 * Windows is the target, so BOTH "/" and "\" separate segments and "C:\" style drives and UNC paths are recognised
 * (this is reasoned about and unit-tested with Windows-style strings; nothing here touches the real file system).
 */

export const DEFAULT_ALLOWED_SCHEMES: readonly string[] = ['asset', 'pack', 'https']

export interface LocatorOptions {
  /** Absolute content root (any separator style). Absolute locators are accepted only inside it. */
  contentRoot?: string
  /** URL schemes accepted (lowercase, no colon). Default: asset, pack, https. */
  allowedSchemes?: readonly string[]
}

export type LocatorCheck =
  | { ok: true; kind: 'relative' | 'absolute' | 'url'; normalized: string }
  | { ok: false; reason: string }

const MAX_LOCATOR = 1024
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/

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

function hasDotDotAfterDecoding(s: string): boolean {
  let cur = s
  for (let i = 0; i < 3; i++) {
    if (segmentsOf(cur).traversal) return true
    const d = decodeOnce(cur)
    if (d === undefined) return true // malformed percent-encoding is treated as hostile
    if (d === cur) return false
    cur = d
  }
  return segmentsOf(cur).traversal
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
  if (CONTROL.test(locator)) return fail('locator contains control characters')
  if (locator.trim() !== locator) return fail('locator has leading or trailing whitespace')
  if (locator.startsWith('\\\\') || locator.startsWith('//')) return fail('network (UNC) paths are not allowed')

  const allowed = new Set((opts.allowedSchemes ?? DEFAULT_ALLOWED_SCHEMES).map((s) => s.toLowerCase()))

  // Windows drive letters look like a one-letter scheme; decide that first.
  if (DRIVE.test(locator)) return checkAbsolute(locator, opts)

  const m = SCHEME.exec(locator)
  if (m) {
    const scheme = m[1]!.toLowerCase()
    if (!allowed.has(scheme)) return fail(`scheme "${scheme}:" is not allowed`)
    const rest = locator.slice(m[0].length)
    if (/^\/\/[^/]*@/.test(rest)) return fail('credentials in a URL are not allowed')
    if (/^\/\/\//.test(rest)) return fail('empty authority is not allowed')
    if (hasDotDotAfterDecoding(rest)) return fail('path traversal ("..") is not allowed')
    if (scheme === 'https' && !/^\/\/[A-Za-z0-9.-]+(:\d+)?(\/|$)/.test(rest)) return fail('https locator needs a host')
    return { ok: true, kind: 'url', normalized: locator }
  }

  if (isAbsolutePath(locator)) return checkAbsolute(locator, opts)

  if (hasDotDotAfterDecoding(locator)) return fail('path traversal ("..") is not allowed')
  if (locator.includes(':')) return fail('":" is not allowed in a relative locator')
  const { segs } = segmentsOf(locator)
  if (segs.length === 0) return fail('locator has no path')
  // Windows reserved device names and trailing dots/spaces are file-system tricks.
  for (const s of segs) {
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) return fail(`reserved name "${s}"`)
    if (/[. ]$/.test(s)) return fail('segment ends with a dot or space')
    if (/[<>"|?*]/.test(s)) return fail('segment has characters that are not allowed on Windows')
  }
  return { ok: true, kind: 'relative', normalized: segs.join('/') }
}

function checkAbsolute(locator: string, opts: LocatorOptions): LocatorCheck {
  if (!opts.contentRoot) return fail('absolute paths are not allowed without a content root')
  if (hasDotDotAfterDecoding(locator)) return fail('path traversal ("..") is not allowed')
  const root = canonAbs(opts.contentRoot)
  const full = canonAbs(locator)
  if (full !== root && !full.startsWith(root + '/')) return fail('absolute path is outside the content root')
  if (full === root) return fail('locator points at the content root itself')
  return { ok: true, kind: 'absolute', normalized: locator.replace(/\\/g, '/').replace(/\/+/g, '/') }
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
