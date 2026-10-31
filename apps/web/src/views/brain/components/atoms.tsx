import type { Note } from '@ai-assistant/shared'
import { Download, EyeOff, GitCommitHorizontal, Link2, Lock, Moon, ShieldCheck, Sparkles, User, type LucideIcon } from 'lucide-react'
import { Badge, type Tone } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { LAYERS, layerKeyOf, tint, type LayerKey } from '../lib/layers'

/** Small square layer marker. */
export function LayerDot({ layer, size = 8, className }: { layer: LayerKey; size?: number; className?: string }) {
  return <span aria-hidden className={cn('inline-block shrink-0 rounded-[3px]', className)} style={{ width: size, height: size, background: LAYERS[layer].hex }} />
}

/** Layer name in the layer hue. */
export function LayerBadge({ layer, label }: { layer: LayerKey; label?: string }) {
  const m = LAYERS[layer]
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap"
      style={{ color: m.hex, borderColor: tint(m.hex, 0.35), background: tint(m.hex, 0.12), borderStyle: layer === 'federated' ? 'dashed' : 'solid' }}
    >
      <LayerDot layer={layer} size={6} />
      {label ?? m.label}
    </span>
  )
}

/** Importance 1..5 as dots. */
export function ImportanceDots({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-[3px]', className)} role="img" aria-label={`Importance ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={cn('size-1.5 rounded-full', i <= value ? 'bg-brain' : 'bg-white/14')} />
      ))}
    </span>
  )
}

export const PROVENANCE: Record<Note['provenance'], { label: string; tone: Tone; icon: LucideIcon; hint: string }> = {
  user: { label: 'You', tone: 'neutral', icon: User, hint: 'Written by you' },
  assistant: { label: 'Mira', tone: 'mira', icon: Sparkles, hint: 'Written by Mira from your conversations' },
  dream: { label: 'Nightly dream', tone: 'brain', icon: Moon, hint: 'Consolidated by the nightly dream' },
  import: { label: 'Imported', tone: 'info', icon: Download, hint: 'Imported from a clip or file' },
  federated: { label: 'Secondbrain', tone: 'neutral', icon: Link2, hint: 'From the federated Secondbrain app, read-only' },
}

export function ProvenanceBadge({ value, className }: { value: Note['provenance']; className?: string }) {
  const p = PROVENANCE[value]
  const Icon = p.icon
  return (
    <Badge tone={p.tone} title={p.hint} className={className}>
      <Icon className="size-3" aria-hidden />
      {p.label}
    </Badge>
  )
}

export function ConfidenceBadge({ value }: { value: Note['confidence'] }) {
  const tone: Tone = value === 'high' ? 'ok' : value === 'medium' ? 'warn' : 'neutral'
  return <Badge tone={tone}>{value}</Badge>
}

export function SensitivityBadge({ value }: { value: Note['sensitivity'] }) {
  if (value === 'normal') return <Badge>normal</Badge>
  return (
    <Badge tone={value === 'sensitive' ? 'bad' : 'warn'} title="Never sent to a cloud model">
      <EyeOff className="size-3" aria-hidden />
      {value}
    </Badge>
  )
}

export function StatusBadge({ value }: { value: Note['status'] }) {
  const tone: Tone = value === 'active' ? 'ok' : value === 'draft' ? 'info' : 'neutral'
  return <Badge tone={tone}>{value}</Badge>
}

/** Protection marker used in the tree and the reader. */
export function ProtectionMark({ note, className }: { note: Pick<Note, 'layer' | 'source'>; className?: string }) {
  const lk = layerKeyOf(note)
  if (lk === 'core')
    return (
      <span title="Always in her context. Changes arrive as proposals." className={cn('inline-flex', className)}>
        <Lock className="size-3 text-mira" aria-label="Always in context" />
      </span>
    )
  if (lk === 'strategy')
    return (
      <span title="Protected: changes arrive as proposals." className={cn('inline-flex', className)}>
        <ShieldCheck className="size-3 text-money" aria-label="Protected" />
      </span>
    )
  return null
}

/** git commit chip. */
export function CommitChip({ sha, title }: { sha: string; title?: string }) {
  return (
    <span
      title={title ?? `git commit ${sha}. Revert it to undo this change.`}
      className="inline-flex items-center gap-1 rounded-md border border-line bg-white/4 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-muted"
    >
      <GitCommitHorizontal className="size-3" aria-hidden />
      {sha}
    </span>
  )
}
