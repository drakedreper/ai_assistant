import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Project, Session, Task, TaskColumn } from '@ai-assistant/shared'
import { ArrowDown, ArrowUp, ExternalLink, Minus, Plus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../../api'
import { Badge, Button, StatusDot } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { SESSION_STATUS } from '../../../lib/status'
import { useSnap } from '../../../state/store'
import { shortProject } from '../lib'
import { useWork } from '../ui'
import { BranchChip, FilterChip, ProjectChip, TaskSourceBadge } from './Atoms'

const COLUMNS: Array<{ id: TaskColumn; label: string; accent: string }> = [
  { id: 'backlog', label: 'Backlog', accent: 'border-t-faint' },
  { id: 'todo', label: 'Todo', accent: 'border-t-world' },
  { id: 'doing', label: 'Doing', accent: 'border-t-work' },
  { id: 'review', label: 'Review', accent: 'border-t-brain' },
  { id: 'done', label: 'Done', accent: 'border-t-ok' },
]
const COLUMN_IDS = COLUMNS.map((c) => c.id) as string[]
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label])) as Record<TaskColumn, string>

type Layout = Record<TaskColumn, string[]>

const PRIORITY = {
  high: { icon: ArrowUp, cls: 'text-bad', label: 'High priority' },
  medium: { icon: Minus, cls: 'text-warn', label: 'Medium priority' },
  low: { icon: ArrowDown, cls: 'text-faint', label: 'Low priority' },
} as const

function buildLayout(tasks: Task[], order: string[], override: Record<string, TaskColumn>, projectFilter: string[]): Layout {
  const rank = new Map(order.map((id, i) => [id, i]))
  const out: Layout = { backlog: [], todo: [], doing: [], review: [], done: [] }
  const pos = new Map<string, number>()
  tasks.forEach((t, i) => {
    pos.set(t.id, i)
    if (projectFilter.length && !(t.projectId && projectFilter.includes(t.projectId))) return
    out[override[t.id] ?? t.column].push(t.id)
  })
  const key = (id: string) => rank.get(id) ?? 1000 + (pos.get(id) ?? 0)
  for (const c of COLUMNS) out[c.id].sort((a, b) => key(a) - key(b))
  return out
}

function findColumn(id: UniqueIdentifier, l: Layout): TaskColumn | undefined {
  const s = String(id)
  if (COLUMN_IDS.includes(s)) return s as TaskColumn
  return COLUMNS.find((c) => l[c.id].includes(s))?.id
}

function prLabel(url: string): string {
  const m = /\/(?:pr|pull)\/(\d+)/.exec(url)
  return m ? `PR #${m[1]}` : 'PR'
}

// ---------- card ----------

function TaskCard({
  task,
  project,
  sessions,
  highlighted,
  overlay,
}: {
  task: Task
  project: Project | undefined
  sessions: Session[]
  highlighted?: boolean
  overlay?: boolean
}) {
  const selectSession = useWork((s) => s.selectSession)
  const setTab = useWork((s) => s.setTab)
  const pr = PRIORITY[task.priority]
  const PrIcon = pr.icon
  const needs = sessions.find((s) => SESSION_STATUS[s.status].needsYou)
  const running = sessions.find((s) => s.status === 'running')
  const failed = sessions.find((s) => s.status === 'error')
  const live = task.column === 'doing' ? (needs ? 'needs' : running ? 'live' : failed ? 'failed' : null) : null

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border p-2.5 pl-3.5 text-left shadow-sm transition',
        overlay ? 'bg-raised' : 'bg-raised/80',
        highlighted ? 'border-work ring-2 ring-work/60' : 'border-line hover:border-line-strong',
        overlay && 'rotate-1 cursor-grabbing border-line-strong shadow-2xl',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: project?.color ?? 'var(--color-faint)' }} aria-hidden />
      <div className="flex items-start gap-1.5">
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug font-medium break-words text-fg">{task.title}</p>
        <span className={cn('mt-0.5 shrink-0', pr.cls)} title={pr.label}>
          <PrIcon className="size-3.5" aria-hidden />
          <span className="sr-only">{pr.label}</span>
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        {project && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: project.color }}>
            {shortProject(project.name)}
          </span>
        )}
        {live === 'live' && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ok">
            <StatusDot color="var(--color-ok)" pulse /> Live
          </span>
        )}
        {live === 'needs' && <Badge tone="warn">Needs you</Badge>}
        {live === 'failed' && <Badge tone="bad">Failed</Badge>}
      </div>

      {sessions.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {sessions.map((s) => {
            const st = SESSION_STATUS[s.status]
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  selectSession(s.id)
                  setTab('overview')
                }}
                title={`${s.title} (${st.label}). Open in Overview`}
                className="flex w-full max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-line bg-white/[0.03] px-1.5 py-0.5 text-left text-[11px] text-muted transition hover:border-line-strong hover:text-fg"
              >
                <StatusDot color={st.color} pulse={st.pulse} className="size-1.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="sr-only">{st.label}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <TaskSourceBadge source={task.source} />
        <BranchChip branch={task.branch} className="max-w-full" />
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${prLabel(task.prUrl)} for "${task.title}" (new tab)`}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-world hover:underline"
          >
            {prLabel(task.prUrl)} <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>
    </div>
  )
}

function SortableCard({ task, project, sessions, highlighted }: { task: Task; project: Project | undefined; sessions: Session[]; highlighted: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    attributes: { role: 'listitem', roleDescription: 'draggable card' },
  })
  return (
    <div
      ref={setNodeRef}
      id={`task-${task.id}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      aria-label={task.title}
      {...attributes}
      {...listeners}
      className={cn('touch-manipulation rounded-lg outline-offset-2', isDragging ? 'opacity-30' : 'cursor-grab')}
    >
      <TaskCard task={task} project={project} sessions={sessions} highlighted={highlighted} />
    </div>
  )
}

