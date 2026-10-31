/**
 * Emotion-tag protocol (docs/PERSONA.md section 11).
 *
 * The persona opens each spoken sentence with one tag from a CLOSED vocabulary, for example
 * "[happy] Good morning!". The tag drives the avatar's expression and must never reach the chat text or the TTS
 * engine. This module turns a raw token stream (chunks can split a tag anywhere: "[ha" then "ppy] Hi") into:
 *
 *   - `emotion`  a tag was consumed; a new span starts here
 *   - `text`     clean text, safe for chat (never contains a tag)
 *   - `sentence` a finished sentence, tag stripped, for TTS
 *
 * Rules (all decided one character at a time, so the output never depends on where the chunks were cut):
 *   - A known tag (case-insensitive) is a tag wherever it appears outside code, unless a "(" follows
 *     (a markdown link such as "[happy](url)").
 *   - A tag-shaped but unknown token ("[excited]", lowercase letters only) is stripped and treated as neutral when it
 *     opens a sentence (PERSONA.md); anywhere else it passes through. `unknownTags: 'passthrough'` keeps it always.
 *   - Everything else that merely contains "[" (citations "[1]", "[x]", "[unclosed", a lone "[") passes through
 *     verbatim. Real text is never swallowed; a tag candidate is abandoned at the first character that cannot
 *     belong to a tag, so buffering is bounded (at most 18 characters).
 *   - Code spans and fences are never inspected for tags.
 *   - A missing tag keeps the previous emotion. A new parser starts at neutral.
 */
import { Emotion } from '@ai-assistant/shared'

export type { Emotion }

/** The closed vocabulary, straight from the shared enum so the two can never drift. */
export const EMOTION_TAGS: readonly Emotion[] = Emotion.options

const KNOWN = new Set<string>(EMOTION_TAGS)

export const isEmotion = (value: string): value is Emotion => KNOWN.has(value)

export type EmotionEvent =
  /** A tag was consumed. `known` is false for a stripped out-of-vocabulary tag (emotion is then neutral). */
  | { type: 'emotion'; emotion: Emotion; known: boolean }
  /** Clean text, in order. Concatenating every `text` event reproduces the visible reply. */
  | { type: 'text'; emotion: Emotion; text: string }
  /** A sentence finished (terminator then whitespace, a newline, the next tag, or flush). Tag already stripped. */
  | { type: 'sentence'; emotion: Emotion; text: string }

export interface EmotionParserOptions {
  /** What to do with a tag-shaped token that is not in the vocabulary. Default 'strip' (PERSONA.md). */
  unknownTags?: 'strip' | 'passthrough'
  /** Emotion before any tag has been seen. Default 'neutral'. */
  initialEmotion?: Emotion
}

/** The longest unknown tag we will wait for: "[" plus this many letters plus "]". */
const MAX_TAG_LETTERS = 16

const TERMINATORS = new Set(['.', '!', '?', '…', '。', '！', '？'])
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '»'])
/** "Dr. Smith" must not read as two sentences. */
const ABBREVIATION = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|e\.g|i\.e)\.$/i

const isWhitespace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' '
const isAsciiLetter = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')

class Sink {
  readonly events: EmotionEvent[] = []

  text(emotion: Emotion, text: string): void {
    if (!text) return
    const last = this.events[this.events.length - 1]
    if (last && last.type === 'text' && last.emotion === emotion) last.text += text
    else this.events.push({ type: 'text', emotion, text })
  }
}

type Mode = 'text' | 'tag' | 'tag_close'

export class EmotionStreamParser {
  private readonly unknownTags: 'strip' | 'passthrough'
  private readonly initialEmotion: Emotion

  private emotion: Emotion
  private mode: Mode = 'text'
  /** The candidate tag being buffered, including the opening "[". */
  private tagBuf = ''
  /** Whitespace seen but not yet emitted: it is dropped if a tag follows, emitted with the next real character. */
  private pendingWs = ''
  /** Clean text of the sentence in progress (no leading whitespace). */
  private sentence = ''
  private afterTerminator = false
  /** Swallow whitespace until the first real character (stream start, right after a tag, after a flush). */
  private dropWs = true
  private ticks = 0
  private inSpan = false
  private inFence = false

