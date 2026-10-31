import type { Note, Proposal } from '@ai-assistant/shared'
import { ArrowLeft, ArrowRight, Check, ChevronDown, Code2, GitPullRequest, Link2, Lock, Save, ShieldCheck, Tag } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Badge, Button, IconButton, Segmented } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { timeAgo } from '../../../lib/format'
import { LAYERS, fmtTokens, isProtected, layerKeyOf } from '../lib/layers'
import { Markdown, type MdCtx } from '../lib/markdown'
import { scrollWithin } from '../lib/scroll'
import { applyDiff, stripLeadingH1, toSource, type VaultIndex } from '../lib/vault'
import { useBrain } from '../ui'
import { ConfidenceBadge, ImportanceDots, LayerBadge, LayerDot, ProvenanceBadge, SensitivityBadge, StatusBadge } from './atoms'

/** Approved proposals that were decided in this session are applied to the displayed text (the daemon would commit them). */
function useEffectiveBody(note: Note, proposals: Proposal[]) {
  return useMemo(() => {
    const live = proposals
      .filter((p) => p.targetPath === note.path && p.status === 'approved' && !p.commit)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    let body = note.body
    const applied: Proposal[] = []
    for (const p of live) {
      const next = applyDiff(body, p.diff)
      if (next !== null && next !== body) {
        body = next
        applied.push(p)
      }
    }
    return { body, applied }
  }, [note, proposals])
}

function Prop({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'col-span-2')}>
      <dt className="text-[11px] tracking-wide text-faint uppercase">{label}</dt>
      <dd className="mt-0.5 flex min-h-5 flex-wrap items-center gap-1 text-[13px] text-fg">{children}</dd>
    </div>
  )
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

function PropertiesPanel({ note, now, justUpdated }: { note: Note; now: Date; justUpdated?: boolean }) {
  const open = useBrain((s) => s.propsOpen)
  const setOpen = useBrain((s) => s.setPropsOpen)
  const lk = layerKeyOf(note)
  const review = note.reviewAfter
  const days = review ? Math.round((new Date(`${review}T00:00:00`).getTime() - now.getTime()) / 86_400_000) : null
  return (
    <section aria-label="Properties" className="rounded-xl border border-line bg-white/[0.025]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left"
      >
        <ChevronDown className={cn('size-3.5 text-faint transition-transform', !open && '-rotate-90')} aria-hidden />
        <span className="text-[12px] font-semibold tracking-wide text-muted">Properties</span>
        {open ? (
          <span className="text-[11px] text-faint">frontmatter, flat and Obsidian-safe</span>
        ) : (
          <span className="ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <StatusBadge value={note.status} />
            <ImportanceDots value={note.importance} />
            <ProvenanceBadge value={note.provenance} />
            <ConfidenceBadge value={note.confidence} />
          </span>
        )}
      </button>
      {open && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-3.5 pb-3.5 @xl:grid-cols-3 @3xl:grid-cols-4">
          <Prop label="Type">
            <Badge>{note.type}</Badge>
          </Prop>
          <Prop label="Layer">
            <LayerBadge layer={lk} label={lk === 'federated' ? 'Secondbrain' : LAYERS[lk].folder} />
          </Prop>
          <Prop label="Status">
            <StatusBadge value={note.status} />
          </Prop>
          <Prop label="Importance">
            <ImportanceDots value={note.importance} />
            <span className="text-[11px] text-faint tabular-nums">{note.importance}/5</span>
          </Prop>
          <Prop label="Confidence">
            <ConfidenceBadge value={note.confidence} />
          </Prop>
          <Prop label="Provenance">
            <ProvenanceBadge value={note.provenance} />
          </Prop>
          <Prop label="Sensitivity">
            <SensitivityBadge value={note.sensitivity} />
          </Prop>
          {note.contextTokens && (
            <Prop label="In context">
              <span className="text-[12px] text-muted tabular-nums">~{fmtTokens(note.contextTokens)} tokens</span>
            </Prop>
          )}
          <Prop label="Created">
            <span className="text-[12px] text-muted tabular-nums" title={note.created}>
              {fmtDate(note.created)}
            </span>
          </Prop>
          <Prop label="Updated">
            <span className="text-[12px] text-muted tabular-nums" title={note.updated}>
              {justUpdated ? 'just now' : timeAgo(note.updated, now)}
            </span>
          </Prop>
          {review && (
            <Prop label="Review after">
              <span className="text-[12px] text-muted tabular-nums">{fmtDate(`${review}T12:00:00`)}</span>
              {days !== null && (
                <Badge tone={days < 0 ? 'warn' : 'neutral'}>{days < 0 ? 'overdue' : days === 0 ? 'today' : `in ${days} d`}</Badge>
              )}
            </Prop>
          )}
          <Prop label="Tags" wide>
            {note.tags.length === 0 ? (
              <span className="text-[12px] text-faint">none</span>
            ) : (
              note.tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-0.5 rounded-md bg-white/6 px-1.5 py-0.5 text-[11px] leading-4 text-muted">
                  <Tag className="size-2.5 text-faint" aria-hidden />
                  {t}
                </span>
              ))
            )}
          </Prop>
        </dl>
      )}
    </section>
  )
}

