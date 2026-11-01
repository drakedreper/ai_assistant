/**
 * cleanText is what every display name (characters, outfit presets) and every memory note passes through on its way in:
 * names reach the audit log, the dashboard and the stage, so a name cannot carry a second line, an invisible character or
 * a text-direction override, and a cut never splits an emoji.
 */
import { describe, expect, it } from 'vitest'
import { InMemoryCharacterRepo, createCharacterService, createSeedCatalog, createSequentialIds, createVirtualTime, createWardrobeService, seedBaseId } from '../src'
import { cleanText, truncateUnits } from '../src/util/safe'
import { T0 } from './helpers'

const lone = (code: number): string => String.fromCharCode(code)

describe('cleanText', () => {
  it('turns every kind of line break and tab into one space (a name cannot start a second log line)', () => {
    expect(cleanText('Mira\nINFO forged log line', 60)).toBe('Mira INFO forged log line')
    expect(cleanText('Mira\r\nSet-Cookie: x=1', 60)).toBe('Mira Set-Cookie: x=1')
    expect(cleanText('a\tb\vc\fd\u0085e f g', 60)).toBe('a b c d e f g')
    expect(cleanText('line\n\n\n\nbreaks', 60)).toBe('line breaks')
  })
  it('removes control characters, text-direction marks and overrides, zero-width and other invisible characters', () => {
    expect(cleanText('Mira‮evil', 60)).toBe('Miraevil')
    expect(cleanText('Mira‪evil‬⁦x⁩', 60)).toBe('Miraevilx')
    expect(cleanText('Mi​ra‌‍⁠﻿', 60)).toBe('Mira')
    expect(cleanText('Mi­ra', 60)).toBe('Mira') // soft hyphen
    expect(cleanText('Mi‎‏ra', 60)).toBe('Mira')
    expect(cleanText('a\u0000b\u0001c\u007Fd\u009Fe', 60)).toBe('abcde')
  })
  it('removes lone surrogates and keeps real emoji', () => {
    expect(cleanText(`a${lone(0xd83d)}b`, 60)).toBe('ab')
    expect(cleanText(`a${lone(0xde00)}b`, 60)).toBe('ab')
    expect(cleanText('Mira \u{1F600}', 60)).toBe('Mira \u{1F600}')
  })
  it('collapses and trims whitespace but keeps ordinary text, accents and other scripts', () => {
    expect(cleanText('   Mira    Lang  ', 60)).toBe('Mira Lang')
    expect(cleanText('Zoë Café', 60)).toBe('Zoë Café')
    expect(cleanText('あいう مرحبا', 60)).toBe('あいう مرحبا')
  })
  it('cuts to the limit without splitting a surrogate pair', () => {
    const name = `${'a'.repeat(59)}\u{1F600}`
    expect(name.length).toBe(61)
    expect(cleanText(name, 60)).toBe('a'.repeat(59))
    expect(cleanText(name, 61)).toBe(name)
    expect(cleanText('\u{1F600}\u{1F600}\u{1F600}', 3)).toBe('\u{1F600}')
    expect(cleanText('\u{1F600}', 1)).toBe('')
    expect(cleanText('abc', 0)).toBe('')
  })
  it('a cut that lands after a space does not leave trailing space', () => {
    expect(cleanText('abcd efgh', 5)).toBe('abcd')
  })
  it('never throws: non-strings give an empty string, odd limits are tolerated', () => {
    for (const v of [undefined, null, 5, {}, [], Symbol.iterator] as unknown[]) expect(cleanText(v as never, 60)).toBe('')
    expect(cleanText('abc', NaN)).toBe('abc')
    expect(cleanText('abc', -4)).toBe('')
    expect(cleanText('abc', Infinity)).toBe('abc')
    expect(cleanText('x'.repeat(2_000_000), 10)).toBe('x'.repeat(10))
  })
  it('is idempotent (cleaning clean text changes nothing)', () => {
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const pool = ['a', 'B', ' ', '\n', '\t', '‮', '​', '\u{1F600}', lone(0xd83d), '\u0000', 'é', 'あ', '-', '­']
    for (let i = 0; i < 300; i++) {
      let s = ''
      for (let j = rnd(40); j > 0; j--) s += pool[rnd(pool.length)]
      const once = cleanText(s, 30)
      expect(cleanText(once, 30)).toBe(once)
      expect(once.length).toBeLessThanOrEqual(30)
      expect(once).toBe(once.trim())
      expect(once).not.toMatch(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/)
    }
  })
  it('truncateUnits is a plain cut that respects pairs', () => {
    expect(truncateUnits('hello', 10)).toBe('hello')
    expect(truncateUnits('hello', 3)).toBe('hel')
    expect(truncateUnits('ab\u{1F600}', 3)).toBe('ab')
  })
})

describe('names that reach the audit log, the dashboard and the stage', () => {
  function rig() {
    const vt = createVirtualTime(T0)
    const catalog = createSeedCatalog()
    const newId = createSequentialIds()
    const characters = createCharacterService({ repo: new InMemoryCharacterRepo(), catalog, clock: vt.clock, newId })
    const wardrobe = createWardrobeService({ characters, catalog, newId })
    return { characters, wardrobe }
  }
  it.each([
    ['Mira\nINFO forged log line', 'Mira INFO forged log line'],
    ['Mira\r\nSet-Cookie: x=1', 'Mira Set-Cookie: x=1'],
    ['Mira‮evil', 'Miraevil'],
    ['Mi​ra', 'Mira'],
    [`${'a'.repeat(59)}\u{1F600}`, 'a'.repeat(59)],
  ])('a character named %j is called %j', (given, want) => {
    const { characters } = rig()
    const r = characters.create({ name: given, baseAssetId: seedBaseId('vrm1') })
    expect(r.ok && r.value.name).toBe(want)
    if (!r.ok) return
    const u = characters.update(r.value.id, { name: `${given}!` })
    expect(u.ok && u.value.name).toBe(cleanText(`${given}!`, 60))
  })
  it('a name made only of invisible characters is refused', () => {
    const { characters } = rig()
    expect(characters.create({ name: '​‮\n\t', baseAssetId: seedBaseId('vrm1') }).ok).toBe(false)
    const ok = characters.create({ name: 'Mira', baseAssetId: seedBaseId('vrm1') })
    if (!ok.ok) throw new Error(ok.error)
    expect(characters.update(ok.value.id, { name: '​‮' }).ok).toBe(false)
  })
  it('an outfit preset name is cleaned the same way', () => {
    const { characters, wardrobe } = rig()
    const c = characters.create({ name: 'Mira', baseAssetId: seedBaseId('vrm1') })
    if (!c.ok) throw new Error(c.error)
    const p = wardrobe.savePreset(c.value.id, 'Work\nINFO fake‮ line')
    expect(p.ok && p.value.name).toBe('Work INFO fake line')
  })
})
