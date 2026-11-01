import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateLocator, type LocatorOptions } from '../src'
import { lcg } from './helpers'

/**
 * The locator rules have a second implementation: the C# stage client for Unity (unity/Packages/com.mira.stage/Runtime/
 * AssetLocator.cs) turns a locator into a file it reads, so it must refuse exactly what validateLocator refuses. This file
 * is the shared truth: a few thousand hostile and ordinary locators with the verdict THIS validator gives, checked in as
 * unity/Packages/com.mira.stage/Tests~/golden/locators.json. The C# tests replay every case and compare the verdict, the
 * kind and the normalised form.
 *
 * Changing the rules of locator.ts changes the verdicts, so this test fails until the fixture is regenerated
 *
 *   UPDATE_GOLDEN=1 pnpm --filter @ai-assistant/stage-core exec vitest run test/locator.golden.test.ts
 *
 * and the C# port is brought in line (its tests then show which cases differ).
 */
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../unity/Packages/com.mira.stage/Tests~/golden/locators.json')

const ROOTS = { none: undefined, win: 'C:\\Content\\Assets', posix: '/srv/content' } as const
type Root = keyof typeof ROOTS
interface Case {
  l: string
  r: Root
  h?: string[]
}
interface Expected extends Case {
  ok: boolean
  kind?: string
  n?: string
}

const optionsOf = (c: Case): LocatorOptions => ({ ...(ROOTS[c.r] ? { contentRoot: ROOTS[c.r] } : {}), ...(c.h ? { allowedHosts: c.h } : {}) })

/** What the backend really sends (see the seed catalog) and what a content pack author would write. */
const ORDINARY = [
  'bases/vrm1/composed.vrm',
  'wardrobe/crisp-shirt',
  'environments/cerebral-void',
  'props/chair',
  'asset:props/chair',
  'ASSET:props\\\\chair/./x.glb',
  'pack:main/hair/braid',
  'pack:a.b/c-d_e/f.glb',
  'props/My%20Chair/a.glb',
  'props/caf%C3%A9/a.glb',
  'props/M\u00fcller/a.glb',
  '\u8863\u88c5/\u30b7\u30e3\u30c4.vrm',
  'a b/c d.vrm',
  './props/./chair',
  'props//chair',
  'props\\chair',
  'a.con',
  'a/b.con',
  'console',
  'com10',
  'lpt10',
  'null',
  'nul_',
  'prn_file',
  'auxiliary',
  'https://cdn.example.com/a.vrm',
  'https://cdn.example.com:8443/a/b.vrm',
  'https://a.b.c.example.org',
  'https://EXAMPLE.com./x',
  'https://xn--bcher-kva.example/x',
  'https://cdn.example.com/a%20b/c.vrm',
]

const NASTY = [
  'asset:\\\\evil\\share\\x.vrm', 'asset:C:\\Windows\\System32\\x', 'asset:C:/Windows/win.ini', 'asset:/C:/Windows/win.ini', 'asset:\\\\?\\C:\\x',
  'asset://evil/share/x', 'asset:/etc/passwd', 'pack:/etc/passwd', 'pack:\\Windows\\win.ini', 'pack:\\\\.\\pipe\\x', 'pack://host/x', 'asset:con',
  'asset:CON.txt', 'asset:a/nul', 'asset:a/COM1.txt', 'asset:x.', 'asset:a /b', 'asset:a/b:c', 'asset:file.txt::$DATA', 'asset:../x', 'pack:a/../../x',
  'asset:a\\..\\..\\x', 'asset:a\u0000b', 'asset:a?b', 'asset:a*b', 'asset:', 'asset:.', 'asset:/', 'asset:\\', 'asset:%5c%5cevil%5cshare%5cx',
  'asset:%2fetc%2fpasswd', 'asset:%43%3a%5cWindows%5cx', 'pack:%2e%2e/x', 'pack:a%00b', 'asset:con%2etxt', 'asset:a%3ab',
  'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain;base64,AAAA', 'ftp://cdn.example.com/x', 'http://cdn.example.com/x', 'ws://cdn.example.com/x',
  'C:\\Windows\\win.ini', 'C:/Windows/win.ini', 'C:', 'c:\\', '\\\\server\\share\\x', '//server/x', '\\/server/x', '/\\server/x', '/etc/passwd', '\\Windows\\win.ini',
  '..', '../x', 'a/../../x', 'a/..', 'a\\..\\..\\b', '.', './', '/', '\\', '', ' ', ' a', 'a ', 'a\tb', 'a\nb', 'a\r', 'a\u0000', '\u0000',
  'a:b', 'a/b:c', 'x.', 'x ', 'a/b.', 'a/b /c', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a/b?c', 'a/b*c',
]

