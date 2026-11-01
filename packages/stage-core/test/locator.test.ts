import { describe, expect, it } from 'vitest'
import { AssetCatalog, MAX_DECODE_ROUNDS, relativePathProblem, validateLocator, validateThumbnail } from '../src'
import { lcg } from './helpers'

/**
 * Regression tests for the locator review findings: `asset:` and `pack:` must apply the same path rules as a bare
 * relative locator (HIGH), a percent-encoded form must never hide an absolute, UNC, drive, NUL or ":" path (MEDIUM), the
 * decoding is followed to a fixed point instead of three levels (INFO), and a URL locator cannot point at a local or
 * private host by default (INFO).
 */

const ROOT_WIN = 'C:\\Content\\Assets'
const ROOT_POSIX = '/srv/content'
const CONFIGS = [{}, { contentRoot: ROOT_WIN }, { contentRoot: ROOT_POSIX }] as const

describe('asset: and pack: apply the same path rules as a bare relative locator', () => {
  const NASTY = [
    'asset:\\\\evil\\share\\x.vrm',
    'asset:C:\\Windows\\System32\\x',
    'asset:C:/Windows/win.ini',
    'asset:/C:/Windows/win.ini',
    'asset:\\\\?\\C:\\x',
    'asset://evil/share/x',
    'asset:/etc/passwd',
    'pack:/etc/passwd',
    'pack:\\Windows\\win.ini',
    'pack:\\\\.\\pipe\\x',
    'pack://host/x',
    'asset:con',
    'asset:CON.txt',
    'asset:a/nul',
    'asset:a/COM1.txt',
    'asset:x.',
    'asset:a /b',
    'asset:a/b:c',
    'asset:file.txt::$DATA',
    'asset:../x',
    'pack:a/../../x',
    'asset:a\\..\\..\\x',
    'asset:a\u0000b',
    'asset:a?b',
    'asset:a*b',
    'asset:',
    'asset:.',
    'asset:/',
    'asset:\\',
    // percent-encoded forms of the same
    'asset:%5c%5cevil%5cshare%5cx',
    'asset:%2fetc%2fpasswd',
    'asset:%43%3a%5cWindows%5cx',
    'pack:%2e%2e/x',
    'pack:a%00b',
    'asset:con%2etxt',
    'asset:a%3ab',
  ]
  it.each(NASTY)('refuses %j with and without a content root', (s) => {
    for (const opts of CONFIGS) {
      const r = validateLocator(s, opts)
      expect(r.ok, `${JSON.stringify(s)} ${JSON.stringify(opts)}`).toBe(false)
    }
  })

  it('the bare forms are refused too, so the scheme prefix adds nothing', () => {
    for (const rest of ['\\\\evil\\share\\x.vrm', 'C:\\Windows\\System32\\x', '/etc/passwd', 'con', 'a/b:c', 'x.', '../x']) {
      expect(validateLocator(rest).ok, rest).toBe(false)
      expect(validateLocator(`asset:${rest}`).ok, `asset:${rest}`).toBe(false)
      expect(validateLocator(`pack:${rest}`).ok, `pack:${rest}`).toBe(false)
    }
  })

  it('accepts a plain relative path and normalises it (scheme lower-cased, "/" separators, no empty or dot segments)', () => {
    expect(validateLocator('asset:props/chair')).toEqual({ ok: true, kind: 'url', normalized: 'asset:props/chair' })
    expect(validateLocator('ASSET:props\\\\chair/./x.glb')).toEqual({ ok: true, kind: 'url', normalized: 'asset:props/chair/x.glb' })
    expect(validateLocator('pack:main/hair/braid')).toEqual({ ok: true, kind: 'url', normalized: 'pack:main/hair/braid' })
    expect(validateLocator('pack:a.b/c-d_e/f.glb', { contentRoot: ROOT_WIN }).ok).toBe(true)
  })

  it('the catalog refuses such a manifest (this is what POST /api/stage/assets runs)', () => {
    const cat = new AssetCatalog()
    const base = { kind: 'prop', name: 'X', license: { id: 'MIT', personalUse: true, commercialUse: true, redistribution: true } }
    for (const [i, loc] of ['asset:\\\\evil\\share\\x.vrm', 'pack:/etc/passwd', 'asset:C:/Windows/win.ini', 'asset://evil/share/x'].entries()) {
      const r = cat.add({ ...base, id: `p${i}`, locator: loc })
      expect(r.ok, loc).toBe(false)
      expect(!r.ok && r.code).toBe('unsafe_locator')
    }
    // and a thumbnail goes through the same door
    const t = cat.add({ ...base, id: 'thumb', locator: 'props/ok', thumbnail: 'asset:\\\\evil\\share\\t.png' })
    expect(!t.ok && t.code).toBe('unsafe_locator')
    const good = cat.add({ ...base, id: 'good', locator: 'asset://props/ok'.replace('//', '') })
    expect(good.ok && good.value.locator).toBe('asset:props/ok')
  })
})

