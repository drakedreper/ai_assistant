import type { Project, Session, Task } from '@ai-assistant/shared'
import { GitBranch } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Badge, type Tone } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { SESSION_STATUS } from '../../../lib/status'
import { SOURCE_INFO, TASK_SOURCE_INFO, shortModel, shortProject } from '../lib'

/** Project name in the project's own color (also used by the charts). */
export function ProjectChip({ project, className, dotOnly }: { project: Project | undefined; className?: string; dotOnly?: boolean }) {
  if (!project) return null
  return (
    <span
      title={project.name}
      className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap', className)}
      style={{ color: project.color, borderColor: `${project.color}4d`, background: `${project.color}1a` }}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: project.color }} />
      {!dotOnly && <span className="truncate">{shortProject(project.name)}</span>}
    </span>
  )
}

export function SourceBadge({ source }: { source: Session['source'] }) {
  const info = SOURCE_INFO[source]
  const Icon = info.icon
  return (
    <Badge title={info.tip} className="cursor-help">
      <Icon className="size-3" aria-hidden />
      {info.label}
    </Badge>
  )
}

export function TaskSourceBadge({ source }: { source: Task['source'] }) {
  const info = TASK_SOURCE_INFO[source]
  const Icon = info.icon
  return (
    <Badge title={info.tip} tone={source === 'federated' ? 'brain' : source === 'assistant' ? 'mira' : 'neutral'} className="cursor-help">
      <Icon className="size-3" aria-hidden />
      {info.label}
    </Badge>
  )
}

export function ModelBadge({ model }: { model: string }) {
  return (
    <Badge title={`API-equivalent pricing is estimated for ${model}`} className="font-mono text-[11px]">
      {shortModel(model)}
    </Badge>
  )
}

export function BranchChip({ branch, className }: { branch: string | undefined; className?: string }) {
  if (!branch) return null
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 font-mono text-[11px] text-muted', className)} title={`Branch ${branch}`}>
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{branch}</span>
    </span>
  )
}

export function StatusText({ status, className }: { status: Session['status']; className?: string }) {
  const st = SESSION_STATUS[status]
  return (
    <span className={cn('font-medium', className)} style={{ color: st.color }}>
      {st.label}
    </span>
  )
}

/** Tone for a Claude Code hook event name. */
export function hookTone(hook: string): Tone {
  switch (hook) {
    case 'SessionStart': return 'ok'
    case 'UserPromptSubmit': return 'mira'
    case 'PermissionRequest':
    case 'Notification': return 'warn'
    case 'PostToolUseFailure': return 'bad'
    case 'SubagentStart':
    case 'SubagentStop': return 'work'
    case 'Stop': return 'brain'
    default: return 'neutral'
  }
}

/** Filter chip (toggle button). */
export function FilterChip({
  active,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition',
        active ? 'border-work/40 bg-work/14 text-fg' : 'border-line text-muted hover:border-line-strong hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
