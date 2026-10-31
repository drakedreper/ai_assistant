import type { Contact, MailThread } from '@ai-assistant/shared'
import { Check, Lock, Sparkles } from 'lucide-react'
import { Badge } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { TRIAGE, WARMTH, type DraftState } from '../lib'

/** Triage chip with an icon, so the state never relies on color alone. Sent drafts read as "Replied". */
export function TriageBadge({ triage, draft, className }: { triage: MailThread['triage']; draft: DraftState; className?: string }) {
  if (draft === 'sent') {
    return (
      <Badge tone="ok" className={className} title="You approved the reply and it was sent">
        <Check className="size-3" aria-hidden /> Replied
      </Badge>
    )
  }
  const t = TRIAGE[triage]
  const Icon = t.icon
  return (
    <Badge tone={t.tone} className={className} title={t.hint}>
      <Icon className="size-3" aria-hidden /> {t.label}
    </Badge>
  )
}

export function DraftBadge({ draft }: { draft: DraftState }) {
  if (draft === 'pending') {
    return (
      <Badge tone="mira" title="Mira drafted a reply that waits for your approval">
        <Sparkles className="size-3" aria-hidden /> Draft ready
      </Badge>
    )
  }
  if (draft === 'dismissed') return <Badge title="You dismissed the draft. Nothing was sent.">Draft dismissed</Badge>
  return null
}

export function SensitivityBadge({ level }: { level: MailThread['sensitivity'] }) {
  if (level === 'normal') return null
  return (
    <Badge tone={level === 'sensitive' ? 'warn' : 'neutral'} title={level === 'sensitive' ? 'Sensitive: kept on this PC, never put in cloud context' : 'Private: snippet only, body fetched on demand'}>
      <Lock className="size-3" aria-hidden /> {level === 'sensitive' ? 'Sensitive' : 'Private'}
    </Badge>
  )
}

/** Five-pip meter for relationship warmth. */
export function WarmthMeter({ pips, warmth, className }: { pips: number; warmth: Contact['warmth']; className?: string }) {
  const w = WARMTH[warmth]
  return (
    <span role="meter" aria-label={`Warmth: ${w.label}`} aria-valuemin={0} aria-valuemax={5} aria-valuenow={pips} className={cn('inline-flex items-center gap-0.5', className)}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn('h-2 w-3 rounded-sm', i < pips ? w.bar : 'bg-white/10')} />
      ))}
    </span>
  )
}

export function WarmthBadge({ warmth }: { warmth: Contact['warmth'] }) {
  const w = WARMTH[warmth]
  return <Badge tone={w.tone}>{w.label}</Badge>
}