// ---------- add card ----------

function AddCard({ column, label, defaultProject }: { column: TaskColumn; label: string; defaultProject?: string }) {
  const projects = useSnap((d) => d.projects)
  const toast = useWork((s) => s.toast)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState(defaultProject ?? '')

  const close = () => {
    setOpen(false)
    setTitle('')
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setProjectId(defaultProject ?? projectId)
          setOpen(true)
        }}
        className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg border border-dashed border-line px-2 py-1.5 text-[12px] text-faint transition hover:border-line-strong hover:text-fg"
      >
        <Plus className="size-3.5" aria-hidden /> Add card
        <span className="sr-only"> to {label}</span>
      </button>
    )
  }
  return (
    <form
      className="flex flex-col gap-1.5 rounded-lg border border-line-strong bg-black/25 p-2"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
      }}
      onSubmit={(e) => {
        e.preventDefault()
        const t = title.trim()
        if (!t) return
        void api.createTask({ title: t, column, ...(projectId ? { projectId } : {}) })
        toast(`Added "${t}" to ${label}.`, 'ok')
        close()
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label={`New card title for ${label}`}
        placeholder="What needs doing?"
        className="h-7 w-full rounded-md border border-line-strong bg-black/30 px-2 text-xs text-fg placeholder:text-faint"
      />
      <select
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        aria-label="Project for the new card"
        className="h-7 w-full rounded-md border border-line-strong bg-surface px-1.5 text-xs text-fg"
      >
        <option value="">No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {shortProject(p.name)}
          </option>
        ))}
      </select>
      <div className="flex gap-1.5">
        <Button type="submit" variant="primary" size="xs" disabled={!title.trim()}>
          Add
        </Button>
        <Button variant="ghost" size="xs" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ---------- column ----------

function Column({
  col,
  ids,
  byId,
  projects,
  sessionsByTask,
  highlightTask,
  defaultProject,
}: {
  col: (typeof COLUMNS)[number]
  ids: string[]
  byId: Map<string, Task>
  projects: Project[]
  sessionsByTask: (t: Task) => Session[]
  highlightTask: string | undefined
  defaultProject: string | undefined
}) {
  const { setNodeRef, isOver } = useDroppable({ id: col.id })
  return (
    <section
      aria-label={`${col.label}, ${ids.length} cards`}
      className={cn(
        'flex min-h-[260px] min-w-0 flex-col rounded-xl border border-t-2 border-line bg-white/[0.02] p-2 transition',
        col.accent,
        isOver && 'bg-white/[0.06] ring-1 ring-white/20',
      )}
    >
      <header className="flex items-center gap-2 px-1 pb-2">
        <h3 className="text-[12px] font-semibold tracking-wide text-fg">{col.label}</h3>
        <Badge className="tabular-nums">{ids.length}</Badge>
      </header>
      <div ref={setNodeRef} role="list" aria-label={`${col.label} cards`} className="flex min-h-14 flex-1 flex-col gap-2">
        <SortableContext id={col.id} items={ids} strategy={verticalListSortingStrategy}>
          {ids.map((id) => {
            const t = byId.get(id)
            if (!t) return null
            return (
              <SortableCard
                key={id}
                task={t}
                project={projects.find((p) => p.id === t.projectId)}
                sessions={sessionsByTask(t)}
                highlighted={highlightTask === id}
              />
            )
          })}
        </SortableContext>
        {ids.length === 0 && (
          <div className="grid min-h-20 place-items-center rounded-lg border border-dashed border-line p-3 text-center text-[11px] text-faint">
            Drop a card here
          </div>
        )}
        <AddCard column={col.id} label={col.label} {...(defaultProject ? { defaultProject } : {})} />
      </div>
    </section>
  )
}

