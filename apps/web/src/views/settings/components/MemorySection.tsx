import { Brain, Download, FolderOpen, GitBranch, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../../../api'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Button, EmptyState, Panel } from '../../../components/ui'
import { timeAgo } from '../../../lib/format'
import { useSnap, useStore } from '../../../state/store'
import { Tip } from '../../money/components/Tip'
import { Callout, INPUT_CLS, SectionHeader } from './Atoms'

const CONF = { high: 'ok', medium: 'warn', low: 'neutral' } as const

function LearnedList() {
  const learned = useSnap((d) => d.learned)
  const now = useStore((s) => s.now)
  const [confirm, setConfirm] = useState<string | null>(null)
  return (
    <Panel title="What she has learned about you" subtitle="Inspect it. Forget anything that is wrong or too personal" icon={Brain} area="brain" flush>
      {learned.length === 0 ? (
        <EmptyState title="Nothing learned that you have not already seen" hint="When she notices a pattern she writes it here, with the note it came from." />
      ) : (
        <ul className="divide-y divide-line">
          {learned.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-[240px] flex-1">
                <p className="text-[13.5px] leading-snug text-fg" data-sensitive>
                  {f.text}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <Badge tone={CONF[f.confidence]}>{f.confidence} confidence</Badge>
                  <span className="text-[11px] text-faint">from</span>
                  <NoteChip path={f.source.path} title={f.source.title} />
                  <span className="text-[11px] text-faint">{timeAgo(f.learnedAt, now)}</span>
                </div>
              </div>
              {confirm === f.id ? (
                <div className="flex items-center gap-2">
                  <Button variant="danger" onClick={() => { void api.forgetFact(f.id); setConfirm(null) }}>
                    <Trash2 className="size-3.5" aria-hidden /> Forget it
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirm(null)}>
                    Keep
                  </Button>
                </div>
              ) : (
                <Button variant="outline" onClick={() => setConfirm(f.id)} aria-label={`Forget: ${f.text}`}>
                  <Trash2 className="size-3.5" aria-hidden /> Forget
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function VaultCard() {
  const vault = useSnap((d) => d.settings.vault)
  const notes = useSnap((d) => d.notes)
  const now = useStore((s) => s.now)
  return (
    <Panel title="Your vault" subtitle="A folder of markdown files in a git repository" icon={FolderOpen} area="brain">
      <div className="rounded-lg border border-line bg-black/25 px-3 py-2 font-mono text-[12.5px] text-fg" data-sensitive>
        {vault?.path ?? 'C:\\Users\\you\\Vault'}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-[11px] tracking-wide text-faint uppercase">Notes</dt>
          <dd className="text-[16px] font-semibold text-fg tabular-nums">{notes.length}</dd>
        </div>
        <div>
          <dt className="text-[11px] tracking-wide text-faint uppercase">Commits</dt>
          <dd className="text-[16px] font-semibold text-fg tabular-nums">{vault?.commits ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-[11px] tracking-wide text-faint uppercase">Last change</dt>
          <dd className="text-[16px] font-semibold text-fg">{vault ? timeAgo(vault.lastCommitAt, now) : '-'}</dd>
        </div>
      </dl>
      <p className="mt-3 flex items-start gap-2 text-[12px] leading-snug text-muted">
        <GitBranch className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
        <span>
          Every change she makes is a git commit with a readable message, so the history is the undo button. Search indexes are derived and can always be rebuilt.
        </span>
      </p>
      <div className="mt-3">
        <Tip focusable side="top" align="start" text="Exports the whole vault as a zip, with history. Not available in the mockup; today you can copy the folder yourself.">
          <Button variant="outline" disabled aria-label="Export vault (not available yet)">
            <Download className="size-3.5" aria-hidden /> Export vault
          </Button>
        </Tip>
      </div>
    </Panel>
  )
}

function ForgetEverything() {
  const notes = useSnap((d) => d.notes)
  const learned = useSnap((d) => d.learned)
  const [term, setTerm] = useState('')
  const q = term.trim().toLowerCase()
  const hits = useMemo(() => {
    if (q.length < 2) return null
    return {
      notes: notes.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)),
      facts: learned.filter((f) => f.text.toLowerCase().includes(q)),
    }
  }, [q, notes, learned])

  return (
    <Panel title="Forget everything about..." subtitle="A person, a project or a topic, removed everywhere" icon={Trash2} area="brain">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
        <input
          className={`${INPUT_CLS} pl-9`}
          placeholder="e.g. Priya, or a project name"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label="Topic to forget"
        />
      </div>

      {hits ? (
        <div className="mt-3 rounded-xl border border-line bg-white/[0.025] p-3" aria-live="polite">
          <p className="text-[13px] font-medium text-fg tabular-nums" data-sensitive>
            Dry run: {hits.notes.length} note{hits.notes.length === 1 ? '' : 's'} and {hits.facts.length} learned fact{hits.facts.length === 1 ? '' : 's'} mention &quot;{term.trim()}&quot;.
          </p>
          {hits.notes.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5" data-sensitive>
              {hits.notes.slice(0, 6).map((n) => (
                <li key={n.path} className="min-w-0">
                  <NoteChip path={n.path} title={n.title} />
                </li>
              ))}
              {hits.notes.length > 6 && <li className="text-[11px] text-faint">and {hits.notes.length - 6} more</li>}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-faint">Type two or more letters for a dry run. Nothing is removed from here.</p>
      )}

      <Callout tone="info" icon={Trash2} title="What forgetting really means" className="mt-3">
        <ul className="list-disc space-y-0.5 pl-4">
          <li>The notes and learned facts are deleted from the vault.</li>
          <li>Their search embeddings and index entries are purged too, so she cannot recall them.</li>
          <li>Git history is rewritten so old versions cannot bring them back. Your own backups are not touched.</li>
        </ul>
      </Callout>
      <div className="mt-3">
        <Tip focusable side="top" align="start" text="Needs the vault daemon. Once it exists this arrives as a proposal with the full list, and you confirm it before anything is deleted.">
          <Button variant="danger" disabled aria-label="Forget everything (not available yet)">
            <Trash2 className="size-3.5" aria-hidden /> Forget everything
          </Button>
        </Tip>
      </div>
    </Panel>
  )
}

/** MEMORY: what she has learned (inspect and forget), where the vault lives, and a thorough forget-everything flow. */
export function MemorySection() {
  return (
    <div className="@container flex flex-col gap-3">
      <SectionHeader icon={Brain} title="Memory">
        Her memory is your second brain: plain files you own. She never keeps a secret copy somewhere else.
      </SectionHeader>
      <LearnedList />
      <div className="grid items-start gap-3 @3xl:grid-cols-2">
        <VaultCard />
        <ForgetEverything />
      </div>
    </div>
  )
}
