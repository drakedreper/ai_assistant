import type { TrustRule } from '@ai-assistant/shared'
import { ArrowRight, Check, Heart, Lock, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useMemo } from 'react'
import { api } from '../../../api'
import { Badge, Button, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { TIER_LABEL } from '../../../lib/status'
import { useSnap } from '../../../state/store'
import { useSettingsUi } from '../ui'
import { Callout, SectionHeader, TierChip } from './Atoms'
import { ModeSwitch } from './Switch'

const TIERS: Array<{ tier: 'T0' | 'T1' | 'T2' | 'T3' | 'T4'; title: string; body: string }> = [
  { tier: 'T0', title: 'Read freely', body: 'Reads your data to answer. Always logged.' },
  { tier: 'T1', title: 'Journal and inbox', body: 'Appends only. Fully reversible.' },
  { tier: 'T2', title: 'Knowledge and projects', body: 'Edits notes. One git commit per write.' },
  { tier: 'T3', title: 'Core and strategy', body: 'Proposals only. You read the diff and apply it.' },
  { tier: 'T4', title: 'Outward actions', body: 'Send, create, spend. Asks every time until promoted.' },
]

const TIER_RING: Record<string, string> = {
  T0: 'border-ok/30',
  T1: 'border-world/30',
  T2: 'border-brain/30',
  T3: 'border-warn/30',
  T4: 'border-bad/30',
}

function Ladder({ rules }: { rules: TrustRule[] }) {
  return (
    <Panel title="The ladder" subtitle="Each action type climbs one rung at a time, only when you say so" icon={ShieldCheck}>
      <ol className="grid gap-2 @2xl:grid-cols-5">
        {TIERS.map((t, i) => {
          const rs = rules.filter((r) => r.tier === t.tier)
          const auto = rs.filter((r) => r.mode === 'auto').length
          const locked = rs.filter((r) => r.locked).length
          return (
            <li key={t.tier} className={cn('relative flex flex-col gap-1.5 rounded-xl border bg-white/[0.025] p-3', TIER_RING[t.tier])}>
              <div className="flex items-center gap-2">
                <TierChip tier={t.tier} short />
                {i < TIERS.length - 1 && <ArrowRight className="ml-auto hidden size-3.5 text-faint @2xl:block" aria-hidden />}
              </div>
              <h3 className="text-[13px] font-semibold text-fg">{t.title}</h3>
              <p className="text-[12px] leading-snug text-muted">{t.body}</p>
              <p className="mt-auto pt-1 text-[11px] text-faint tabular-nums">
                {rs.length} rule{rs.length === 1 ? '' : 's'}: {auto} auto{locked ? `, ${locked} locked` : ''}
              </p>
            </li>
          )
        })}
      </ol>
    </Panel>
  )
}

function Promotions({ rules }: { rules: TrustRule[] }) {
  const snoozed = useSettingsUi((s) => s.snoozedPromos)
  const snooze = useSettingsUi((s) => s.snoozePromo)
  const list = rules.filter((r) => r.promotionSuggested && !r.locked && r.mode === 'ask' && !snoozed.includes(r.id))
  if (list.length === 0) return null
  return (
    <div className="flex flex-col gap-2" role="region" aria-label="Promotion suggestions">
      {list.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-mira/30 bg-mira/8 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-mira/15 text-mira">
            <Sparkles className="size-4" aria-hidden />
          </span>
          <div className="min-w-[240px] flex-1">
            <p className="text-[13.5px] font-semibold text-fg">
              {r.approvals} approvals and {r.rejections} rejections. Let her do this on her own?
            </p>
            <p className="mt-0.5 text-[12.5px] leading-snug text-muted">
              <span className="font-medium text-fg">{r.action}</span> ({r.tier}). {r.description} You can switch it back to Ask at any time.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="md" onClick={() => void api.setTrustMode(r.id, 'auto')}>
              <Check className="size-4" aria-hidden /> Promote
            </Button>
            <Button variant="outline" size="md" onClick={() => snooze(r.id)}>
              Not yet
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

function RuleRow({ r }: { r: TrustRule }) {
  const total = r.approvals + r.rejections
  const note = r.locked
    ? null
    : r.promotionSuggested && r.mode === 'ask'
      ? 'Ready to promote'
      : r.rejections > 0 && r.mode === 'ask'
        ? 'Rejected before, so she keeps asking'
        : null
  return (
    <tr className={cn('align-top', r.locked && 'bg-bad/[0.04]')}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
          {r.locked && <Lock className="size-3.5 shrink-0 text-bad" aria-label="Locked" />}
          {r.action}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-muted">{r.locked && r.lockReason ? r.lockReason : r.description}</div>
        {note && <div className="mt-1 text-[11px] text-mira">{note}</div>}
      </td>
      <td className="px-2 py-3">
        <TierChip tier={r.tier} short />
      </td>
      <td className="px-2 py-3">
        <ModeSwitch
          mode={r.mode}
          locked={r.locked}
          label={r.locked ? `${r.action}: locked, always asks` : `${r.action}: ${r.mode === 'auto' ? 'switch to ask' : 'switch to auto'}`}
          onChange={(m) => void api.setTrustMode(r.id, m)}
        />
        {r.locked && <div className="mt-1 text-[11px] text-bad">Cannot be promoted</div>}
      </td>
      <td className="px-2 py-3 text-right text-[12px] whitespace-nowrap tabular-nums">
        {total === 0 && r.tier === 'T0' ? (
          <span className="text-faint">no approval needed</span>
        ) : (
          <>
            <span className="text-ok">{r.approvals} approved</span>
            <span className="mx-1 text-faint">/</span>
            <span className={r.rejections ? 'text-bad' : 'text-faint'}>{r.rejections} rejected</span>
          </>
        )}
      </td>
    </tr>
  )
}

/** TRUST LADDER: what she may do alone, what always asks, and what can never be promoted. */
export function TrustSection() {
  const rules = useSnap((d) => d.settings.trustRules)
  const sorted = useMemo(() => rules.map((r, i) => [r, i] as const).sort((a, b) => a[0].tier.localeCompare(b[0].tier) || a[1] - b[1]).map(([r]) => r), [rules])
  const autoCount = rules.filter((r) => r.mode === 'auto').length

  return (
    <div className="@container flex flex-col gap-3">
      <SectionHeader
        icon={ShieldCheck}
        title="Trust ladder"
        actions={
          <Badge tone="neutral" className="self-center tabular-nums">
            {autoCount} of {rules.length} on auto
          </Badge>
        }
      >
        She starts by asking. When an action type has a clean record, she offers to do it alone. You decide, one rule at a time, and you can take it back.
      </SectionHeader>

      <Ladder rules={rules} />
      <Promotions rules={rules} />

      <Panel title="Rules" subtitle="Ask means an approval card each time. Auto means she acts and logs it" icon={ShieldCheck} flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left">
            <caption className="sr-only">Trust rules by tier</caption>
            <thead className="border-b border-line text-[11px] tracking-wide text-faint uppercase">
              <tr>
                <th scope="col" className="px-4 py-1.5 font-medium">Action</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Tier</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Mode</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">Track record</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sorted.map((r) => (
                <RuleRow key={r.id} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Callout tone="lock" icon={Lock} title="Hard limits that never promote">
        <ul className="mt-1 flex flex-col gap-1.5">
          <li className="flex items-start gap-2">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-bad" aria-hidden />
            <span>
              <b className="font-semibold text-fg">Moving money.</b> There is no tool for it in v0.x and no approval history can unlock one. Atlas is read-only.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Heart className="mt-0.5 size-3.5 shrink-0 text-bad" aria-hidden />
            <span>
              <b className="font-semibold text-fg">Affection never authorises an action.</b> Kind words, a good mood or a long friendship do not skip an approval. Sending,
              spending and deleting stay behind the ladder.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <X className="mt-0.5 size-3.5 shrink-0 text-bad" aria-hidden />
            <span>
              <b className="font-semibold text-fg">{TIER_LABEL.T3} stays a proposal.</b> She can write the diff; only you can apply it. The reader lane never gets a send or
              write tool at all.
            </span>
          </li>
        </ul>
      </Callout>
    </div>
  )
}
