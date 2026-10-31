import type { ChatMessage } from '@ai-assistant/shared'
import { Tag } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { useStore } from '../state/store'
import { Composer, MiniInput, SuggestionChips } from './Composer'
import { MessageList } from './MessageList'
import { MiraDisc } from './MiraDisc'

const EMPTY: ChatMessage[] = []
/** Starter prompts stay visible while the thread is still short. */
const SHORT_THREAD = 12

/** Everything the chat variants read from the store, as stable primitives / slices. */
function useChatState() {
  const messages = useStore((s) => s.data?.chat ?? EMPTY)
  const now = useStore((s) => s.now)
  const streaming = useStore((s) => s.streaming)
  const thinking = useStore((s) => s.assistantState === 'thinking')
  const asleep = useStore((s) => s.asleep)
  const micOn = useStore((s) => s.micOn)
  return { messages, now, streaming, thinking, asleep, micOn }
}

function Header({ showTags, onToggleTags, asleep }: { showTags: boolean; onToggleTags: () => void; asleep: boolean }) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      <MiraDisc size={22} />
      <h2 className="text-[13px] font-semibold text-fg">Mira</h2>
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
        <span className={cn('size-1.5 rounded-full', asleep ? 'bg-brain' : 'bg-ok pulse-dot')} />
        {asleep ? 'asleep, wakes when you write' : 'online'}
      </span>
      <button
        type="button"
        onClick={onToggleTags}
        aria-pressed={showTags}
        title="Show the [emotion] tags she emits. They steer her face and voice and are never shown to you normally."
        className={cn(
          'ml-auto flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5 text-[11px] transition',
          showTags ? 'border-brain/40 bg-brain/12 text-brain' : 'border-line text-faint hover:text-muted',
        )}
      >
        <Tag className="size-3" aria-hidden />
        <span>Emotion tags</span>
      </button>
    </header>
  )
}

/** Main chat in her column. */
function Dock() {
  const { messages, now, streaming, thinking, asleep, micOn } = useChatState()
  const [showTags, setShowTags] = useState(false)
  const box = useRef<HTMLElement>(null)
  const [height, setHeight] = useState(500)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setHeight(Math.round(e.contentRect.height)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Starter prompts only while the thread is short and there is room for them.
  const showChips = messages.length <= SHORT_THREAD && !streaming && !micOn && height >= 300
  return (
    <section ref={box} aria-label="Chat with Mira" className="glass flex min-h-[280px] min-w-0 flex-1 flex-col overflow-hidden">
      <Header showTags={showTags} onToggleTags={() => setShowTags((v) => !v)} asleep={asleep} />
      <MessageList messages={messages} now={now} streaming={streaming} thinking={thinking} showTags={showTags} />
      <div className="shrink-0 space-y-2 px-3 pt-1 pb-3">
        {showChips && <SuggestionChips />}
        <Composer />
      </div>
    </section>
  )
}

/** Immersive (Full room): translucent, compact, shows the last few messages. */
function Overlay() {
  const { messages, now, streaming, thinking, micOn } = useChatState()
  const showChips = messages.length <= SHORT_THREAD && !streaming && !micOn
  return (
    <section aria-label="Chat with Mira" className="glass flex max-h-[40vh] min-h-0 flex-col overflow-hidden bg-surface/60 backdrop-blur-xl">
      <MessageList messages={messages} now={now} streaming={streaming} thinking={thinking} showTags={false} compact limit={4} maxHeight="calc(40vh - 112px)" />
      <div className="shrink-0 space-y-1.5 px-2.5 pt-0.5 pb-2.5">
        {showChips && <SuggestionChips />}
        <Composer compact />
      </div>
    </section>
  )
}

/** Mini mode: her latest line (two lines max) above a one-line input. */
function Mini() {
  const { messages, streaming, thinking } = useChatState()
  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m && m.role === 'assistant') return m
    }
    return undefined
  }, [messages])
  const text = latest?.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim()
  const lastIsUser = messages[messages.length - 1]?.role === 'user'
  const tool = latest?.parts.find((p) => p.type === 'tool')
  const line = thinking && lastIsUser ? 'Thinking…' : text || (tool && tool.type === 'tool' ? `${tool.summary}…` : 'Say something to Mira')
  return (
    <section aria-label="Chat with Mira" className="glass flex flex-col gap-2 p-2.5">
      <div className="flex items-start gap-2">
        <MiraDisc size={20} className="mt-0.5" />
        <p
          className={cn('line-clamp-2 min-h-[2.6em] text-[12.5px] leading-snug text-fg/90', streaming && !lastIsUser && 'caret')}
          aria-live="polite"
        >
          {line}
        </p>
      </div>
      <MiniInput />
    </section>
  )
}

export function ChatPanel({ variant }: { variant: 'dock' | 'overlay' | 'mini' }) {
  if (variant === 'overlay') return <Overlay />
  if (variant === 'mini') return <Mini />
  return <Dock />
}
