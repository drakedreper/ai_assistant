import type { ChatMessage } from '@ai-assistant/shared'
import { ArrowDown } from 'lucide-react'
import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { fmtDay, fmtTime } from '../lib/format'
import { MessageBubble } from './MessageBubble'
import { MiraDisc } from './MiraDisc'

const GAP_MS = 40 * 60_000

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "Yesterday · 18:12" / "Today · 07:31" divider text, relative to the store clock. */
function dividerLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  const day = sameDay(d, now) ? 'Today' : sameDay(d, y) ? 'Yesterday' : fmtDay(iso)
  return `${day} · ${fmtTime(iso)}`
}

function TypingBubble() {
  return (
    <div className="mt-3 flex gap-2" role="status" aria-label="Mira is thinking">
      <MiraDisc size={24} className="mt-0.5" />
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-line bg-white/[0.045] px-3.5 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-bounce rounded-full bg-muted motion-reduce:animate-none"
            style={{ animationDelay: `${i * 140}ms`, animationDuration: '1s' }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The scrolling thread. Sticks to the newest message unless the user scrolled up, in which case a
 * "Latest" pill appears instead of yanking them back down.
 */
export function MessageList({
  messages,
  now,
  streaming,
  thinking,
  showTags,
  compact,
  limit,
  maxHeight,
  className,
}: {
  messages: ChatMessage[]
  now: Date
  streaming: boolean
  thinking: boolean
  showTags: boolean
  compact?: boolean
  limit?: number
  /** For containers without a definite height (the overlay): cap the list instead of filling the parent. */
  maxHeight?: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lock = useRef(0)
  const lastCount = useRef(0)
  const [away, setAway] = useState(false)

  const shown = limit ? messages.slice(-limit) : messages
  const last = shown[shown.length - 1]
  const typing = thinking && (!last || last.role !== 'assistant')
  const streamingId = streaming && last?.role === 'assistant' ? last.id : null

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el || performance.now() < lock.current) return
    const d = el.scrollHeight - el.scrollTop - el.clientHeight
    stick.current = d < 56
    setAway((was) => (was === d >= 56 ? was : d >= 56))
  }, [])

  const toBottom = useCallback((smooth: boolean) => {
    const el = ref.current
    if (!el) return
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    lock.current = performance.now() + (smooth ? 520 : 80)
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !calm ? 'smooth' : 'auto' })
  }, [])

  useLayoutEffect(() => {
    const grew = shown.length !== lastCount.current
    const first = lastCount.current === 0
    lastCount.current = shown.length
    // Sending a message always jumps to the newest, even if you had scrolled up to read.
    if (grew && last?.role === 'user') stick.current = true
    if (stick.current) toBottom(grew && !first)
    else if (grew) setAway(true)
    else if (stick.current) setAway(false)
  })

  return (
    <div className={cn('relative min-h-0', maxHeight ? '' : 'flex-1', className)}>
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation with Mira"
        aria-relevant="additions text"
        tabIndex={0}
        className={cn('overflow-y-auto px-3 py-3', maxHeight ? '' : 'absolute inset-0')}
        style={{
          ...(maxHeight ? { maxHeight } : {}),
          // soft fade where messages scroll under the header / composer
          maskImage: 'linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 8px), transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 12px, #000 calc(100% - 8px), transparent 100%)',
        }}
      >
        {shown.map((m, i) => {
          const prev = shown[i - 1]
          const gap = !prev || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > GAP_MS
          const first = gap || !prev || prev.role !== m.role
          return (
            <Fragment key={m.id}>
              {gap && !compact && (
                <div className={cn('flex items-center gap-2 text-[11px] text-faint', i === 0 ? 'mb-1' : 'mt-4 mb-1')}>
                  <span className="h-px flex-1 bg-line" />
                  <span>{dividerLabel(m.createdAt, now)}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              <MessageBubble message={m} streaming={m.id === streamingId} showTags={showTags} first={first} compact={compact} />
            </Fragment>
          )
        })}
        {typing && <TypingBubble />}
      </div>
      {away && (
        <button
          type="button"
          onClick={() => {
            stick.current = true
            setAway(false)
            toBottom(true)
          }}
          className="absolute right-3 bottom-2 flex cursor-pointer items-center gap-1 rounded-full border border-line-strong bg-raised/90 px-2.5 py-1 text-[11px] text-fg shadow-lg backdrop-blur transition hover:bg-raised"
        >
          <ArrowDown className="size-3" aria-hidden /> Latest
        </button>
      )}
    </div>
  )
}