const HIDDEN_IN_RELATIVE = [
  '%5c%5cevil%5cshare%5cx', '%2f%2fevil%2fshare', '%43%3a%5cWindows%5cx', '%43%3a/Windows/x', '%2fetc%2fpasswd', '%5cWindows%5cwin.ini', '%5C', '%2F', 'a%3ab',
  'a%00b', 'a%0ab', 'a%0db', 'con%2etxt', 'x%2e', 'a%2fb%2f%2e%2e%2f%2e%2e%2fc', 'a%5cb', '%2e', '%2e%2e', 'a%20', 'a%2a', '%zz', '%', 'a%', '%c0%af',
  '%ef%bc%8f', '%ef%bc%8e%ef%bc%8e/x', '%e2%80%ae', '%e2%80%8b', '%ed%a0%80', '%f4%90%80%80', '%c1%81', '%e0%80%80', '%80', '%ff', '%f0%9f%98%80',
  '%41', '%41%42%43/x', 'a%2', '%g1', '%1', '%25', '%2525', '%252e%252e/x', '%25252e%25252e/x',
]

const COMPAT = ['\uff0e\uff0e/x', 'a/\uff0e\uff0e/b', '\u2025/x', 'a\uff1ab', '\uff3cwindows', '\uff0fetc\uff0fpasswd', 'a\uff3cb', 'CON\uff0etxt', 'com\u00b9', 'LPT\u00b2.txt', '\uff05\uff12\uff45\uff05\uff12\uff45/x', '\ufb01le/x', 'caf\u00e9/x', 'cafe\u0301/x']

const RESERVED_NO = ['con', 'PRN', 'aux.txt', 'NUL.tar.gz', 'com0', 'com9.dat', 'lpt1', 'LPT0.txt', 'conin$', 'CONOUT$', 'con .txt', 'a/con/b', 'a/COM1.x/b']

const CONTROL = ['\u0000', '\u0007', '\u001b', '\u007f', '\u0085', '\u200b', '\u200d', '\u202e', '\u2066', '\ufeff', '\u2028', '\u2029', '\u00ad', '\ud800', '\udc00', '\ud83d', '\u{e0041}', '\u{1d173}', '\u{110bd}', '\u{1f600}']

const HOSTS_NO = [
  'https://127.0.0.1:7421/api/stage', 'https://localhost/x', 'https://LOCALHOST:8080/x', 'https://foo.localhost/x', 'https://169.254.169.254/latest/meta-data',
  'https://10.0.0.1/x', 'https://192.168.1.1/x', 'https://172.16.0.1/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://0x7f000001/x', 'https://0/x',
  'https://017700000001/x', 'https://a.local/x', 'https://printer.lan/x', 'https://svc.internal/x', 'https://nas/x', 'https://nas.home.arpa/x', 'https://../x',
  'https://a..b/x', 'https://-a.example.com/x', 'https://cdn.example.com:99999/x', 'https://user:pw@cdn.example.com/x', 'https://user@cdn.example.com/x',
  'https:///x', 'https://', 'https://cdn.example.com#@evil/x', 'https://cdn.example.com?x', 'https://[::1]/x', 'https://cdn.example.com\\@evil/x',
  'https://%68ost.example.com/x', 'https://cdn.example.com/../x', 'https://cdn.example.com/a/%2e%2e/x', 'https://cdn.example.com/a%5cb', 'https://cdn.example.com/a\u0000b',
  'https://\u0661\u0662\u0663.example.com/x', 'https://cdn.example.com:\u0661\u0662/x', 'https://cdn.example.com:08443/x', 'https://cdn.example.com:/x',
  'https://example.com../x', 'https://example.com.../x', 'https://example.com./x', 'https://a.com..:8443/x', 'https://localhost../x', 'https://127.0.0.1./x',
]