describe('percent-encoding cannot hide an unsafe path (every decoded form is checked)', () => {
  const HIDDEN_IN_RELATIVE = [
    '%5c%5cevil%5cshare%5cx', // \\evil\share\x
    '%2f%2fevil%2fshare', // //evil/share
    '%43%3a%5cWindows%5cx', // C:\Windows\x
    '%43%3a/Windows/x',
    '%2fetc%2fpasswd',
    '%5cWindows%5cwin.ini',
    '%5C',
    '%2F',
    'a%3ab',
    'a%00b',
    'a%0ab',
    'a%0db',
    'con%2etxt',
    'x%2e',
    'a%2fb%2f%2e%2e%2f%2e%2e%2fc',
    'a%5cb', // an encoded backslash would become a separator only after decoding
    '%2e',
    '%2e%2e',
    'a%20', // decodes to a trailing space
    'a%2a', // decodes to a "*"
    '%zz',
    '%',
    'a%',
    '%c0%af', // overlong "/" is invalid UTF-8
    '%ef%bc%8f', // fullwidth "／" folds to "/" under NFKC
    '%ef%bc%8e%ef%bc%8e/x', // fullwidth ".." folds to ".."
    '%e2%80%ae', // a right-to-left override
    '%e2%80%8b', // a zero-width space
  ]
  it.each(HIDDEN_IN_RELATIVE)('refuses the relative locator %j', (s) => {
    for (const opts of CONFIGS) expect(validateLocator(s, opts).ok, `${s} ${JSON.stringify(opts)}`).toBe(false)
  })

  it('follows the decoding to a fixed point: ".." encoded to any depth is refused, whatever the depth', () => {
    const level = (n: number): string => {
      let s = '%2e%2e'
      for (let i = 1; i < n; i++) s = s.replace(/%/g, '%25')
      return s
    }
    for (let n = 1; n <= 12; n++) {
      expect(validateLocator(`${level(n)}/x`).ok, `level ${n}`).toBe(false)
      expect(validateLocator(`asset:${level(n)}/x`).ok, `asset: level ${n}`).toBe(false)
      expect(validateLocator(`https://cdn.example.com/${level(n)}/x`).ok, `https level ${n}`).toBe(false)
    }
    // "A" ("%41") encoded more often than the check is willing to look through
    expect(relativePathProblem(`%${'25'.repeat(MAX_DECODE_ROUNDS + 2)}41`)).toMatch(/nested too deeply/)
    // and exactly as often as it looks through is still decoded and judged
    expect(relativePathProblem(`%${'25'.repeat(MAX_DECODE_ROUNDS - 1)}41`)).toBeUndefined()
  })

  it('the compatibility forms are folded: fullwidth dots, slashes, colons and backslashes', () => {
    for (const s of ['\uff0e\uff0e/x', 'a/\uff0e\uff0e/b', '\u2025/x', 'a\uff1ab', '\uff3cwindows', '\uff0fetc\uff0fpasswd', 'a\uff3cb', 'CON\uff0etxt', 'com\u00b9', 'LPT\u00b2.txt', '\uff05\uff12\uff45\uff05\uff12\uff45/x']) {
      expect(validateLocator(s).ok, JSON.stringify(s)).toBe(false)
    }
  })

  it('invisible and control characters are refused in every position', () => {
    for (const ch of ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085', '\u200b', '\u200d', '\u202e', '\u2066', '\ufeff', '\u2028', '\u00ad', '\ud800']) {
      expect(validateLocator(`a${ch}b`).ok, JSON.stringify(ch)).toBe(false)
      expect(validateLocator(`asset:a${ch}b`).ok, `asset: ${JSON.stringify(ch)}`).toBe(false)
      expect(validateLocator(`https://cdn.example.com/a${ch}b`).ok, `https ${JSON.stringify(ch)}`).toBe(false)
    }
  })

  it('harmless encodings still work (a space, a plus, UTF-8 letters) and keep their written form', () => {
    expect(validateLocator('props/My%20Chair/a.glb')).toEqual({ ok: true, kind: 'relative', normalized: 'props/My%20Chair/a.glb' })
    expect(validateLocator('props/caf%C3%A9/a.glb').ok).toBe(true)
    expect(validateLocator('props/M\u00fcller/a.glb').ok).toBe(true)
    expect(validateLocator('https://cdn.example.com/a%20b/c.vrm').ok).toBe(true)
  })

  it('absolute locators below the content root follow the relative rules for what lies below it', () => {
    expect(validateLocator('C:\\Content\\Assets\\hair\\x.vrm', { contentRoot: ROOT_WIN }).ok).toBe(true)
    for (const s of ['C:\\Content\\Assets\\con\\x', 'C:\\Content\\Assets\\x.', 'C:\\Content\\Assets\\a:b', 'C:\\Content\\Assets\\%2e%2e\\x', 'C:\\Content\\Assets\\a%5cb', 'C:\\Content\\Assets\\a%00b', 'C:\\Content\\Assets\\a*b']) {
      expect(validateLocator(s, { contentRoot: ROOT_WIN }).ok, s).toBe(false)
    }
    expect(validateLocator('/srv/content/hair/x.vrm', { contentRoot: ROOT_POSIX }).ok).toBe(true)
    expect(validateLocator('/srv/content/%2e%2e/etc', { contentRoot: ROOT_POSIX }).ok).toBe(false)
  })

  it('mixed UNC prefixes ("\\/" and "/\\") are network paths too', () => {
    for (const s of ['\\/server/x', '/\\server/x', '\\\\server\\x', '//server/x']) {
      for (const opts of CONFIGS) {
        const r = validateLocator(s, opts)
        expect(r.ok, s).toBe(false)
        expect(!r.ok && r.reason, s).toMatch(/network|UNC/)
      }
    }
  })
})

