import { Brain, Cpu, Plug, ScrollText, ShieldCheck, UserRound, Lock, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { StatusDot } from '../../components/ui'
import { cn } from '../../lib/cn'
import { useSnap, useStore } from '../../state/store'
import { AuditSection } from './components/AuditSection'
import { ClaudeSection } from './components/ClaudeSection'
import { IntegrationsSection } from './components/IntegrationsSection'
import { MemorySection } from './components/MemorySection'
import { PersonaSection } from './components/PersonaSection'
import { PrivacySection } from './components/PrivacySection'
import { TrustSection } from './components/TrustSection'
import { SECTIONS, toSection, useSettingsUi, type SettingsSection } from './ui'

const NAV: Record<SettingsSection, { label: string; icon: LucideIcon }> = {
  persona: { label: 'Persona', icon: UserRound },
  claude: { label: 'Claude connection', icon: Cpu },
  integrations: { label: 'Integrations', icon: Plug },
  trust: { label: 'Trust ladder', icon: Lock },
  privacy: { label: 'Privacy', icon: ShieldCheck },
  audit: { label: 'Audit log', icon: ScrollText },
  memory: { label: 'Memory', icon: Brain },
}

function NavBadge({ id }: { id: SettingsSection }): ReactNode {
  const claude = useSnap((d) => d.settings.claude)
  const rules = useSnap((d) => d.settings.trustRules)
  const guest = useSnap((d) => d.settings.guestMode)
  const cam = useSnap((d) => d.settings.webcam.enabled)
  const audit = useSnap((d) => d.settings.audit.length)
  const learned = useSnap((d) => d.learned.length)
  const snoozed = useSettingsUi((s) => s.snoozedPromos)
  const chip = 'rounded-full px-1.5 text-[10px] leading-4 font-semibold tabular-nums'
  switch (id) {
    case 'claude':
      return (
        <span role="img" aria-label={`Claude ${claude.status}`} title={`Claude ${claude.status}`}>
          <StatusDot color={claude.status === 'connected' ? 'var(--color-ok)' : 'var(--color-warn)'} pulse={claude.status === 'connected'} className="size-1.5" />
        </span>
      )
    case 'trust': {
      const n = rules.filter((r) => r.promotionSuggested && !r.locked && r.mode === 'ask' && !snoozed.includes(r.id)).length
      return n > 0 ? <span className={cn(chip, 'bg-mira text-canvas')} aria-label={`${n} promotion suggestions`}>{n}</span> : null
    }
    case 'privacy':
      return guest || cam ? (
        <span className={cn(chip, 'bg-warn/20 text-warn')}>{[guest && 'guest', cam && 'cam'].filter(Boolean).join(' + ')}</span>
      ) : null
    case 'audit':
      return <span className="text-[11px] text-faint tabular-nums">{audit}</span>
    case 'memory':
      return <span className="text-[11px] text-faint tabular-nums">{learned}</span>
    default:
      return null
  }
}

function Body({ section }: { section: SettingsSection }) {
  switch (section) {
    case 'persona': return <PersonaSection />
    case 'claude': return <ClaudeSection />
    case 'integrations': return <IntegrationsSection />
    case 'trust': return <TrustSection />
    case 'privacy': return <PrivacySection />
    case 'audit': return <AuditSection />
    case 'memory': return <MemorySection />
  }
}

/**
 * SETTINGS: persona, Claude connection, integrations, the trust ladder, privacy, audit and memory. A left
 * sub-navigation (a strip on narrow stages) switches sections; deep links pass { tab } to open one directly.
 */
export function SettingsView() {
  const section = useSettingsUi((s) => s.section)
  const setSection = useSettingsUi((s) => s.setSection)
  const params = useStore((s) => s.viewParams)
  const clearParams = useStore((s) => s.clearParams)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!params || Object.keys(params).length === 0) return
    const next = toSection(params.tab)
    if (next) {
      setSection(next)
      clearParams()
    }
  }, [params, setSection, clearParams])

  // Switching section starts at the top of the stage, like opening a new page.
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 })
  }, [section])

  const onKey = (e: KeyboardEvent, i: number) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']
    if (!keys.includes(e.key)) return
    e.preventDefault()
    const n = SECTIONS.length
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + n) % n
    const next = SECTIONS[j]
    if (next) {
      setSection(next)
      tabs.current[j]?.focus()
    }
  }

  return (
    <div className="@container pb-4">
      <header className="mb-3 px-1">
        <h1 className="text-[17px] leading-tight font-semibold text-fg">Settings</h1>
        <p className="text-[12px] text-faint">Make her yours, and keep the hard limits where they belong.</p>
      </header>

      <div className="grid gap-3 @3xl:grid-cols-[190px_minmax(0,1fr)]">
        <div className="min-w-0 @3xl:sticky @3xl:top-0 @3xl:self-start">
          <div
            role="tablist"
            aria-label="Settings sections"
            aria-orientation="vertical"
            className="flex flex-wrap gap-1 @3xl:flex-col @3xl:flex-nowrap"
          >
            {SECTIONS.map((id, i) => {
              const n = NAV[id]
              const Icon = n.icon
              const active = id === section
              return (
                <button
                  key={id}
                  ref={(el) => {
                    tabs.current[i] = el
                  }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  aria-selected={active}
                  aria-controls="settings-panel"
                  tabIndex={active ? 0 : -1}
                  onClick={() => setSection(id)}
                  onKeyDown={(e) => onKey(e, i)}
                  className={cn(
                    'flex shrink-0 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-[13px] font-medium whitespace-nowrap transition',
                    active ? 'border-line-strong bg-white/10 text-fg' : 'border-transparent text-muted hover:bg-white/[0.05] hover:text-fg',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', active ? 'text-mira' : 'text-faint')} aria-hidden />
                  <span className="flex-1">{n.label}</span>
                  <NavBadge id={id} />
                </button>
              )
            })}
          </div>
        </div>

        <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section}`} className="min-w-0">
          <Body section={section} />
        </div>
      </div>
    </div>
  )
}