  constructor(opts: EmotionParserOptions = {}) {
    this.unknownTags = opts.unknownTags ?? 'strip'
    this.initialEmotion = opts.initialEmotion ?? 'neutral'
    this.emotion = this.initialEmotion
  }

  /** The emotion in force right now (the last tag seen). */
  get currentEmotion(): Emotion {
    return this.emotion
  }

  /** Feed the next raw chunk; returns whatever became decidable. Tags split across chunks are handled. */
  push(chunk: string): EmotionEvent[] {
    const sink = new Sink()
    for (const ch of chunk) this.step(ch, sink)
    return sink.events
  }

  /**
   * End of a segment (a tool call starts, or the turn ends): resolve anything pending as literal text or a tag,
   * emit the unfinished sentence, drop trailing whitespace. The current emotion is kept, and the parser can keep
   * being used.
   */
  flush(): EmotionEvent[] {
    const sink = new Sink()
    if (this.mode === 'tag') {
      const buf = this.tagBuf
      this.mode = 'text'
      this.tagBuf = ''
      for (const c of buf) this.textChar(c, sink)
    } else if (this.mode === 'tag_close') {
      const buf = this.tagBuf
      this.mode = 'text'
      this.tagBuf = ''
      this.acceptTag(buf, sink)
    }
    this.completeSentence(sink)
    this.pendingWs = ''
    this.dropWs = true
    this.ticks = 0
    this.inSpan = false
    this.inFence = false
    return sink.events
  }

  /** Back to the initial state (a new reply). Drops anything buffered without emitting it. */
  reset(): void {
    this.emotion = this.initialEmotion
    this.mode = 'text'
    this.tagBuf = ''
    this.pendingWs = ''
    this.sentence = ''
    this.afterTerminator = false
    this.dropWs = true
    this.ticks = 0
    this.inSpan = false
    this.inFence = false
  }

  // ------------------------------------------------------------------ state machine

  private step(ch: string, sink: Sink): void {
    if (this.mode === 'tag') return this.stepTag(ch, sink)
    if (this.mode === 'tag_close') {
      const buf = this.tagBuf
      this.tagBuf = ''
      this.mode = 'text'
      // "[happy](https://...)" is a markdown link, not a tag: keep it as text.
      if (ch === '(') for (const c of buf) this.textChar(c, sink)
      else this.acceptTag(buf, sink)
    }
    this.stepText(ch, sink)
  }

  private stepText(ch: string, sink: Sink): void {
    if (ch === '`') {
      this.ticks++
      this.textChar(ch, sink)
      return
    }
    if (this.ticks > 0) this.resolveTicks()
    if (ch === '\n') this.inSpan = false
    if (ch === '[' && !this.inFence && !this.inSpan) {
      this.mode = 'tag'
      this.tagBuf = '['
      return
    }
    this.textChar(ch, sink)
  }

  private stepTag(ch: string, sink: Sink): void {
    this.tagBuf += ch
    if (ch === ']') {
      const name = this.tagBuf.slice(1, -1)
      if (this.classify(name) !== 'reject') {
        this.mode = 'tag_close' // one more character decides whether a "(" follows
        return
      }
      this.abandonTag(sink, false)
      return
    }
    if (isAsciiLetter(ch) && this.tagBuf.length <= MAX_TAG_LETTERS + 1) return
    // Not a tag after all. The last character may start something new (for example a second "["), so it is
    // reprocessed in normal mode after the buffered prefix has been released as literal text.
    this.abandonTag(sink, true)
  }

  /** Release the buffered candidate as literal text. `reprocessLast` re-feeds its final character. */
  private abandonTag(sink: Sink, reprocessLast: boolean): void {
    const buf = this.tagBuf
    this.tagBuf = ''
    this.mode = 'text'
    const literal = reprocessLast ? buf.slice(0, -1) : buf
    for (const c of literal) this.textChar(c, sink)
    if (reprocessLast) this.stepText(buf.slice(-1), sink)
  }