describe('reserved names', () => {
  it.each(['con', 'PRN', 'aux.txt', 'NUL.tar.gz', 'com0', 'com9.dat', 'lpt1', 'LPT0.txt', 'conin$', 'CONOUT$', 'con .txt', 'a/con/b', 'a/COM1.x/b'])('refuses %s', (name) => {
    expect(validateLocator(name).ok).toBe(false)
  })
  it.each(['console', 'cone', 'com10', 'lpt10', 'comx', 'prn_file', 'auxiliary', 'null', 'nul_', 'a.con', 'a/b.con'])('accepts %s', (name) => {
    expect(validateLocator(name).ok, name).toBe(true)
  })
})

describe('URL hosts (SSRF)', () => {
  const NO = [
    'https://127.0.0.1:7421/api/stage',
    'https://localhost/x',
    'https://LOCALHOST:8080/x',
    'https://foo.localhost/x',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/x',
    'https://192.168.1.1/x',
    'https://172.16.0.1/x',
    'https://2130706433/x', // decimal 127.0.0.1
    'https://0x7f.1/x',
    'https://0x7f000001/x',
    'https://0/x',
    'https://017700000001/x',
    'https://a.local/x',
    'https://printer.lan/x',
    'https://svc.internal/x',
    'https://nas/x',
    'https://nas.home.arpa/x',
    'https://../x',
    'https://a..b/x',
    'https://-a.example.com/x',
    'https://cdn.example.com:99999/x',
  ]
  it.each(NO)('refuses %s by default', (s) => {
    expect(validateLocator(s).ok, s).toBe(false)
  })
  it('accepts public-looking names, with and without a port and path', () => {
    for (const s of ['https://cdn.example.com/a.vrm', 'https://cdn.example.com:8443/a/b.vrm', 'https://a.b.c.example.org', 'https://EXAMPLE.com./x', 'https://xn--bcher-kva.example/x']) {
      expect(validateLocator(s).ok, s).toBe(true)
    }
  })
  it('allowedHosts is an explicit allowlist: exact names and "*." wildcards, local ones included when listed', () => {
    const allowedHosts = ['cdn.example.com', '*.assets.example.org', 'localhost']
    expect(validateLocator('https://cdn.example.com/a', { allowedHosts }).ok).toBe(true)
    expect(validateLocator('https://eu.assets.example.org/a', { allowedHosts }).ok).toBe(true)
    expect(validateLocator('https://localhost:8080/a', { allowedHosts }).ok).toBe(true)
    expect(validateLocator('https://assets.example.org/a', { allowedHosts }).ok).toBe(false) // the wildcard needs a subdomain
    expect(validateLocator('https://evil.example.com/a', { allowedHosts }).ok).toBe(false)
    expect(validateLocator('https://cdn.example.com.evil.net/a', { allowedHosts }).ok).toBe(false)
    expect(validateLocator('https://127.0.0.1/a', { allowedHosts }).ok).toBe(false)
  })
  it('credentials, empty authority, odd authorities and a missing host stay refused', () => {
    for (const s of ['https://user:pw@cdn.example.com/x', 'https://user@cdn.example.com/x', 'https:///x', 'https://', 'https://cdn.example.com#@evil/x', 'https://cdn.example.com?x', 'https://[::1]/x', 'https://cdn.example.com\\@evil/x', 'https://%68ost.example.com/x']) {
      expect(validateLocator(s).ok, s).toBe(false)
    }
  })
})

