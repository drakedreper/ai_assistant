import type { FinancialIndependence } from '@ai-assistant/shared'
import { Info, Lightbulb, Target } from 'lucide-react'
import { NoteChip } from '../../../components/NoteChip'
import { Badge, Gauge, Panel, Stat } from '../../../components/ui'
import { fmtWhole, fmtDate, num } from '../lib'
import { Tip } from './Tip'

function daysBetween(aIso: string, bIso: string): number {
  const t = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1).getTime()
  }
  return Math.round((t(bIso) - t(aIso)) / 86_400_000)
}

function aheadText(days: number): string {
  const abs = Math.abs(days)
  const span = abs >= 14 && abs % 7 === 0 ? `${abs / 7} weeks` : abs === 1 ? '1 day' : `${abs} days`
  return days >= 0 ? `${span} ahead of target` : `${span} behind target`
}

/** Runway and the projected independence date, tied to the strategy note that defines the plan. */
export function IndependenceCard({ plan, monthlySaved, className }: { plan: FinancialIndependence; monthlySaved?: number; className?: string }) {
  const pct = Math.min(100, (plan.runwayMonths / plan.targetRunwayMonths) * 100)
  const ahead = daysBetween(plan.projectedDate, plan.targetDate)
  const onTrack = ahead >= 0
  // Dollars still needed to reach the target runway, and how many days $100 more saved a month would shave off.
  const gap = Math.max(0, plan.targetRunwayMonths - plan.runwayMonths) * num(plan.monthlyBurn)
  const per100 = monthlySaved && monthlySaved > 0 && gap > 0 ? Math.round((gap / monthlySaved - gap / (monthlySaved + 100)) * 30) : null
  return (
    <Panel
      title="Financial independence"
      subtitle="Plan lives in your strategy notes"
      icon={Target}
      area="money"
      className={className}
      actions={<Badge tone={onTrack ? 'ok' : 'warn'}>{onTrack ? 'On track' : 'Behind plan'}</Badge>}
      bodyClassName="flex flex-col"
    >
      <div className="@container flex flex-1 flex-col">
        <div className="flex items-end justify-between gap-3" data-sensitive>
          <div>
            <div className="flex items-center gap-1 text-[11px] tracking-wide text-faint uppercase">
              Runway now
              <Tip text={plan.basis} align="start" side="bottom">
                <span tabIndex={0} role="img" aria-label={`How runway is counted: ${plan.basis}`} className="cursor-help text-faint hover:text-muted">
                  <Info className="size-3" aria-hidden />
                </span>
              </Tip>
            </div>
            <div className="text-[28px] leading-none font-semibold text-fg tabular-nums">
              {plan.runwayMonths.toFixed(1)} <span className="text-[14px] font-medium text-muted">months</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] tracking-wide text-faint uppercase">Target</div>
            <div className="text-[15px] font-semibold text-fg tabular-nums">{plan.targetRunwayMonths} months</div>
          </div>
        </div>
        <Gauge pct={pct} color="var(--color-money)" height={8} className="mt-3" label={`Runway: ${plan.runwayMonths.toFixed(1)} of ${plan.targetRunwayMonths} months`} />
        <p className="mt-1.5 text-[11px] text-muted tabular-nums">{Math.round(pct)}% of the way there</p>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3 @md:grid-cols-4">
          <Stat label="Projected" value={fmtDate(plan.projectedDate, false)} sub={aheadText(ahead)} />
          <Stat label="Target date" value={fmtDate(plan.targetDate, false)} />
          <div data-sensitive>
            <Stat label="Saving" value={`${Math.round(plan.savingsRate * 100)}%`} sub="of income, 6-mo avg" />
          </div>
          <div data-sensitive>
            <Stat label="Monthly burn" value={fmtWhole(num(plan.monthlyBurn))} sub="6-mo average" />
          </div>
        </div>

        {per100 !== null && per100 > 0 && (
          <p className="mt-3 flex items-start gap-2 rounded-xl border border-line bg-white/[0.025] px-3 py-2 text-[12px] leading-snug text-muted">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-money" aria-hidden />
            <span data-sensitive>
              Every extra $100 saved a month pulls the date forward by about <b className="font-semibold text-fg">{per100} days</b>.
            </span>
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
          <span className="text-[11px] text-faint">Plan</span>
          <NoteChip path={plan.notePath} title="Financial independence plan" />
        </div>
      </div>
    </Panel>
  )
}
