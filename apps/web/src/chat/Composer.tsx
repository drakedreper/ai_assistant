import { ArrowUp, Mic, Square } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '../lib/cn'
import { useStore } from '../state/store'
import { LevelBars } from './LevelBars'
import { sendMessage, stopReply } from './send'
import { toggleVoice } from './voice'

export const SUGGESTIONS = ['What needs me?', 'What is on today?', 'What do you think of my Q4 plan?']

/** Push-to-talk toggle shared by every chat variant. */
export function MicButton({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' }) {
  const micOn = useStore((s) => s.micOn)
  return (
    <button
      type="button"
      onClick={toggleVoice}
      aria-pressed={micOn}
      aria-label={micOn ? 'Stop listening' : 'Talk to Mira (voice demo)'}
      title={micOn ? 'Listening. Press again to cancel.' : 'Push to talk (demo: sends a canned question)'}
      className={cn(
        'grid shrink-0 cursor-pointer place-items-center rounded-lg transition',
        size === 'md' ? 'size-8' : 'size-7',
        micOn ? 'bg-mira/20 text-mira ring-1 ring-mira/50' : 'text-muted hover:bg-white/8 hover:text-fg',
        className,
      )}
    >
      <Mic className="size-4" />
    </button>
  )
}

/** Send, or Stop while a reply streams. */
export function ActionButton({ canSend, onSend, size = 'md' }: { canSend: boolean; onSend: () => void; size?: 'sm' | 'md' }) {
  const streaming = useStore((s) => s.streaming)
  const dim = size === 'md' ? 'size-8' : 'size-7'
  if (streaming && !canSend) {
    return (
      <button
        type="button"
        onClick={() => void stopReply()}
        aria-label="Stop reply"
        title="Stop her reply"
        className={cn('grid shrink-0 cursor-pointer place-items-center rounded-lg border border-line-strong bg-white/10 text-fg transition hover:bg-white/16', dim)}
      >
        <Square className="size-3 fill-current" />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onSend}
      disabled={!canSend}
      aria-label="Send message"
      className={cn('grid shrink-0 cursor-pointer place-items-center rounded-lg bg-mira text-canvas transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40', dim)}
    >
      <ArrowUp className="size-4" strokeWidth={2.5} />
    </button>
  )
}

/** The listening strip that replaces the text field while the mic demo is on. */
export function ListeningStrip({ compact }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5" role="status" aria-live="polite">
      <LevelBars active bars={compact ? 14 : 26} height={22} className="min-w-0 flex-1 justify-center gap-[3px]" />
      <span className="shrink-0 text-xs font-medium text-mira">Listening…</span>
    </div>
  )
}

/** Auto-growing text field + mic + send/stop. Enter sends, Shift+Enter inserts a newline. */
export function Composer({ compact, className }: { compact?: boolean; className?: string }) {
  const micOn = useStore((s) => s.micOn)
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`
  }, [text, micOn])

  const submit = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    void sendMessage(t)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className={cn('flex items-end gap-1 rounded-xl border border-line-strong bg-black/25 p-1 transition focus-within:border-mira/50 focus-within:ring-1 focus-within:ring-mira/30', className)}>
      <MicButton />
      {micOn ? (
        <ListeningStrip compact={compact} />
      ) : (
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message Mira…"
          aria-label="Message Mira"
          style={{ outline: 'none' }}
          className="max-h-28 min-h-8 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[13px] leading-5 text-fg placeholder:text-faint"
        />
      )}
      <ActionButton canSend={text.trim().length > 0} onSend={submit} />
    </div>
  )
}

/** One-line input for the Mini dock. */
export function MiniInput() {
  const micOn = useStore((s) => s.micOn)
  const [text, setText] = useState('')
  const submit = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    void sendMessage(t)
  }
  return (
    <form
      className="flex items-center gap-1 rounded-xl border border-line-strong bg-black/25 p-0.5 focus-within:border-mira/50"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <MicButton size="sm" />
      {micOn ? (
        <ListeningStrip compact />
      ) : (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message Mira…"
          aria-label="Message Mira"
          style={{ outline: 'none' }}
          className="h-7 min-w-0 flex-1 bg-transparent px-1.5 text-[13px] text-fg placeholder:text-faint"
        />
      )}
      <ActionButton canSend={text.trim().length > 0} onSend={submit} size="sm" />
    </form>
  )
}

/** The three starter prompts, shown while the thread is short. */
export function SuggestionChips({ className }: { className?: string }) {
  return (
    <div className={cn('-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', className)} aria-label="Suggestions">
      {SUGGESTIONS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => void sendMessage(s)}
          className="shrink-0 cursor-pointer rounded-full border border-line bg-white/[0.04] px-2.5 py-1 text-[11.5px] whitespace-nowrap text-muted transition hover:border-mira/40 hover:bg-mira/10 hover:text-fg"
        >
          {s}
        </button>
      ))}
    </div>
  )
}