// ---------- board ----------

export function Board() {
  const tasks = useSnap((d) => d.tasks)
  const projects = useSnap((d) => d.projects)
  const sessions = useSnap((d) => d.sessions)
  const order = useWork((s) => s.taskOrder)
  const setOrder = useWork((s) => s.setTaskOrder)
  const override = useWork((s) => s.moveOverride)
  const setOverride = useWork((s) => s.setOverride)
  const extraLinks = useWork((s) => s.extraLinks)
  const projectFilter = useWork((s) => s.projectFilter)
  const toggleProject = useWork((s) => s.toggleProject)
  const clearProjects = useWork((s) => s.clearProjects)
  const highlightTask = useWork((s) => s.highlight.task)
  const toast = useWork((s) => s.toast)

  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragLayout, setDragLayout] = useState<Layout | null>(null)

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const baseLayout = useMemo(() => buildLayout(tasks, order, override, projectFilter), [tasks, order, override, projectFilter])
  const layout = dragLayout ?? baseLayout
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // Drop optimistic overrides once the snapshot agrees.
  useEffect(() => {
    for (const t of tasks) if (override[t.id] && override[t.id] === t.column) setOverride(t.id, null)
  }, [tasks, override, setOverride])

  // Deep link: bring the card into view.
  useEffect(() => {
    if (!highlightTask) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`task-${highlightTask}`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }, [highlightTask])

  const sessionsByTask = (t: Task): Session[] => {
    const ids = [...t.sessionIds, ...(extraLinks[t.id] ?? []).filter((x) => !t.sessionIds.includes(x))]
    return ids.map((id) => sessions.find((s) => s.id === id)).filter((s): s is Session => !!s)
  }

  // Arrow keys should hop between columns (left/right) or cards of the same column (up/down). dnd-kit's default
  // lets the first Right press land on a neighbour in the same column, so candidates are filtered by column:
  // all cards of a column share the same left edge. A column's own drop zone only counts while it is empty.
  const coordinateGetter: KeyboardCoordinateGetter = (event, args) => {
    const all = args.context.droppableContainers
    const { droppableRects, collisionRect } = args.context
    const horizontal = event.code === 'ArrowLeft' || event.code === 'ArrowRight'
    const usable = all.getEnabled().filter((c) => {
      const id = String(c.id)
      if (COLUMN_IDS.includes(id) && (layoutRef.current[id as TaskColumn]?.length ?? 0) > 0) return false
      const r = droppableRects.get(c.id)
      if (!r || !collisionRect) return true
      const sameColumn = Math.abs(r.left - collisionRect.left) < 40
      return horizontal ? !sameColumn : sameColumn
    })
    const scoped = { getEnabled: () => usable, get: (id: UniqueIdentifier) => all.get(id) } as unknown as typeof all
    return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableContainers: scoped } })
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter }))

  const titleOf = (id: UniqueIdentifier) => byId.get(String(id))?.title ?? 'card'
  const columnLabel = (id: UniqueIdentifier | undefined) => {
    if (id === undefined) return 'nowhere'
    const c = findColumn(id, layoutRef.current)
    return c ? LABEL[c] : 'nowhere'
  }
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up "${titleOf(active.id)}" from ${columnLabel(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `"${titleOf(active.id)}" is over ${columnLabel(over.id)}.` : `"${titleOf(active.id)}" is not over a column.`),
    onDragEnd: ({ active, over }) => (over ? `Dropped "${titleOf(active.id)}" in ${columnLabel(over.id)}.` : `"${titleOf(active.id)}" returned to ${columnLabel(active.id)}.`),
    onDragCancel: ({ active }) => `Cancelled. "${titleOf(active.id)}" stays in ${columnLabel(active.id)}.`,
  }

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id))
    setDragLayout(baseLayout)
  }

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return
    setDragLayout((prev) => {
      const l = prev ?? baseLayout
      const from = findColumn(active.id, l)
      const to = findColumn(over.id, l)
      if (!from || !to || from === to) return prev
      const activeKey = String(active.id)
      const dest = l[to].slice()
      let at = dest.length
      if (!COLUMN_IDS.includes(String(over.id))) {
        const overIdx = dest.indexOf(String(over.id))
        const moved = active.rect.current.translated
        const below = !!moved && moved.top > over.rect.top + over.rect.height / 2
        at = overIdx + (below ? 1 : 0)
      }
      dest.splice(at, 0, activeKey)
      return { ...l, [from]: l[from].filter((i) => i !== activeKey), [to]: dest }
    })
  }

  const finish = () => {
    setActiveId(null)
    setDragLayout(null)
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const id = String(active.id)
    const l = layoutRef.current
    let final = l
    if (over) {
      const col = findColumn(id, l)
      const overCol = findColumn(over.id, l)
      if (col && overCol && col === overCol) {
        const oldIdx = l[col].indexOf(id)
        const newIdx = COLUMN_IDS.includes(String(over.id)) ? l[col].length - 1 : l[col].indexOf(String(over.id))
        if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) final = { ...l, [col]: arrayMove(l[col], oldIdx, newIdx) }
      }
    }
    const flat = COLUMNS.flatMap((c) => final[c.id])
    setOrder([...flat, ...order.filter((x) => !flat.includes(x))])
    const task = byId.get(id)
    const newCol = findColumn(id, final)
    const from = task ? (override[id] ?? task.column) : undefined
    if (task && newCol && newCol !== from) {
      setOverride(id, newCol)
      void api.moveTask(id, newCol)
      toast(`Moved "${task.title}" to ${LABEL[newCol]}.`, 'ok')
    }
    finish()
  }

  const activeTask = activeId ? byId.get(activeId) : undefined
  const total = tasks.length
  const doing = tasks.filter((t) => (override[t.id] ?? t.column) === 'doing').length
  const singleProject = projectFilter.length === 1 ? projectFilter[0] : undefined

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Filter cards by project" className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] tracking-wide text-faint uppercase">Projects</span>
          {projects.map((p) => {
            const on = projectFilter.includes(p.id)
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleProject(p.id)}
                className={cn('cursor-pointer rounded-full transition', on ? 'ring-2 ring-white/40' : 'opacity-70 hover:opacity-100')}
              >
                <ProjectChip project={p} />
              </button>
            )
          })}
          {projectFilter.length > 0 && (
            <FilterChip active={false} onClick={clearProjects}>
              Clear
            </FilterChip>
          )}
        </div>
        <p className="ml-auto text-[11px] text-faint tabular-nums">
          {total} cards · {doing} in progress · drag to move, or focus a card and press Space, arrows, Space
        </p>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{ announcements }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={finish}
      >
        <div className="overflow-x-auto pb-1">
          <div className="grid min-w-[760px] grid-cols-5 gap-2.5">
            {COLUMNS.map((c) => (
              <Column
                key={c.id}
                col={c}
                ids={layout[c.id]}
                byId={byId}
                projects={projects}
                sessionsByTask={sessionsByTask}
                highlightTask={highlightTask}
                defaultProject={singleProject}
              />
            ))}
          </div>
        </div>
        {/* Portaled: the stage and this screen are transformed/contained, which would offset a fixed overlay. */}
        {createPortal(
          <DragOverlay>
            {activeTask ? (
              <TaskCard task={activeTask} project={projects.find((p) => p.id === activeTask.projectId)} sessions={sessionsByTask(activeTask)} overlay />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
        Card sources:
        <TaskSourceBadge source="manual" />
        <TaskSourceBadge source="assistant" />
        <TaskSourceBadge source="claude_task" />
        <TaskSourceBadge source="federated" />
        <span>Federated cards are read from your Secondbrain app.</span>
      </p>
    </div>
  )
}
