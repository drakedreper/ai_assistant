import { describe, expect, it } from 'vitest'
import { Emotion } from '@ai-assistant/shared'
import { EMOTION_TAGS, EmotionStreamParser, isEmotion, parseEmotionText, parseSentences, stripEmotionTags } from '../src'
import type { EmotionEvent, EmotionParserOptions } from '../src'

/** Merge adjacent text events so streams cut into different chunks can be compared. */
function normalize(events: EmotionEvent[]): EmotionEvent[] {
  const out: EmotionEvent[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (e.type === 'text' && last?.type === 'text' && last.emotion === e.emotion) last.text += e.text
    else out.push({ ...e })
  }
  return out
}

function run(chunks: string[], opts?: EmotionParserOptions): EmotionEvent[] {
  const p = new EmotionStreamParser(opts)
  const events: EmotionEvent[] = []
  for (const c of chunks) events.push(...p.push(c))
  events.push(...p.flush())
  return normalize(events)
}

const visible = (events: EmotionEvent[]): string => events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')

describe('vocabulary', () => {
  it('is exactly the shared Emotion enum', () => {
    expect([...EMOTION_TAGS]).toEqual([...Emotion.options])
    expect(EMOTION_TAGS).toEqual(['neutral', 'happy', 'sad', 'angry', 'relaxed', 'surprised', 'shy', 'thinking'])
  })
  it('isEmotion is a strict guard', () => {
    for (const t of EMOTION_TAGS) expect(isEmotion(t)).toBe(true)
    expect(isEmotion('excited')).toBe(false)
    expect(isEmotion('Happy')).toBe(false)
  })
})

describe('basic parsing', () => {
  it('strips a leading tag and reports the emotion', () => {
    expect(parseEmotionText('[happy] Good morning!')).toEqual([{ emotion: 'happy', text: 'Good morning!' }])
  })

  it('splits at every tag, keeping each sentence with its own emotion', () => {
    expect(parseEmotionText('[happy] Good morning! [thinking] Let me look at your day. [relaxed] Done.')).toEqual([
      { emotion: 'happy', text: 'Good morning!' },
      { emotion: 'thinking', text: 'Let me look at your day.' },
      { emotion: 'relaxed', text: 'Done.' },
    ])
  })

  it('defaults to neutral when there is no tag', () => {
    expect(parseEmotionText('Just words, no tag.')).toEqual([{ emotion: 'neutral', text: 'Just words, no tag.' }])
  })

  it('a missing tag keeps the previous emotion', () => {
    const segs = parseSentences('[sad] That is hard. I am sorry about it.')
    expect(segs).toEqual([
      { emotion: 'sad', text: 'That is hard.' },
      { emotion: 'sad', text: 'I am sorry about it.' },
    ])
  })

  it('tags without spaces still work', () => {
    expect(parseEmotionText('[happy]Tight.[sad]Also tight.')).toEqual([
      { emotion: 'happy', text: 'Tight.' },
      { emotion: 'sad', text: 'Also tight.' },
    ])
  })

  it('is case-insensitive for the closed vocabulary', () => {
    expect(parseEmotionText('[Happy] One. [SAD] Two.')).toEqual([
      { emotion: 'happy', text: 'One.' },
      { emotion: 'sad', text: 'Two.' },
    ])
  })

  it('two tags in a row: the last one wins and no empty segment appears', () => {
    expect(parseEmotionText('[happy] [sad] Hmm.')).toEqual([{ emotion: 'sad', text: 'Hmm.' }])
  })

  it('a trailing tag with no text after it produces no segment', () => {
    expect(parseEmotionText('Done. [happy]')).toEqual([{ emotion: 'neutral', text: 'Done.' }])
  })

  it('every vocabulary tag is recognised', () => {
    for (const tag of EMOTION_TAGS) expect(parseEmotionText(`[${tag}] Hi.`)).toEqual([{ emotion: tag, text: 'Hi.' }])
  })

  it('keeps line breaks and markdown inside a segment', () => {
    expect(parseEmotionText('[neutral] Line one\n\n- item a\n- item b')[0]?.text).toBe('Line one\n\n- item a\n- item b')
  })

  it('handles CRLF line endings', () => {
    const segs = parseEmotionText('[happy] Line one\r\n[sad] Line two\r\n')
    expect(segs).toEqual([
      { emotion: 'happy', text: 'Line one' },
      { emotion: 'sad', text: 'Line two' },
    ])
  })

  it('an empty stream yields nothing', () => {
    expect(run([])).toEqual([])
    expect(run([''])).toEqual([])
  })

  it('reset returns to neutral', () => {
    const p = new EmotionStreamParser()
    p.push('[angry] Grr.')
    p.flush()
    expect(p.currentEmotion).toBe('angry')
    p.reset()
    expect(p.currentEmotion).toBe('neutral')
  })
})