const ABSOLUTE = [
  'C:\\Content\\Assets\\hair\\x.vrm', 'C:\\Content\\Assets\\con\\x', 'C:\\Content\\Assets\\x.', 'C:\\Content\\Assets\\a:b', 'C:\\Content\\Assets\\%2e%2e\\x',
  'C:\\Content\\Assets\\a%5cb', 'C:\\Content\\Assets\\a%00b', 'C:\\Content\\Assets\\a*b', 'c:/content/assets/Hair/X.vrm', 'C:\\Content\\Assets', 'C:\\Content\\Assets\\',
  'C:\\Content\\AssetsEvil\\x', 'C:\\Content\\Other\\x', 'D:\\Content\\Assets\\x', 'C:\\Content\\Assets\\..\\Secret\\x', '/srv/content/hair/x.vrm', '/srv/content/%2e%2e/etc',
  '/srv/content', '/srv/content/', '/srv/contentevil/x', '/srv/Content/x', '/srv/content/a/../../etc/passwd', '/srv/content//a///b.vrm', '/etc/passwd',
]

const HOST_LISTS: Array<{ urls: string[]; hosts: string[] }> = [
  {
    hosts: ['cdn.example.com', '*.assets.example.org', 'localhost'],
    urls: [
      'https://cdn.example.com/a', 'https://eu.assets.example.org/a', 'https://localhost:8080/a', 'https://assets.example.org/a', 'https://evil.example.com/a',
      'https://cdn.example.com.evil.net/a', 'https://127.0.0.1/a', 'https://CDN.EXAMPLE.COM/a', 'https://a.b.assets.example.org/x',
    ],
  },
  {
    // an allowlist entry with a trailing dot, and hosts with one, two and three trailing dots: ONE dot is dropped, not all
    hosts: ['cdn.example.com.', '*.example.org.', 'EXAMPLE.net'],
    urls: [
      'https://cdn.example.com/a', 'https://cdn.example.com./a', 'https://cdn.example.com../a', 'https://cdn.example.com.../a', 'https://eu.example.org/a',
      'https://eu.example.org../a', 'https://example.net/a', 'https://example.net../a', 'https://sub.example.net/a',
    ],
  },
]

const TOKENS = [
  '..', '.', '%2e', '%2E', '%2e%2e', '%252e', '%25252e', '%2525252e', '/', '\\', '%2f', '%2F', '%5c', '%5C', ':', 'C:', 'c:', '//', '\\\\', 'asset:', 'pack:', 'https://',
  'file:', 'javascript:', 'data:', 'a', 'b.txt', 'con', 'NUL', 'com1', '%00', '%0a', ' ', '@', 'evil.com', '127.0.0.1', '#', '?', '%', '%zz', '~1', '\u2025', '\uff0e',
  '\uff0f', '\u2215', '....//', '..;/', '%c0%af', '%ef%bc%8f', '%c0%ae', 'x', 'y/z', '.vrm', '\u0000', '\u202e', '\u200b', 'cdn.example.com/', '%20', '%C3%A9',
  'bases/', 'wardrobe/', 'hair/braid', '\u00e9', '\u00fc', '\u8863', 'Con', 'lpt9', 'x.', 'x ', '*', '<', '"', '|', '$DATA', '::',
]

const GOOD_SEGMENTS = ['bases', 'vrm1', 'composed.vrm', 'wardrobe', 'crisp-shirt', 'props', 'chair', 'a', 'b', 'x.glb', 'My Chair', 'caf\u00e9', '\u8863\u88c5', '\u30b7\u30e3\u30c4.vrm', 'hair', 'braid', 'env_1', 'v1.2', 'A-B_C', '1', 'a.b.c']
const PREFIXES = ['', '', '', '', 'asset:', 'pack:', 'ASSET:', 'https://cdn.example.com/', 'C:\\Content\\Assets\\', 'c:/content/assets/', '/srv/content/', './']
const SEPARATORS = ['/', '/', '/', '\\', '//', '/./']
const MUTATIONS = [null, null, null, null, null, '..', '.', ':', ' ', '%2e', '%2f', '%20', '*', '\u200b', '\uff0e', 'con', 'nul.txt', 'x.', '\\\\', '%', '\u00e9']