  private classify(name: string): 'known' | 'unknown' | 'reject' {
    if (KNOWN.has(name.toLowerCase())) return 'known'
    if (this.unknownTags === 'strip' && /^[a-z]{2,16}$/.test(name) && this.sentence.length === 0) return 'unknown'
    return 'reject'
  }

  private acceptTag(buf: string, sink: Sink): void {
    const name = buf.slice(1, -1).toLowerCase()
    const known = KNOWN.has(name)
    this.completeSentence(sink) // a tag always starts a new sentence; the old one keeps its own emotion
    this.pendingWs = ''
    this.emotion = known ? (name as Emotion) : 'neutral'
    this.dropWs = true
    sink.events.push({ type: 'emotion', emotion: this.emotion, known })
  }

  private resolveTicks(): void {
    if (this.ticks >= 3) this.inFence = !this.inFence
    else if (!this.inFence) this.inSpan = !this.inSpan
    this.ticks = 0
  }

  /** A character that is part of the visible text (or whitespace between visible text). */
  private textChar(ch: string, sink: Sink): void {
    if (isWhitespace(ch)) {
      if (this.sentence.length > 0 && (this.afterTerminator || ch === '\n')) this.completeSentence(sink)
      if (!this.dropWs) this.pendingWs += ch
      return
    }
    if (this.pendingWs) {
      sink.text(this.emotion, this.pendingWs)
      if (this.sentence.length > 0) this.sentence += this.pendingWs
      this.pendingWs = ''
    }
    this.dropWs = false
    sink.text(this.emotion, ch)
    this.sentence += ch
    this.noteTerminator(ch)
  }

  private noteTerminator(ch: string): void {
    if (TERMINATORS.has(ch)) {
      this.afterTerminator = !(ch === '.' && ABBREVIATION.test(this.sentence))
    } else if (!(CLOSERS.has(ch) && this.afterTerminator)) {
      this.afterTerminator = false
    }
  }

  private completeSentence(sink: Sink): void {
    const text = this.sentence.trim()
    if (text) sink.events.push({ type: 'sentence', emotion: this.emotion, text })
    this.sentence = ''
    this.afterTerminator = false
  }
}

// ---------------------------------------------------------------------- conveniences

export interface EmotionSegment {
  emotion: Emotion
  text: string
}

/** Parse a complete string into emotion segments (one per tag). Empty segments are dropped. */
export function parseEmotionText(input: string, opts?: EmotionParserOptions): EmotionSegment[] {
  const parser = new EmotionStreamParser(opts)
  const segments: EmotionSegment[] = []
  let current: EmotionSegment | undefined
  for (const ev of [...parser.push(input), ...parser.flush()]) {
    if (ev.type === 'emotion') current = undefined
    else if (ev.type === 'text') {
      if (!current) {
        current = { emotion: ev.emotion, text: '' }
        segments.push(current)
      }
      current.text += ev.text
    }
  }
  return segments
}

/** The sentences of a complete string, tags removed, each with its emotion. */
export function parseSentences(input: string, opts?: EmotionParserOptions): EmotionSegment[] {
  const parser = new EmotionStreamParser(opts)
  const out: EmotionSegment[] = []
  for (const ev of [...parser.push(input), ...parser.flush()]) if (ev.type === 'sentence') out.push({ emotion: ev.emotion, text: ev.text })
  return out
}

const KNOWN_TAG_RE = new RegExp(`\\[(?:${EMOTION_TAGS.join('|')})\\](?!\\()[ \\t]*`, 'gi')
const CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g

/**
 * Remove known emotion tags from stored text (notes, journal appends) without touching anything else:
 * whitespace and line breaks are kept, code spans and fences are left alone.
 */
export function stripEmotionTags(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(CODE_RE)) {
    const at = m.index ?? 0
    out += text.slice(last, at).replace(KNOWN_TAG_RE, '')
    out += m[0]
    last = at + m[0].length
  }
  return out + text.slice(last).replace(KNOWN_TAG_RE, '')
}