describe('tolerance: never swallow real text', () => {
  it('a literal "[" that is not a tag passes through', () => {
    expect(visible(run(['array[0] and [1] and [x] and [ ] and [a b]']))).toBe('array[0] and [1] and [x] and [ ] and [a b]')
  })

  it('an unclosed bracket at the end of the stream passes through', () => {
    expect(visible(run(['See [unclosed']))).toBe('See [unclosed')
    expect(visible(run(['[hap']))).toBe('[hap')
    expect(visible(run(['[']))).toBe('[')
  })

  it('an unclosed bracket followed by more text passes through', () => {
    expect(visible(run(['[note that this is fine and goes on']))).toBe('[note that this is fine and goes on')
  })

  it('a very long bracketed word is not buffered forever', () => {
    const p = new EmotionStreamParser()
    const out = p.push('[abcdefghijklmnopqrstuvwxyz')
    expect(visible(out)).toContain('[abcdefghijklm')
  })

  it('an unknown tag-shaped token opening a sentence is stripped and counts as neutral', () => {
    const ev = run(['[excited] Hello there! [happy] And this.'])
    expect(ev[0]).toEqual({ type: 'emotion', emotion: 'neutral', known: false })
    expect(visible(ev)).toBe('Hello there!And this.')
    expect(parseEmotionText('[excited] Hello there!')).toEqual([{ emotion: 'neutral', text: 'Hello there!' }])
  })

  it('an unknown tag in the middle of a sentence passes through', () => {
    expect(visible(run(['I saw a [thing] there']))).toBe('I saw a [thing] there')
  })

  it("unknownTags: 'passthrough' keeps unknown tags everywhere", () => {
    expect(visible(run(['[excited] Hello!'], { unknownTags: 'passthrough' }))).toBe('[excited] Hello!')
  })

  it('a known tag used as a markdown link label is kept', () => {
    expect(visible(run(['See [happy](https://example.com) for more.']))).toBe('See [happy](https://example.com) for more.')
  })

  it('a known tag followed by "(" in the next chunk is still a link', () => {
    const ev = run(['See [happy', '](https://example.com)'])
    expect(visible(ev)).toBe('See [happy](https://example.com)')
    expect(ev.some((e) => e.type === 'emotion')).toBe(false)
  })

  it('tags inside inline code and fences are left alone', () => {
    expect(visible(run(['Write `[happy]` in the file.']))).toBe('Write `[happy]` in the file.')
    expect(visible(run(['Look:\n```\n[sad] stays\n```\ndone']))).toBe('Look:\n```\n[sad] stays\n```\ndone')
  })

  it('a stray backtick does not disable tags in the next paragraph', () => {
    expect(parseEmotionText('A stray ` tick.\n\n[happy] Real tag.').pop()).toEqual({ emotion: 'happy', text: 'Real tag.' })
  })

  it('double bracket: the first "[" is literal, the second can still open a tag', () => {
    const ev = run(['[[happy] hi'])
    expect(visible(ev)).toBe('[hi')
    expect(ev.find((e) => e.type === 'emotion')).toEqual({ type: 'emotion', emotion: 'happy', known: true })
  })

  it('keeps emoji and non-ASCII text intact', () => {
    expect(parseEmotionText('[happy] Grüße 😀 こんにちは.')).toEqual([{ emotion: 'happy', text: 'Grüße 😀 こんにちは.' }])
  })
})

describe('sentence boundaries (for TTS)', () => {
  it('emits one sentence event per sentence, tag stripped', () => {
    expect(parseSentences('[happy] Good morning! I read your night so you do not have to. [thinking] Hmm?')).toEqual([
      { emotion: 'happy', text: 'Good morning!' },
      { emotion: 'happy', text: 'I read your night so you do not have to.' },
      { emotion: 'thinking', text: 'Hmm?' },
    ])
  })

  it('does not split on decimals, abbreviations or domain names', () => {
    expect(parseSentences('It costs 3.5 dollars. Dr. Smith agreed, e.g. about example.com. Fine.').map((s) => s.text)).toEqual(['It costs 3.5 dollars.', 'Dr. Smith agreed, e.g. about example.com.', 'Fine.'])
  })

  it('closing quotes and brackets stay with their sentence', () => {
    expect(parseSentences('He said "go." Then left (quietly.) Done.').map((s) => s.text)).toEqual(['He said "go."', 'Then left (quietly.)', 'Done.'])
  })

  it('a newline ends a sentence', () => {
    expect(parseSentences('- first item\n- second item').map((s) => s.text)).toEqual(['- first item', '- second item'])
  })

  it('an unfinished sentence is emitted on flush', () => {
    expect(parseSentences('[sad] Half a thought')).toEqual([{ emotion: 'sad', text: 'Half a thought' }])
  })

  it('the sentence event arrives as soon as the following whitespace does, before the next sentence starts', () => {
    const p = new EmotionStreamParser()
    expect(p.push('[happy] Hello there.').some((e) => e.type === 'sentence')).toBe(false)
    const next = p.push(' ')
    expect(next).toEqual([{ type: 'sentence', emotion: 'happy', text: 'Hello there.' }])
  })

  it('flush finishes the sentence but keeps the emotion (a tool boundary)', () => {
    const p = new EmotionStreamParser()
    p.push('[thinking] Let me check your calendar.')
    const ev = p.flush()
    expect(ev).toEqual([{ type: 'sentence', emotion: 'thinking', text: 'Let me check your calendar.' }])
    expect(p.currentEmotion).toBe('thinking')
    expect(visible(normalize(p.push('You have two events.')))).toBe('You have two events.')
  })
})

