import { Brain, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { StageMemoryItem, StageMemoryList } from '@ai-assistant/shared'
import { api } from '../../../api'
import { Badge, Button, Panel } from '../../../components/ui'
import { timeAgo } from '../../../lib/format'
import { useStageFeed } from '../../../stage/feed'
import { describeStageError, stageClient } from '../../../stage/stageClient'
import { useStore } from '../../../state/store'
import { StageNotice } from './StageShared'

const KIND_LABEL: Record<StageMemoryItem['kind'], string> = { episode: 'Moment', relationship: 'Between us', preference: 'Preference' }
const SENSITIVITY_TONE = { normal: 'neutral', private: 'warn', sensitive: 'bad' } as const
const SENSITIVITY_HINT: Record<StageMemoryItem['sensitivity'], string> = {
  normal: 'May be summarised into her prompt when a conversation with Claude is opened (the most important and recent ones, within a short budget).',
  private: 'Never added to her prompt. Blurred in Guest mode.',
  sensitive: 'Never added to her prompt. Blurred in Guest mode.',
}
/** A long list is cut to this many rows until you ask for all of it. */
const FIRST_ROWS = 100

/** What is waiting for its second click: one item, or the whole list (remembering how long the list was when it was armed). */
type Armed = { target: string; total: number } | null

/**
 * What she wrote down with her memory tool: every item, with its kind and privacy label, and a way to make her forget one
 * item or all of it. It works whether or not the stage is switched on, because "her data stays while the stage is off" is
 * only true if you can always see and delete it. The text is yours, on your PC, so all of it is shown; anything that is not
 * `normal` is blurred in Guest mode like the rest of the app's sensitive content.
 */
export function MemoryPanel() {
  const now = useStore((s) => s.now)
  const [list, setList] = useState<StageMemoryList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState<Armed>(null)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async () => {
    try {
      setList(await stageClient.listMemory())
      setError(null)
    } catch (err) {
      setError(describeStageError(err))
    }
  }, [])

  // Where fresh data comes from. The stage revision changes on a restart and on a wardrobe, scene or connection change (it
  // does NOT change when she writes a memory: that is not part of the stage snapshot, on purpose). She writes memory with a
  // tool call in the middle of a reply, so the list is fetched again whenever a reply has finished. Refresh covers the rest.
  const rev = useStageFeed((s) => s.live?.rev)
  useEffect(() => {
    void load()
  }, [load, rev])
  useEffect(
    () =>
      api.subscribe((e) => {
        if (e.type === 'chat.done') void load()
      }),
    [load],
  )

  // A second click must always be about what you were looking at: if the list changed underneath (another tab forgot
  // something, a reply wrote something), the armed button goes back to its first state.
  useEffect(() => {
    setArmed((a) => {
      if (!a || !list) return a
      if (a.target === 'all') return list.total === a.total ? a : null
      return list.items.some((m) => m.id === a.target) ? a : null
    })
  }, [list])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    let failure: string | null = null
    try {
      await fn()
    } catch (err) {
      failure = describeStageError(err)
    } finally {
      setArmed(null)
      await load() // shows what is really stored now ...
      if (failure) setError(failure) // ... without erasing why the change did not happen
      setBusy(false)
    }
  }

  const items = list?.items ?? []
  const rows = showAll ? items : items.slice(0, FIRST_ROWS)
  const arm = (target: string) => setArmed({ target, total: list?.total ?? 0 })
  return (
    <Panel
      title="What she remembers"
      subtitle="Things she wrote down with her memory tool. Inspect any of it, or have her forget it"
      icon={Brain}
      area="brain"
      actions={
        <Button variant="ghost" size="xs" disabled={busy} onClick={() => void load()} aria-label="Refresh what she remembers">
          <RefreshCw className="size-3" aria-hidden /> Refresh
        </Button>
      }
    >
      {!list ? (
        <p className="text-[12.5px] text-muted" role="status">
          {error ? 'Could not load it.' : 'Loading...'}
        </p>
      ) : list.total === 0 ? (
        <p className="text-[12.5px] leading-snug text-muted" data-testid="stage-memory-empty">
          She has not written anything down yet. When she remembers something about you it appears here, and you can make her forget it.
        </p>
      ) : (
        <>
          <p className="text-[12px] text-faint" data-testid="stage-memory-count">
            {list.total} remembered{list.total - list.unlisted > items.length ? ` (the newest ${items.length} are listed)` : ''}: {list.bySensitivity.normal} normal, {list.bySensitivity.private} private, {list.bySensitivity.sensitive} sensitive.
          </p>
          {list.unlisted > 0 && (
            <p className="mt-1 text-[12px] leading-snug text-warn" data-testid="stage-memory-unlisted">
              {list.unlisted} stored item{list.unlisted === 1 ? ' cannot' : 's cannot'} be shown here ({list.unlisted === 1 ? 'its' : 'their'} identifier is unusable). &quot;Forget everything on this list&quot; removes {list.unlisted === 1 ? 'it' : 'them'} too.
            </p>
          )}
          <ul className="mt-2 flex flex-col gap-1.5" data-testid="stage-memory">
            {rows.map((m) => (
              <li key={m.id} className="rounded-lg border border-line bg-black/15 px-2.5 py-2" data-memory={m.id} data-sensitivity={m.sensitivity}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="brain">{KIND_LABEL[m.kind]}</Badge>
                  <Badge tone={SENSITIVITY_TONE[m.sensitivity]} title={SENSITIVITY_HINT[m.sensitivity]}>
                    {m.sensitivity}
                  </Badge>
                  <span className="text-[11px] text-faint tabular-nums">
                    {timeAgo(m.createdAt, now)} · importance {m.importance}/5
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {armed?.target === m.id ? (
                      <>
                        <Button variant="danger" size="xs" disabled={busy} data-action="forget-confirm" onClick={() => void run(() => stageClient.forgetMemory(m.id))}>
                          <Trash2 className="size-3" aria-hidden /> Forget it
                        </Button>
                        <Button variant="ghost" size="xs" disabled={busy} onClick={() => setArmed(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="xs" disabled={busy} data-action="forget" aria-label={`Forget this ${KIND_LABEL[m.kind].toLowerCase()}`} onClick={() => arm(m.id)}>
                        <Trash2 className="size-3" aria-hidden /> Forget
                      </Button>
                    )}
                  </span>
                </div>
                <p className="mt-1 text-[13px] leading-snug break-words text-fg" data-sensitive={m.sensitivity !== 'normal' ? true : undefined}>
                  {m.text}
                </p>
              </li>
            ))}
          </ul>
          {items.length > rows.length && (
            <Button variant="ghost" size="xs" className="mt-2" data-action="show-all" onClick={() => setShowAll(true)}>
              Show all {items.length}
            </Button>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {armed?.target === 'all' ? (
              <>
                <span className="text-[12.5px] text-fg">This makes her forget all {list.total} items on this list.</span>
                <Button variant="danger" size="xs" disabled={busy} data-action="forget-all-confirm" onClick={() => void run(() => stageClient.forgetAllMemory())}>
                  <Trash2 className="size-3" aria-hidden /> Forget everything on this list
                </Button>
                <Button variant="ghost" size="xs" disabled={busy} onClick={() => setArmed(null)}>
                  Keep them
                </Button>
              </>
            ) : (
              <Button variant="outline" size="xs" disabled={busy} data-action="forget-all" onClick={() => arm('all')}>
                <Trash2 className="size-3" aria-hidden /> Forget everything on this list
              </Button>
            )}
          </div>
        </>
      )}
      <p className="mt-3 text-[11.5px] leading-snug text-faint">
        She writes these herself, with her memory tool, while you talk, and each one asks you first. When a conversation with Claude is opened, her prompt gets a short summary of the items marked normal; private and sensitive ones are never added to that summary.
      </p>
      <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
        Forgetting removes an item from storage and from that summary. It does not remove the conversation in which she wrote it: Claude keeps that conversation, including what she passed to the memory tool, and it is resumed every day, so she can still read it and write the item down again. Claude Code also keeps its own transcript on this PC (see Privacy). This list is only her memory: what she has learned about you (Settings, Memory) and your chat history are separate. It works even while the stage is switched off.
      </p>
      <StageNotice error={error} />
    </Panel>
  )
}
