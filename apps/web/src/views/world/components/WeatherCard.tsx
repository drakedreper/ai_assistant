import { CloudSun, Droplets, Sunrise, Sunset, Wind } from 'lucide-react'
import { MiraDisc } from '../../../chat/MiraDisc'
import { Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap } from '../../../state/store'
import { CONDITION_LABEL, conditionIcon, deg, weekdayShort } from '../lib'

/** Today's weather, a five-day strip and the attribution Open-Meteo requires. */
export function WeatherCard() {
  const w = useSnap((d) => d.world.weather)
  const Icon = conditionIcon(w.condition, w.isDay)
  const wet = w.condition === 'rain' || w.condition === 'storm'
  const stormSoon = w.daily?.[0]?.condition === 'storm'
  const wear = wet ? 'Take an umbrella.' : w.tempC < 10 ? 'Take a jacket.' : 'No jacket drama.'

  return (
    <Panel title="Weather" subtitle={w.location} icon={CloudSun} area="world">
      <div className="grid gap-x-6 gap-y-4 @4xl/world:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.25fr)]">
        <div className="flex items-center gap-4">
          <span className="grid size-16 shrink-0 place-items-center rounded-2xl bg-world/12 text-world" aria-hidden>
            <Icon className="size-9" strokeWidth={1.6} />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline" aria-label={`${Math.round(w.tempC)} degrees Celsius`}>
              <span className="text-[44px] leading-none font-semibold text-fg tabular-nums">{Math.round(w.tempC)}</span>
              <span className="text-[20px] leading-none text-muted">{'\u00b0C'}</span>
            </div>
            <div className="mt-1 text-[13px] text-muted">
              {CONDITION_LABEL[w.condition]}
              {w.feelsLikeC !== undefined && <span className="text-faint"> · feels like {deg(w.feelsLikeC)}</span>}
            </div>
            <div className="mt-0.5 text-[12px] text-faint tabular-nums">
              High <span className="font-medium text-fg">{deg(w.highC)}</span> · Low <span className="font-medium text-fg">{deg(w.lowC)}</span>
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-2 self-center text-[12px]">
          <Fact icon={<Sunrise className="size-3.5" aria-hidden />} label="Sunrise" value={w.sunrise} />
          <Fact icon={<Sunset className="size-3.5" aria-hidden />} label="Sunset" value={w.sunset} />
          <Fact icon={<Wind className="size-3.5" aria-hidden />} label="Wind" value={w.windKph !== undefined ? `${w.windKph} km/h` : 'n/a'} />
          <Fact icon={<Droplets className="size-3.5" aria-hidden />} label="Chance of rain" value={w.precipPct !== undefined ? `${w.precipPct}%` : 'n/a'} />
        </dl>

        {w.daily && w.daily.length > 0 && (
          <ul className="grid grid-cols-5 gap-1.5 self-center" aria-label="Next days">
            {w.daily.map((d, i) => {
              const DIcon = conditionIcon(d.condition, true)
              return (
                <li
                  key={d.date}
                  className={cn('flex flex-col items-center gap-1 rounded-lg border border-line bg-white/[0.03] px-1 py-1.5 text-[12px]', d.condition === 'storm' && 'border-warn/30')}
                  aria-label={`${weekdayShort(d.date)}: ${CONDITION_LABEL[d.condition]}, high ${deg(d.highC)}, low ${deg(d.lowC)}`}
                >
                  <span className="text-[11px] text-faint">{i === 0 ? 'Tmrw' : weekdayShort(d.date)}</span>
                  <DIcon className={cn('size-4', d.condition === 'storm' ? 'text-warn' : 'text-world')} aria-hidden />
                  <span className="font-medium text-fg tabular-nums">{deg(d.highC)}</span>
                  <span className="text-[11px] text-faint tabular-nums">{deg(d.lowC)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex min-w-[260px] flex-1 items-center gap-2 rounded-xl border border-mira/20 bg-mira/[0.06] px-3 py-2 text-[12px] leading-snug text-fg/90">
          <MiraDisc size={18} />
          <span>
            {wear} The sun sets at {w.sunset}.{stormSoon ? ' A storm is forecast for tomorrow, so plan Thursday travel early.' : ''}
          </span>
        </p>
        <p className="text-[11px] leading-snug text-faint">{w.attribution}</p>
      </div>
    </Panel>
  )
}

function Fact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-white/[0.04] px-2.5 py-1.5">
      <dt className="flex items-center gap-1 text-[11px] text-faint">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate font-medium text-fg tabular-nums">{value}</dd>
    </div>
  )
}