function buildCorpus(): Case[] {
  const out: Case[] = []
  const add = (l: string, r: Root = 'none', h?: string[]): void => {
    out.push({ l, r, ...(h ? { h } : {}) })
  }
  for (const s of [...ORDINARY, ...NASTY, ...HIDDEN_IN_RELATIVE, ...COMPAT, ...RESERVED_NO, ...HOSTS_NO]) add(s)
  // the same strings are judged the same way with a content root set (it only matters for absolute paths)
  for (const s of [...ORDINARY, ...NASTY, ...HIDDEN_IN_RELATIVE]) {
    add(s, 'win')
    add(s, 'posix')
  }
  for (const s of ABSOLUTE) for (const r of ['none', 'win', 'posix'] as const) add(s, r)
  for (const ch of CONTROL) for (const s of [`a${ch}b`, `asset:a${ch}b`, `https://cdn.example.com/a${ch}b`, `${ch}a`, `a${ch}`]) add(s)
  for (let n = 1; n <= 8; n++) {
    let level = '%2e%2e'
    for (let i = 1; i < n; i++) level = level.replace(/%/g, '%25')
    for (const s of [`${level}/x`, `asset:${level}/x`, `https://cdn.example.com/${level}/x`, `a/${level}`]) add(s)
  }
  for (const depth of [2, 3, 4, 5, 6, 7]) add(`%${'25'.repeat(depth)}41`)
  for (const l of ['a', 'a/b', 'x'.repeat(1023), 'x'.repeat(1024), 'x'.repeat(1025), `asset:${'a/'.repeat(500)}`, `https://${'a.'.repeat(500)}`]) add(l)
  for (const group of HOST_LISTS) for (const u of group.urls) add(u, 'none', group.hosts)
  // random strings built from hostile tokens (a fixed seed: the corpus never changes by itself)
  const r = lcg(401)
  for (let i = 0; i < 1400; i++) {
    let s = ''
    const n = 1 + Math.floor(r() * 7)
    for (let k = 0; k < n; k++) s += TOKENS[Math.floor(r() * TOKENS.length)]!
    add(s, (['none', 'win', 'posix'] as const)[i % 3])
  }
  // plausible paths (what a content pack really holds) with at most one hostile mutation: mostly accepted, so a port that
  // wrongly REFUSES good locators fails too, not only one that wrongly accepts bad ones
  const g = lcg(7)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(g() * xs.length)]!
  for (let i = 0; i < 900; i++) {
    const parts: string[] = []
    const n = 1 + Math.floor(g() * 4)
    for (let k = 0; k < n; k++) parts.push(pick(GOOD_SEGMENTS))
    const mutation = pick(MUTATIONS)
    if (mutation !== null) parts.splice(Math.floor(g() * (parts.length + 1)), 0, mutation)
    let s = pick(PREFIXES)
    parts.forEach((p, k) => {
      s += (k > 0 ? pick(SEPARATORS) : '') + p
    })
    add(s, (['none', 'win', 'posix'] as const)[Math.floor(g() * 3)])
  }
  return out
}

function expectedOf(c: Case): Expected {
  const res = validateLocator(c.l, optionsOf(c))
  return res.ok ? { ...c, ok: true, kind: res.kind, n: res.normalized } : { ...c, ok: false }
}

/**
 * A string with a LONE surrogate cannot travel as a JSON string: Newtonsoft (and others) replace the escape with U+FFFD on
 * reading, so the C# side would judge a different, harmless string. Such a case is written as its UTF-16 code units
 * (`lu`) instead of `l`.
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
type Wire = Omit<Expected, 'l'> & { l?: string; lu?: number[] }

function toWire(c: Expected): Wire {
  if (!LONE_SURROGATE.test(c.l)) return c
  const { l, ...rest } = c
  return { lu: Array.from({ length: l.length }, (_, i) => l.charCodeAt(i)), ...rest }
}

function fromWire(w: Wire): Expected {
  const { lu, l, ...rest } = w
  return { l: lu ? String.fromCharCode(...lu) : l!, ...rest }
}

const BACKSLASH = String.fromCharCode(92)

/**
 * Pure ASCII: every code unit outside the printable range becomes a escape. JSON.stringify leaves DEL, the C1 controls
 * (U+0085), the line and paragraph separators and every invisible format character as raw bytes, which an editor, a diff
 * tool or an LLM tool call can silently change; the hostile characters ARE the test data here, so they must not be able to.
 */
