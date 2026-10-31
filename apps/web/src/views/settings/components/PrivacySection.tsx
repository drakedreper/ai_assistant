import { Camera, Check, Cloud, EyeOff, HardDrive, Lock, ShieldCheck, Users, X } from 'lucide-react'
import { api } from '../../../api'
import { Badge, Panel, type Tone } from '../../../components/ui'
import { useSnap } from '../../../state/store'
import { Callout, SectionHeader, SettingRow } from './Atoms'
import { Switch } from './Switch'

const SENS: Record<string, { label: string; tone: Tone }> = {
  normal: { label: 'Normal', tone: 'neutral' },
  private: { label: 'Private', tone: 'warn' },
  sensitive: { label: 'Sensitive', tone: 'bad' },
}

function Guards() {
  const guest = useSnap((d) => d.settings.guestMode)
  const webcam = useSnap((d) => d.settings.webcam.enabled)
  return (
    <div className="grid gap-3 @3xl:grid-cols-2">
      <Panel title="Guest mode" subtitle="For when someone else is looking at your screen" icon={Users} area="life">
        <SettingRow
          className="py-0"
          label={guest ? 'On: private content is blurred' : 'Off'}
          hint="Blurs email snippets, finance amounts and intimate memories on screen. Chat and notes stay readable. Nothing is hidden from Mira."
        >
          <Switch checked={guest} onChange={(v) => void api.setGuestMode(v)} label="Guest mode" />
        </SettingRow>
        <div className="mt-3 rounded-lg border border-line bg-black/20 px-3 py-2 text-[12px] text-muted">
          <span className="text-[11px] tracking-wide text-faint uppercase">Preview </span>
          <span data-sensitive className="font-medium text-fg tabular-nums">
            Everyday checking: $3,846.20
          </span>
        </div>
      </Panel>

      <Panel title="Webcam" subtitle="Off by default" icon={Camera} area="work">
        <SettingRow
          className="py-0"
          label={webcam ? 'On: the camera is available to her' : 'Off'}
          hint='Nothing is stored, ever. Frames go to Claude only when you press "look at this". While it is on, the top bar shows a Camera on chip.'
        >
          <Switch checked={webcam} onChange={(v) => void api.setWebcam(v)} label="Webcam" />
        </SettingRow>
        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted">
          <Lock className="size-3.5 text-faint" aria-hidden /> Retention: none. Frames live in memory for one request.
        </p>
      </Panel>
    </div>
  )
}

/** PRIVACY: guest mode, webcam, and the full data-flow table with a plain summary of what leaves the PC. */
export function PrivacySection() {
  const flows = useSnap((d) => d.settings.privacy)
  const leaves = flows.filter((f) => f.leavesPc)
  const stays = flows.filter((f) => !f.leavesPc)

  return (
    <div className="@container flex flex-col gap-3">
      <SectionHeader icon={ShieldCheck} title="Privacy">
        Everything lives on this PC. This is the complete list of what can leave it, and the switches that keep other people from seeing it.
      </SectionHeader>

      <Guards />

      <Panel title="What leaves your PC" subtitle="A summary of the table below" icon={Cloud}>
        <div className="grid gap-3 @2xl:grid-cols-2">
          <div className="rounded-xl border border-warn/25 bg-warn/[0.06] p-3">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Cloud className="size-4 text-warn" aria-hidden /> Can reach Anthropic, only as needed
            </h3>
            <p className="mt-1 text-[12px] leading-snug text-muted">Short excerpts that she retrieves for a question, never whole folders.</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {leaves.map((f) => (
                <li key={f.id}>
                  <Badge tone={SENS[f.sensitivity]?.tone ?? 'neutral'}>{f.source}</Badge>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-ok/25 bg-ok/[0.06] p-3">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <HardDrive className="size-4 text-ok" aria-hidden /> Never leaves this PC
            </h3>
            <p className="mt-1 text-[12px] leading-snug text-muted">Your vault files, raw transactions, audio and anything marked sensitive stay local.</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {stays.map((f) => (
                <li key={f.id}>
                  <Badge tone="ok">{f.source}</Badge>
                </li>
              ))}
              <li>
                <Badge tone="ok">Raw transactions</Badge>
              </li>
              <li>
                <Badge tone="ok">Vault files</Badge>
              </li>
            </ul>
          </div>
        </div>
      </Panel>

      <Panel title="Data flows" subtitle={`${flows.length} sources, each with a sensitivity label and a policy`} icon={ShieldCheck} flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <caption className="sr-only">Data flows by source</caption>
            <thead className="border-b border-line text-[11px] tracking-wide text-faint uppercase">
              <tr>
                <th scope="col" className="px-4 py-1.5 font-medium">Source</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Sensitivity</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Leaves PC?</th>
                <th scope="col" className="px-4 py-1.5 font-medium">Policy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {flows.map((f) => {
                const s = SENS[f.sensitivity]
                return (
                  <tr key={f.id} className="align-top">
                    <td className="px-4 py-2.5 text-[13px] font-medium whitespace-nowrap text-fg">{f.source}</td>
                    <td className="px-2 py-2.5">
                      <Badge tone={s?.tone ?? 'neutral'}>{s?.label ?? f.sensitivity}</Badge>
                    </td>
                    <td className="px-2 py-2.5">
                      {f.leavesPc ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-medium text-warn">
                          <Check className="size-3.5" aria-hidden /> Yes, limited
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12px] font-medium text-ok">
                          <X className="size-3.5" aria-hidden /> No
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-[12px] leading-snug text-muted">{f.policy}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Callout tone="info" icon={EyeOff} title="Aggregates by default">
        Finance and the journal are read as totals and short excerpts. Raw rows only appear after you reveal them, and each reveal is written to the audit log.
      </Callout>
    </div>
  )
}