describe('streaming: chunking never changes the result', () => {
  const samples = [
    '[happy] Good morning! [thinking] Let me look at your day. [relaxed] Done.',
    '[neutral] Hello.\n\n[sad] Oh no.\n[angry] Hmm!',
    'No tag at all, just words. And another sentence?',
    '[happy]Tight tags.[sad]No spaces.',
    'It costs 3.5 dollars, e.g. about Dr. Smith said hi. [shy] ok',
    '[excited] Unknown at start. [happy] known',
    'A literal [1] citation and [x] box and [unclosed',
    '[happy](http://example.com) link and [happy] tag',
    'Use `[happy]` in code and ```\n[sad]\n``` fence. [happy] real',
    '[[happy] double bracket',
    '[Happy] Case insensitive. [SAD] shouting',
    '[happy] [sad] two in a row',
    'Trailing tag [happy]',
    '[hap',
    'Emoji 😀 text [happy] 😀 done 🎉.',
    '[happy] Line one\r\n[sad] Line two\r\n',
    '[surprised] Wait, [thinking] really? [relaxed] Fine.',
  ]

  for (const sample of samples) {
    const whole = run([sample])
    const label = JSON.stringify(sample).slice(0, 48)

    it(`every single split point: ${label}`, () => {
      for (let i = 0; i <= sample.length; i++) expect(run([sample.slice(0, i), sample.slice(i)]), `split at ${i}`).toEqual(whole)
    })

    it(`every pair of split points: ${label}`, () => {
      const n = Math.min(sample.length, 60)
      for (let i = 0; i <= n; i++) for (let j = i; j <= n; j++) expect(run([sample.slice(0, i), sample.slice(i, j), sample.slice(j)]), `splits at ${i},${j}`).toEqual(whole)
    })

    it(`one character at a time: ${label}`, () => {
      expect(run([...sample].map((c) => c))).toEqual(whole)
    })

    if (!sample.includes('`')) it(`never leaks a known tag into the text: ${label}`, () => {
      for (const ev of whole) if (ev.type === 'text' || ev.type === 'sentence') expect(ev.text).not.toMatch(/\[(neutral|happy|sad|angry|relaxed|surprised|shy|thinking)\](?!\()/i)
    })
  }

  it('the example from the spec: "[ha" then "ppy] Hi"', () => {
    const p = new EmotionStreamParser()
    expect(p.push('[ha')).toEqual([])
    const ev = normalize([...p.push('ppy] Hi'), ...p.flush()])
    expect(ev).toEqual([
      { type: 'emotion', emotion: 'happy', known: true },
      { type: 'text', emotion: 'happy', text: 'Hi' },
      { type: 'sentence', emotion: 'happy', text: 'Hi' },
    ])
  })

  it('visible text equals the input with tags (and the space before them) removed, for random tag placement', () => {
    // Deterministic pseudo-random sentences, chunked at pseudo-random sizes.
    let seed = 42
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed % n
    }
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
    for (let round = 0; round < 40; round++) {
      const sentences: string[] = []
      for (let s = 0; s < 1 + rnd(5); s++) {
        const body = Array.from({ length: 1 + rnd(6) }, () => words[rnd(words.length)]).join(' ')
        sentences.push(`[${EMOTION_TAGS[rnd(EMOTION_TAGS.length)]}] ${body}${['.', '!', '?'][rnd(3)]}`)
      }
      const input = sentences.join(' ')
      const chunks: string[] = []
      for (let i = 0; i < input.length; ) {
        const size = 1 + rnd(9)
        chunks.push(input.slice(i, i + size))
        i += size
      }
      // Whitespace before a tag is dropped (the tag separates parts), so the parts concatenate without it.
      const expected = sentences.map((s) => s.replace(/^\[[a-z]+\]\s*/, '')).join('')
      expect(visible(run(chunks))).toBe(expected)
      expect(run(chunks)).toEqual(run([input]))
    }
  })
})

describe('stripEmotionTags (for stored text)', () => {
  it('removes known tags and the space after them, keeping everything else', () => {
    expect(stripEmotionTags('[happy] Hi.\n\n[sad] Oh no. And [thinking]hmm.')).toBe('Hi.\n\nOh no. And hmm.')
  })
  it('leaves unknown tags, links and code alone', () => {
    expect(stripEmotionTags('[excited] x [happy](u) `[happy]` ```\n[sad]\n```')).toBe('[excited] x [happy](u) `[happy]` ```\n[sad]\n```')
  })
  it('is a no-op on text without tags', () => {
    expect(stripEmotionTags('plain [1] text')).toBe('plain [1] text')
  })
})