const asciiOnly = (json: string): string => json.replace(/[^ -~]/g, (ch) => `${BACKSLASH}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** One case per line so a change shows up as a readable diff. */
function render(cases: Expected[]): string {
  return `[\n${cases.map((c) => `  ${asciiOnly(JSON.stringify(toWire(c)))}`).join(',\n')}\n]\n`
}

describe('the locator corpus the C# port is checked against (golden/locators.json)', () => {
  const corpus = buildCorpus()

  it('is large, varied and not vacuous: it contains both accepted and refused locators of every kind', () => {
    const results = corpus.map(expectedOf)
    expect(results.length).toBeGreaterThan(3000)
    expect(new Set(results.map((c) => c.l)).size).toBeGreaterThan(2400)
    const accepted = results.filter((c) => c.ok)
    const count = (kind: string): number => accepted.filter((c) => c.kind === kind).length
    expect(count('relative')).toBeGreaterThan(300)
    expect(count('url')).toBeGreaterThan(100)
    expect(count('absolute')).toBeGreaterThan(20)
    expect(accepted.length).toBeGreaterThan(600)
    expect(results.length - accepted.length).toBeGreaterThan(1500)
  })

  it('matches the checked-in fixture, case for case (UPDATE_GOLDEN=1 rewrites it)', () => {
    const results = corpus.map(expectedOf)
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(path.dirname(FILE), { recursive: true })
      writeFileSync(FILE, render(results))
      return
    }
    const onDisk = (JSON.parse(readFileSync(FILE, 'utf8')) as Wire[]).map(fromWire)
    expect(onDisk.length).toBe(results.length)
    const differing = results.filter((c, i) => JSON.stringify(c) !== JSON.stringify(onDisk[i]))
    expect(differing.slice(0, 5), `${differing.length} cases differ from golden/locators.json; regenerate it and update AssetLocator.cs`).toEqual([])
  })

  it('the checked-in fixture is pure ASCII (hostile characters are escapes, so nothing can mangle them)', () => {
    const text = readFileSync(FILE, 'utf8')
    let bad = 0
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      // a line feed, or a carriage return (git on Windows checks text files out with CRLF under core.autocrlf)
      if (code !== 10 && code !== 13 && (code < 32 || code > 126)) bad++
    }
    expect(bad).toBe(0)
    expect(text.length).toBeGreaterThan(100_000)
  })

  it('lone surrogates survive the round trip through the wire form (they are what the JSON string form would lose)', () => {
    const lone = corpus.filter((c) => LONE_SURROGATE.test(c.l))
    expect(lone.length).toBeGreaterThanOrEqual(10)
    for (const c of lone) {
      const w = toWire(expectedOf(c))
      expect(w.l, 'a lone surrogate must not be written as a JSON string').toBeUndefined()
      expect(fromWire(JSON.parse(JSON.stringify(w)) as Wire).l).toBe(c.l)
    }
  })

  it('every checked-in verdict is internally consistent: refused cases carry no kind, accepted ones are idempotent', () => {
    const onDisk = (JSON.parse(readFileSync(FILE, 'utf8')) as Wire[]).map(fromWire)
    for (const c of onDisk) {
      if (!c.ok) {
        expect(c.kind, c.l).toBeUndefined()
        continue
      }
      expect(c.n, c.l).toBeTypeOf('string')
      if (c.kind !== 'absolute') {
        const again = validateLocator(c.n!, optionsOf(c))
        expect(again.ok, `${JSON.stringify(c.l)} -> ${JSON.stringify(c.n)}`).toBe(true)
      }
    }
  })
})
