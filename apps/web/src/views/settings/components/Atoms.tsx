import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge, type Tone } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { TIER_LABEL } from '../../../lib/status'

/** Section title row used at the top of every Settings section. */
export function SectionHeader({ icon: Icon, title, children, actions }: { icon: LucideIcon; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start gap-3 px-1">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-white/6 text-muted">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[15px] leading-tight font-semibold text-fg">{title}</h2>
        {children && <p className="mt-0.5 max-w-[78ch] text-[12.5px] leading-snug text-muted">{children}</p>}
      </div>
      {actions}
    </header>
  )
}

const TIER_TONE: Record<string, Tone> = { T0: 'ok', T1: 'world', T2: 'brain', T3: 'warn', T4: 'bad' }

/** Tier pill: always carries the tier and its plain-language name, never colour alone. */
export function TierChip({ tier, short }: { tier: string; short?: boolean }) {
  return (
    <Badge tone={TIER_TONE[tier] ?? 'neutral'} title={`Autonomy tier ${tier}: ${TIER_LABEL[tier] ?? ''}`}>
      {tier}
      {!short && <span className="font-normal opacity-90">{TIER_LABEL[tier]}</span>}
    </Badge>
  )
}

/** Boxed note: info / warn / lock callouts that explain a limit honestly. */
export function Callout({
  tone = 'info',
  icon: Icon,
  title,
  children,
  className,
}: {
  tone?: 'info' | 'warn' | 'lock' | 'mira'
  icon: LucideIcon
  title?: string
  children: ReactNode
  className?: string
}) {
  const t = {
    info: 'border-world/25 bg-world/8 [&_.ico]:text-world',
    warn: 'border-warn/30 bg-warn/10 [&_.ico]:text-warn',
    lock: 'border-bad/25 bg-bad/8 [&_.ico]:text-bad',
    mira: 'border-mira/30 bg-mira/8 [&_.ico]:text-mira',
  }[tone]
  return (
    <div className={cn('flex gap-3 rounded-xl border px-3.5 py-3', t, className)}>
      <Icon className="ico mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-[12.5px] leading-relaxed text-muted">
        {title && <p className="mb-0.5 text-[13px] font-semibold text-fg">{title}</p>}
        {children}
      </div>
    </div>
  )
}

/** Label / hint on the left, a control on the right. */
export function SettingRow({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5', className)}>
      <div className="min-w-[200px] flex-1">
        <div className="text-[13px] font-medium text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

export const INPUT_CLS =
  'h-9 w-full rounded-lg border border-line-strong bg-black/25 px-3 text-[13px] text-fg placeholder:text-faint transition hover:border-white/25 focus:border-mira/60 focus:outline-none'
