import type { IntegrationStatus } from '@ai-assistant/shared'
import { Brain, CalendarDays, CloudSun, Cpu, Mail, Newspaper, Plug, ShieldCheck, Users, Volume2, Wallet, type LucideIcon } from 'lucide-react'
import { useMemo } from 'react'
import { Badge, Button, Panel, type Tone } from '../../../components/ui'
import { useSnap } from '../../../state/store'
import { Tip } from '../../money/components/Tip'
import { useSettingsUi } from '../ui'
import { SectionHeader } from './Atoms'

const KIND_ICON: Record<IntegrationStatus['kind'], LucideIcon> = {
  claude: Cpu,
  calendar: CalendarDays,
  mail: Mail,
  contacts: Users,
  news: Newspaper,
  weather: CloudSun,
  finance: Wallet,
  brain: Brain,
  voice: Volume2,
}

const STATE: Record<IntegrationStatus['state'], { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  mock: { label: 'Mock data', tone: 'info' },
  needs_auth: { label: 'Needs sign-in', tone: 'warn' },
  off: { label: 'Off', tone: 'neutral' },
}

/** Honest reasons the Connect buttons are disabled in the mockup, per integration. */
const WHY: Record<string, string> = {
  'int-cal': 'Needs the Google OAuth desktop flow (loopback redirect with PKCE). Read-only scope first; creating events stays an approval.',
  'int-mail': 'Needs the Google OAuth desktop flow. Read and compose-drafts scopes only; sending stays an approval.',
  'int-contacts': 'Needs the Google OAuth desktop flow with a contacts read scope.',
  'int-atlas': "A read-only adapter will read Atlas's local database or export. No money movement is possible in v0.x.",
  'int-sb': 'Federation reads your Secondbrain workspace read-only and mirrors notes under secondbrain/. Not built yet.',
  'int-news': 'Feeds are fetched by the daemon and ranked on this PC. The daemon is not built yet.',
  'int-weather': 'The daemon will fetch a forecast for your city. Not built yet.',
  'int-eleven': 'Cloud voice would send each sentence she speaks to the provider. Choose it under Persona when it exists.',
}

function Row({ i, goClaude, goPersona }: { i: IntegrationStatus; goClaude: () => void; goPersona: () => void }) {
  const Icon = KIND_ICON[i.kind]
  const st = STATE[i.state]
  const live = i.state === 'connected'
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white/6 text-muted">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 basis-[240px]">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13.5px] font-semibold text-fg">{i.name}</h3>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        <p className="mt-0.5 text-[12px] text-muted">{i.detail}</p>
        <p className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-snug text-faint">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-muted">Leaves your PC:</span> {i.dataLeaves}
          </span>
        </p>
      </div>
      {live ? (
        <Button variant="outline" onClick={i.kind === 'voice' ? goPersona : goClaude}>
          Manage
        </Button>
      ) : (
        <Tip focusable align="end" text={WHY[i.id] ?? 'Not available yet in the mockup.'}>
          <Button variant="outline" disabled aria-label={`${i.state === 'off' ? 'Enable' : 'Connect'} ${i.name} (not available yet)`}>
            <Plug className="size-3.5" aria-hidden /> {i.state === 'off' ? 'Enable' : 'Connect'}
          </Button>
        </Tip>
      )}
    </li>
  )
}

/** INTEGRATIONS: what is connected, what is mock, and exactly what leaves the PC through each one. */
export function IntegrationsSection() {
  const list = useSnap((d) => d.settings.integrations)
  const setSection = useSettingsUi((s) => s.setSection)
  const counts = useMemo(() => {
    const c = { connected: 0, mock: 0, needs_auth: 0, off: 0 }
    for (const i of list) c[i.state]++
    return c
  }, [list])

  return (
    <div className="@container flex flex-col gap-3">
      <SectionHeader icon={Plug} title="Integrations">
        Every outside service sits behind a read-first adapter. Until the daemon exists most of them are sample data, and this list says so.
      </SectionHeader>
      <div className="flex flex-wrap items-center gap-2 px-1" aria-label="Integration summary">
        <Badge tone="ok">{counts.connected} connected</Badge>
        <Badge tone="info">{counts.mock} mock data</Badge>
        <Badge tone="warn">{counts.needs_auth} needs sign-in</Badge>
        <Badge>{counts.off} off</Badge>
      </div>
      <Panel flush>
        <ul className="divide-y divide-line">
          {list.map((i) => (
            <Row key={i.id} i={i} goClaude={() => setSection('claude')} goPersona={() => setSection('persona')} />
          ))}
        </ul>
      </Panel>
    </div>
  )
}
