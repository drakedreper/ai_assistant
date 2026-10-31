import { Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Badge, Button, EmptyState } from '../../../components/ui'
import { useSnap } from '../../../state/store'
import { GROUP_LABEL, GROUP_ORDER, matchesStatus, sessionGroup, sortSessions, type SessionGroup } from '../lib'
import { useWork, type StatusFilter } from '../ui'
import { FilterChip, ProjectChip } from './Atoms'
import { SessionCard } from './SessionCard'
import { SessionDetail } from './SessionDetail'

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'needs', label: 'Needs you' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'done', label: 'Done' },
  { value: 'error', label: 'Failed' },
]

/** Overview tab: sessions grouped needs-you first on the left, the selected session on the right. */
export function Overview() {
  const sessions = useSnap((d) => d.sessions)
  const projects = useSnap((d) => d.projects)
  const projectFilter = useWork((s) => s.projectFilter)
  const toggleProject = useWork((s) => s.toggleProject)
  const clearProjects = useWork((s) => s.clearProjects)
  const statusFilter = useWork((s) => s.statusFilter)
  const setStatusFilter = useWork((s) => s.setStatusFilter)
  const query = useWork((s) => s.query)
  const setQuery = useWork((s) => s.setQuery)
  const sessionId = useWork((s) => s.sessionId)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sortSessions(
      sessions.filter(
        (s) =>
          (projectFilter.length === 0 || projectFilter.includes(s.projectId)) &&
          matchesStatus(s, statusFilter) &&
          (!q || `${s.title} ${s.branch ?? ''} ${s.projectId} ${s.model} ${s.source}`.toLowerCase().includes(q)),
      ),
    )
  }, [sessions, projectFilter, statusFilter, query])

  const groups = useMemo(() => {
    const out = new Map<SessionGroup, typeof filtered>()
    for (const g of GROUP_ORDER) out.set(g, [])
    for (const s of filtered) out.get(sessionGroup(s))?.push(s)
    return out
  }, [filtered])

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: sessions.length, needs: 0, running: 0, idle: 0, done: 0, error: 0 }
    for (const s of sessions) for (const f of STATUS_FILTERS) if (f.value !== 'all' && matchesStatus(s, f.value)) c[f.value]++
    return c
  }, [sessions])

  // Follow the first visible session until the user picks one; fall back if the pick is filtered out.
  const selected = sessions.find((s) => s.id === sessionId && filtered.some((f) => f.id === s.id)) ?? filtered[0]
  const selectedId = selected?.id
  const gridRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const firstRun = useRef(true)

  // When the screen is narrow the detail stacks below the list; bring it into view after a pick.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    const grid = gridRef.current
    if (!grid || !selectedId) return
    const stacked = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length === 1
    if (!stacked) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    detailRef.current?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }, [selectedId])

  const filtersActive = projectFilter.length > 0 || statusFilter !== 'all' || query.trim() !== ''

  return (
    <div ref={gridRef} className="grid items-start gap-3 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[160px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, branch, model"
                aria-label="Search sessions"
                className="glass h-8 w-full rounded-lg! pr-2.5 pl-8 text-[13px] text-fg placeholder:text-faint"
              />
            </label>
            <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
              {STATUS_FILTERS.map((f) => (
                <FilterChip key={f.value} active={statusFilter === f.value} onClick={() => setStatusFilter(f.value)}>
                  {f.label}
                  <span className="text-[11px] text-faint tabular-nums">{counts[f.value]}</span>
                </FilterChip>
              ))}
            </div>
          </div>
          <div role="group" aria-label="Filter by project" className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] tracking-wide text-faint uppercase">Projects</span>
            {projects.map((p) => {
              const on = projectFilter.includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleProject(p.id)}
                  className={`cursor-pointer rounded-full transition ${on ? 'ring-2 ring-white/40' : 'opacity-70 hover:opacity-100'}`}
                >
                  <ProjectChip project={p} />
                </button>
              )
            })}
            {filtersActive && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  clearProjects()
                  setStatusFilter('all')
                  setQuery('')
                }}
              >
                <X className="size-3" aria-hidden /> Clear filters
              </Button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="glass">
            <EmptyState title="No sessions match these filters" hint="Clear a filter or search for something else." />
          </div>
        ) : (
          GROUP_ORDER.map((g) => {
            const list = groups.get(g) ?? []
            if (list.length === 0) return null
            return (
              <section key={g} aria-label={GROUP_LABEL[g]} className="flex flex-col gap-2">
                <h3 className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
                  {GROUP_LABEL[g]}
                  <Badge tone={g === 'needs' ? 'warn' : g === 'problem' ? 'bad' : 'neutral'}>{list.length}</Badge>
                </h3>
                {list.map((s) => (
                  <SessionCard key={s.id} session={s} selected={s.id === selected?.id} />
                ))}
              </section>
            )
          })
        )}
      </div>

      <div ref={detailRef} className="min-w-0 scroll-mt-2 @4xl:sticky @4xl:top-0">
        {selected ? <SessionDetail session={selected} /> : <div className="glass"><EmptyState title="Select a session" hint="Its agents and events show up here." /></div>}
      </div>
    </div>
  )
}