describe('property: whatever is accepted is safe in every form a consumer could derive', () => {
  const decodeAll = (s: string): string => {
    let cur = s
    for (let i = 0; i < 12; i++) {
      let d: string
      try {
        d = decodeURIComponent(cur)
      } catch {
        return cur
      }
      if (d === cur) return cur
      cur = d
    }
    return cur
  }
  const segs = (p: string): string[] => p.split(/[\\/]+/).filter((x) => x !== '' && x !== '.')
  // eslint-disable-next-line no-control-regex
  const CONTROL = /[\u0000-\u001f\u007f]/

  const tokens = [
    '..', '.', '%2e', '%2E', '%2e%2e', '%252e', '%25252e', '%2525252e', '/', '\\', '%2f', '%2F', '%5c', '%5C', ':', 'C:', 'c:', '//', '\\\\', 'asset:', 'pack:', 'https://', 'file:', 'javascript:', 'data:',
    'a', 'b.txt', 'con', 'NUL', 'com1', '%00', '%0a', ' ', '@', 'evil.com', '127.0.0.1', '#', '?', '%', '%zz', '~1', '\u2025', '\uff0e', '\uff0f', '\u2215', '....//', '..;/', '%c0%af', '%ef%bc%8f', '%c0%ae',
    'x', 'y/z', '.vrm', '\u0000', '\u202e', '\u200b', 'cdn.example.com/', '%20', '%C3%A9',
  ]

  it('250k random locators built from hostile tokens', () => {
    const r = lcg(401)
    const problems = new Map<string, string>()
    let accepted = 0
    for (let i = 0; i < 250_000; i++) {
      let s = ''
      const n = 1 + Math.floor(r() * 7)
      for (let k = 0; k < n; k++) s += tokens[Math.floor(r() * tokens.length)]!
      for (const root of [undefined, ROOT_WIN]) {
        const res = validateLocator(s, root ? { contentRoot: root } : {})
        if (!res.ok) continue
        accepted++
        const full = decodeAll(res.normalized)
        const probs: string[] = []
        if (segs(full).includes('..')) probs.push('dotdot-after-full-decode')
        if (CONTROL.test(full)) probs.push('control-after-decode')
        if (res.kind === 'relative') {
          if (/^([A-Za-z]:|[\\/])/.test(full) || full.includes(':')) probs.push('absolute-or-drive-after-decode')
          if (full.includes('\\')) probs.push('backslash-after-decode')
        }
        if (res.kind === 'url' && !/^https:/i.test(res.normalized)) {
          const rest = res.normalized.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, '')
          if (/^[\\/]/.test(rest) || /^[A-Za-z]:/.test(rest) || /[\\]/.test(rest)) probs.push('os-path-behind-scheme')
          if (full.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, '').includes(':')) probs.push('colon-behind-scheme')
        }
        if (probs.length > 0) problems.set(probs.join('+'), `${JSON.stringify(s)} root=${root ?? 'none'} -> ${res.kind} ${JSON.stringify(res.normalized)}`)
      }
    }
    expect([...problems.entries()], 'accepted locators with a problem').toEqual([])
    expect(accepted).toBeGreaterThan(1000) // the generator does produce acceptable locators, so the property is not vacuous
  })

  it('the normalised form of an accepted locator is itself accepted and unchanged (idempotent)', () => {
    const r = lcg(77)
    let n = 0
    for (let i = 0; i < 60_000; i++) {
      let s = ''
      const k = 1 + Math.floor(r() * 5)
      for (let j = 0; j < k; j++) s += tokens[Math.floor(r() * tokens.length)]!
      const res = validateLocator(s, { contentRoot: ROOT_WIN })
      if (!res.ok || res.kind === 'absolute') continue
      n++
      const again = validateLocator(res.normalized, { contentRoot: ROOT_WIN })
      expect(again, JSON.stringify(s)).toEqual(res)
    }
    expect(n).toBeGreaterThan(500)
  })

  it('validation stays linear on 1 KB adversarial strings', () => {
    const shapes = ['.'.repeat(1000), '/'.repeat(1000), '%2e'.repeat(300), '%25'.repeat(300), 'a/'.repeat(500), 'a '.repeat(500), 'con.'.repeat(250), '\\'.repeat(1000), `asset:${'a/'.repeat(500)}`, `https://${'a.'.repeat(500)}`, 'x'.repeat(1000) + ':', '\uff0e'.repeat(500), '%ef%bc%8e'.repeat(100)]
    const t0 = performance.now()
    for (const s of shapes) for (let i = 0; i < 100; i++) validateLocator(s.slice(0, 1024), { contentRoot: ROOT_WIN })
    expect((performance.now() - t0) / (shapes.length * 100)).toBeLessThan(2)
  })
})

describe('thumbnails keep their own rule and use the locator rules for paths', () => {
  it('refuses a UNC or encoded-absolute thumbnail path but accepts a raster data URI', () => {
    expect(validateThumbnail('asset:\\\\evil\\share\\t.png').ok).toBe(false)
    expect(validateThumbnail('%2fetc%2fpasswd').ok).toBe(false)
    expect(validateThumbnail('data:image/png;base64,AAAA').ok).toBe(true)
  })
})
