import {
  AlertTriangle,
  Brain,
  Briefcase,
  CalendarDays,
  Camera,
  Check,
  Globe,
  Loader2,
  Mail,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../lib/cn'

const BY_PREFIX: Array<[string, { icon: LucideIcon; text: string }]> = [
  ['brain_', { icon: Brain, text: 'text-brain' }],
  ['calendar_', { icon: CalendarDays, text: 'text-life' }],
  ['mail_', { icon: Mail, text: 'text-life' }],
  ['contacts_', { icon: Users, text: 'text-life' }],
  ['finance_', { icon: Wallet, text: 'text-money' }],
  ['worklog_', { icon: Briefcase, text: 'text-work' }],
  ['news_', { icon: Globe, text: 'text-world' }],
  ['camera_', { icon: Camera, text: 'text-mira' }],
]

/** A tool she used, as a small chip: icon, what she did, and a spinner until it finishes. */
export function ToolChip({
  tool,
  summary,
  status,
  className,
}: {
  tool: string
  summary: string
  status: 'running' | 'done' | 'error'
  className?: string
}) {
  const hit = BY_PREFIX.find(([p]) => tool.startsWith(p))?.[1]
  const Icon = hit?.icon ?? Wrench
  return (
    <span
      title={`Tool: ${tool}`}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-white/[0.04] py-0.5 pr-2 pl-1.5 text-[11px] leading-4 text-muted',
        status === 'error' && 'border-bad/30 text-bad',
        className,
      )}
    >
      <Icon className={cn('size-3 shrink-0', hit?.text ?? 'text-muted')} aria-hidden />
      <span className="truncate">{summary}</span>
      {status === 'running' && <Loader2 className="size-3 shrink-0 animate-spin text-mira motion-reduce:animate-none" aria-label="running" />}
      {status === 'done' && <Check className="size-3 shrink-0 text-ok" aria-label="done" />}
      {status === 'error' && <AlertTriangle className="size-3 shrink-0" aria-label="failed" />}
    </span>
  )
}
