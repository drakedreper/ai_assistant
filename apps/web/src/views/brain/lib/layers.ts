import type { BrainLayer, Note } from '@ai-assistant/shared'

/** The six vault layers plus the federated Secondbrain source. Hues come from the app palette. */
export type LayerKey = BrainLayer | 'federated'

export interface LayerMeta {
  key: LayerKey
  folder: string
  label: string
  hex: string
  blurb: string
}

export const LAYERS: Record<LayerKey, LayerMeta> = {
  core: { key: 'core', folder: '00-core', label: 'Core', hex: '#ff8fb1', blurb: 'Always in her context: persona, values, profile, operating rules.' },
  strategy: { key: 'strategy', folder: '10-strategy', label: 'Strategy', hex: '#fbbf24', blurb: 'Long-term thinking and decisions. Protected: changes arrive as proposals.' },
  episodic: { key: 'episodic', folder: '20-journal', label: 'Journal', hex: '#60a5fa', blurb: 'Append-only daily log, weekly reviews and reflections.' },
  semantic: { key: 'semantic', folder: '30-knowledge', label: 'Knowledge', hex: '#a78bfa', blurb: 'Atomic concept and people notes.' },
  project: { key: 'project', folder: '40-projects', label: 'Projects', hex: '#2dd4bf', blurb: 'Project hubs that link to dashboard sessions.' },
  inbox: { key: 'inbox', folder: '50-inbox', label: 'Inbox', hex: '#fb923c', blurb: 'Raw captures waiting for the nightly dream.' },
  federated: { key: 'federated', folder: 'secondbrain', label: 'Secondbrain', hex: '#9ca4c9', blurb: 'Federated source, attached read-only.' },
}

export const LAYER_ORDER: LayerKey[] = ['core', 'strategy', 'episodic', 'semantic', 'project', 'inbox', 'federated']
export const VAULT_LAYERS: LayerKey[] = ['core', 'strategy', 'episodic', 'semantic', 'project', 'inbox']

export function layerKeyOf(n: Pick<Note, 'layer' | 'source'>): LayerKey {
  return n.source === 'secondbrain' ? 'federated' : n.layer
}

export function isProtected(n: Pick<Note, 'layer' | 'source'>): boolean {
  return n.source !== 'secondbrain' && (n.layer === 'core' || n.layer === 'strategy')
}

/** Hex colour with an alpha channel (0..1), for tinted backgrounds and borders. */
export function tint(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  return `${hex}${a.toString(16).padStart(2, '0')}`
}

/** Always-loaded context budget (tokens) for the core layer. */
export const CORE_BUDGET_TOKENS = 4000

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)
}
