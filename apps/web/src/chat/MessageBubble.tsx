import type { ChatMessage, ChatPart } from '@ai-assistant/shared'
import { Camera, Mic } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import { ApprovalCard } from '../components/ApprovalCard'
import { NoteChip } from '../components/NoteChip'
import { cn } from '../lib/cn'
import { MiraDisc } from './MiraDisc'
import { ToolChip } from './ToolChip'

const SNAPSHOT_PREFIX = '(shared a camera snapshot)'

type Block =
  | { kind: 'text'; part: Extract<ChatPart, { type: 'text' }>; index: number }
  | { kind: 'tools'; parts: Array<Extract<ChatPart, { type: 'tool' }>> }
  | { kind: 'notes'; parts: Array<Extract<ChatPart, { type: 'note' }>> }
  | { kind: 'approval'; id: string }

/** Consecutive tool chips (and note citations) share one wrapping row. */
function toBlocks(parts: ChatPart[]): Block[] {
  const out: Block[] = []
  parts.forEach((p, index) => {
    const last = out[out.length - 1]
    if (p.type === 'text') out.push({ kind: 'text', part: p, index })
    else if (p.type === 'approval') out.push({ kind: 'approval', id: p.approvalId })
    else if (p.type === 'tool') {
      if (last?.kind === 'tools') last.parts.push(p)
      else out.push({ kind: 'tools', parts: [p] })
    } else if (last?.kind === 'notes') last.parts.push(p)
    else out.push({ kind: 'notes', parts: [p] })
  })
  return out
}

export interface BubbleProps {
  message: ChatMessage
  /** This is the message currently being streamed (store.streaming and it is the newest one). */
  streaming: boolean
  showTags: boolean
  /** First message of a run from the same sender (shows the avatar, adds spacing). */
  first: boolean
  compact?: boolean
}

function BubbleImpl({ message, streaming, showTags, first, compact }: BubbleProps) {
  const isUser = message.role === 'user'
  const blocks = toBlocks(message.parts)
  // Finance numbers are sensitive: blur the whole message in Guest mode.
  const sensitive = message.parts.some((p) => p.type === 'tool' && p.tool.startsWith('finance_'))
  const lastBlock = blocks[blocks.length - 1]
  const textSize = compact ? 'text-[13px]' : 'text-[13.5px]'

  const rows: ReactNode[] = blocks.map((b, i) => {
    if (b.kind === 'text') {
      const isLast = lastBlock === b
      const caret = streaming && isLast
      let text = b.part.text
      let snapshot = false
      if (isUser && text.startsWith(SNAPSHOT_PREFIX)) {
        snapshot = true
        text = text.slice(SNAPSHOT_PREFIX.length).trim()
      }
      if (!text && !caret && !snapshot) return null
      return (
        <div key={i} className="space-y-1.5">
          {snapshot && (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-black/25 px-2 py-1.5 text-[11px] text-muted">
              <span className="grid size-8 place-items-center rounded-md bg-gradient-to-br from-mira/25 to-brain/25 text-mira">
                <Camera className="size-4" aria-hidden />
              </span>
              <span>
                Camera snapshot
                <span className="block text-faint">shared once, not stored</span>
              </span>
            </div>
          )}
          {(text || caret) && (
            <p className={cn('leading-snug break-words whitespace-pre-wrap', textSize, caret && 'caret')} data-sensitive={sensitive ? '' : undefined}>
              {showTags && b.part.emotion && (
                <span className="mr-1 rounded bg-brain/12 px-1 py-px font-mono text-[10px] text-brain" title="Emotion tag, stripped before voice and display">
                  [{b.part.emotion}]
                </span>
              )}
              {text}
            </p>
          )}
        </div>
      )
    }
    if (b.kind === 'tools') {
      return (
        <div key={i} className="flex flex-wrap gap-1">
          {b.parts.map((t, j) => (
            // A tool that was running when the reply was interrupted would spin forever; only the live message spins.
            <ToolChip key={j} tool={t.tool} summary={t.summary} status={t.status === 'running' && !streaming ? 'done' : t.status} />
          ))}
        </div>
      )
    }
    if (b.kind === 'notes') {
      return (
        <div key={i} className="flex flex-wrap gap-1">
          {b.parts.map((n, j) => (
            <NoteChip key={j} path={n.note.path} title={n.note.title} />
          ))}
        </div>
      )
    }
    return <ApprovalCard key={i} id={b.id} variant="compact" className="mt-0.5" />
  })

  return (
    <div className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start', first ? 'mt-3 first:mt-0' : 'mt-1')}>
      {!isUser && (first ? <MiraDisc size={compact ? 22 : 24} className="mt-0.5" /> : <span className={compact ? 'w-[22px] shrink-0' : 'w-6 shrink-0'} />)}
      <div
        className={cn(
          'min-w-0 space-y-1.5 border px-3 py-2',
          isUser
            ? 'max-w-[84%] rounded-2xl border-mira/25 bg-mira/[0.13] text-fg ' + (first ? 'rounded-br-md' : '')
            : 'max-w-[90%] rounded-2xl border-line bg-white/[0.045] text-fg/95 ' + (first ? 'rounded-bl-md' : ''),
        )}
      >
        {message.modality === 'voice' && (
          <span className="flex items-center gap-1 text-[10px] tracking-wide text-mira/90 uppercase">
            <Mic className="size-3" aria-hidden /> voice
          </span>
        )}
        {rows}
      </div>
    </div>
  )
}

export const MessageBubble = memo(BubbleImpl)