function Banner({ tone, icon, children, action, dashed }: { tone: 'brain' | 'mira' | 'money' | 'ok' | 'neutral'; icon: ReactNode; children: ReactNode; action?: ReactNode; dashed?: boolean }) {
  const cls = {
    brain: 'border-brain/35 bg-brain/8 text-brain',
    mira: 'border-mira/30 bg-mira/8 text-mira',
    money: 'border-money/30 bg-money/8 text-money',
    ok: 'border-ok/30 bg-ok/8 text-ok',
    neutral: 'border-line-strong bg-white/4 text-muted',
  }[tone]
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border px-3.5 py-2.5', dashed && 'border-dashed', cls)}>
      <span className="shrink-0">{icon}</span>
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-fg/90">{children}</p>
      {action}
    </div>
  )
}

/** Raw markdown, monospace and read-only, with line numbers. */
function SourceView({ text }: { text: string }) {
  const lines = text.split('\n')
  let fm = 0
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-black/30 py-2.5">
      <pre className="min-w-max font-mono text-[12px] leading-[1.7]" aria-label="Markdown source">
        {lines.map((line, i) => {
          const isFence = line === '---'
          if (isFence) fm++
          const inFm = fm === 1 || isFence
          let content: ReactNode = line || ' '
          if (inFm && !isFence) {
            const m = /^([\w-]+):(.*)$/.exec(line)
            if (m) content = (<><span className="text-brain">{m[1]}</span><span className="text-faint">:</span><span className="text-fg/85">{m[2]}</span></>)
          } else if (!inFm) {
            if (/^#{1,6}\s/.test(line)) content = <span className="font-semibold text-money">{line}</span>
            else if (/^\s*>/.test(line)) content = <span className="text-world/90">{wikify(line)}</span>
            else if (/^\s*```/.test(line)) content = <span className="text-faint">{line}</span>
            else content = <span className="text-fg/85">{wikify(line)}</span>
          } else if (isFence) content = <span className="text-faint">{line}</span>
          return (
            <div key={i} className="flex">
              <span aria-hidden className="w-10 shrink-0 pr-3 text-right text-faint/70 select-none tabular-nums">
                {i + 1}
              </span>
              <span className="pr-4 whitespace-pre">{content}</span>
            </div>
          )
        })}
      </pre>
    </div>
  )
}

function wikify(line: string): ReactNode {
  const parts = line.split(/(\[\[[^\]]+\]\])/g)
  return parts.map((p, i) => (p.startsWith('[[') ? <span key={i} className="text-brain">{p}</span> : <Fragment key={i}>{p}</Fragment>))
}

export function NoteReader({
  note,
  index,
  proposals,
  now,
  onOpenProposals,
  connections,
}: {
  note: Note
  index: VaultIndex
  proposals: Proposal[]
  now: Date
  onOpenProposals: (id: string) => void
  /** Rendered at the end of the note when the right-hand pane is hidden (narrow stages). */
  connections?: ReactNode
}) {
  const open = useBrain((s) => s.open)
  const back = useBrain((s) => s.back)
  const forward = useBrain((s) => s.forward)
  const canBack = useBrain((s) => s.cursor > 0)
  const canForward = useBrain((s) => s.cursor < s.history.length - 1)
  const source = useBrain((s) => s.source)
  const setSource = useBrain((s) => s.setSource)
  const heading = useBrain((s) => s.heading)
  const clearHeading = useBrain((s) => s.clearHeading)
  const scroller = useRef<HTMLDivElement>(null)

  const { body, applied } = useEffectiveBody(note, proposals)
  const lk = layerKeyOf(note)
  const federated = lk === 'federated'
  const pending = proposals.filter((p) => p.targetPath === note.path && p.status === 'pending')
  const superseder = note.supersededBy ? index.byPath.get(note.supersededBy) : undefined
  const sensitive = note.sensitivity !== 'normal'

  const ctx: MdCtx = useMemo(() => ({ resolve: index.resolve, open: (p, h) => open(p, h ? { heading: h } : {}) }), [index, open])
  const display = useMemo(() => stripLeadingH1(body), [body])

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [note.path])

  useEffect(() => {
    if (!heading || source) return
    const t = setTimeout(() => {
      const target = scroller.current?.querySelector(`[id="h-${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}"]`)
      if (target && scroller.current) scrollWithin(scroller.current, target, { smooth: true })
      clearHeading()
    }, 60)
    return () => clearTimeout(t)
  }, [heading, note.path, source, clearHeading])

  const crumbs = note.path.split('/')

  return (
    <section aria-label={`Note: ${note.title}`} className="glass @container flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2">
        <IconButton aria-label="Back" title="Back" disabled={!canBack} onClick={back} className="size-7">
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton aria-label="Forward" title="Forward" disabled={!canForward} onClick={forward} className="size-7">
          <ArrowRight className="size-4" />
        </IconButton>
        <div className="mx-1 flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[12px] text-faint" title={note.path}>
          <LayerDot layer={lk} />
          <span className="truncate">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="px-0.5 text-faint/60">/</span>}
                <span className={i === crumbs.length - 1 ? 'text-muted' : ''}>{c}</span>
              </Fragment>
            ))}
          </span>
        </div>
        <Segmented
          size="xs"
          ariaLabel="Note view"
          value={source ? 'source' : 'reader'}
          onChange={(v) => setSource(v === 'source')}
          options={[
            { value: 'reader', label: 'Reader' },
            { value: 'source', label: <span className="inline-flex items-center gap-1"><Code2 className="size-3" aria-hidden />Source</span> },
          ]}
        />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto flex max-w-[780px] flex-col gap-3 px-5 py-5 @3xl:px-7">
          <header>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <LayerBadge layer={lk} />
              {isProtected(note) && (
                <Badge tone={lk === 'core' ? 'mira' : 'money'}>
                  {lk === 'core' ? <Lock className="size-3" aria-hidden /> : <ShieldCheck className="size-3" aria-hidden />}
                  {lk === 'core' ? 'Core, always loaded' : 'Protected'}
                </Badge>
              )}
              {note.status === 'superseded' && <Badge>superseded</Badge>}
            </div>
            <h1 className={cn('text-[22px] leading-tight font-semibold tracking-tight text-fg', note.status === 'superseded' && 'text-muted')}>{note.title}</h1>
          </header>

          {federated && (
            <Banner tone="neutral" dashed icon={<Link2 className="size-4" aria-hidden />}>
              <strong className="font-semibold text-fg">From Secondbrain, read-only.</strong> Mira can read and cite this note, but never edit it. Change it in the Secondbrain app and it will sync here.
            </Banner>
          )}
          {isProtected(note) && !federated && note.status !== 'superseded' && (
            <Banner
              tone={pending.length ? 'mira' : lk === 'core' ? 'mira' : 'money'}
              icon={pending.length ? <GitPullRequest className="size-4" aria-hidden /> : lk === 'core' ? <Lock className="size-4" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
              action={
                pending.length > 0 ? (
                  <Button size="xs" variant="outline" onClick={() => onOpenProposals(pending[0]?.id ?? '')}>
                    Review {pending.length === 1 ? 'proposal' : `${pending.length} proposals`}
                  </Button>
                ) : undefined
              }
            >
              {pending.length > 0 ? (
                <>
                  <strong className="font-semibold text-fg">{pending.length === 1 ? 'Mira proposed a change to this note.' : `Mira proposed ${pending.length} changes to this note.`}</strong> Nothing is edited until you approve.
                </>
              ) : lk === 'core' ? (
                'Core note, loaded in every conversation. Mira can only propose edits, and you approve them.'
              ) : (
                'Protected note. Changes arrive as proposals you approve, each one a git commit.'
              )}
            </Banner>
          )}
          {note.status === 'superseded' && (
            <Banner tone="neutral" icon={<ArrowRight className="size-4" aria-hidden />} action={superseder ? <Button size="xs" variant="outline" onClick={() => open(superseder.path)}>Open the new note</Button> : undefined}>
              <strong className="font-semibold text-fg">Superseded.</strong> Kept for history. It no longer shapes what Mira suggests.
              {superseder && <> Replaced by <span className="text-fg">{superseder.title}</span>.</>}
            </Banner>
          )}
          {applied.length > 0 && (
            <Banner tone="ok" icon={<Check className="size-4" aria-hidden />}>
              <strong className="font-semibold text-fg">Updated just now.</strong> Applied from the approved proposal: {applied.map((p) => p.title).join('; ')}.
            </Banner>
          )}

          {!source && <PropertiesPanel note={note} now={now} justUpdated={applied.length > 0} />}

          <div data-sensitive={sensitive ? '' : undefined}>
            {source ? <SourceView text={toSource(note, body)} /> : <Markdown source={display} ctx={ctx} />}
          </div>
          {connections && <div className="mt-2 flex flex-col gap-3 border-t border-line pt-4 @5xl/brain:hidden">{connections}</div>}
        </article>
      </div>

      {source && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2">
          <p className="min-w-0 flex-1 text-[12px] text-faint">Read-only view of the file on disk. Mira is the only writer, and every write is a commit.</p>
          <Button size="sm" variant="outline" disabled title="The in-app editor arrives in Phase 2">
            <Save className="size-3.5" aria-hidden /> Save (arrives in Phase 2)
          </Button>
        </footer>
      )}
    </section>
  )
}
