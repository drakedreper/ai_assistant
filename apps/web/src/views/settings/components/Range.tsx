import { useId } from 'react'

/** Injected once by the Persona section: native range inputs styled to the theme (WebKit and Firefox). */
export function RangeStyles() {
  return (
    <style>{`
      .vibe-range { -webkit-appearance: none; appearance: none; width: 100%; height: 20px; background: transparent; cursor: pointer; margin: 0; }
      .vibe-range::-webkit-slider-runnable-track { height: 6px; border-radius: 999px;
        background: linear-gradient(to right, var(--color-mira) var(--pct), rgb(255 255 255 / 0.1) var(--pct)); }
      .vibe-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 16px; height: 16px; margin-top: -5px; border-radius: 999px;
        background: var(--color-fg); border: 2px solid var(--color-mira); box-shadow: 0 1px 6px rgb(0 0 0 / 0.5); transition: transform .12s; }
      .vibe-range:hover::-webkit-slider-thumb { transform: scale(1.12); }
      .vibe-range::-moz-range-track { height: 6px; border-radius: 999px; background: rgb(255 255 255 / 0.1); }
      .vibe-range::-moz-range-progress { height: 6px; border-radius: 999px; background: var(--color-mira); }
      .vibe-range::-moz-range-thumb { width: 12px; height: 12px; border-radius: 999px; background: var(--color-fg); border: 2px solid var(--color-mira); }
      .vibe-range:focus-visible { outline: 2px solid var(--color-mira); outline-offset: 4px; border-radius: 999px; }
    `}</style>
  )
}

/** One vibe slider: label and value above, the two ends named below. */
export function VibeSlider({
  label,
  low,
  high,
  value,
  onChange,
  hint,
}: {
  label: string
  low: string
  high: string
  value: number
  onChange: (v: number) => void
  hint: string
}) {
  const id = useId()
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-medium text-fg">
          {label}
        </label>
        <output htmlFor={id} className="text-[12px] text-muted tabular-nums">
          {value}
        </output>
      </div>
      <p className="text-[11px] text-faint">{hint}</p>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="vibe-range mt-1.5"
        style={{ ['--pct' as string]: `${value}%` }}
        aria-valuetext={`${value} of 100, between ${low} and ${high}`}
      />
      <div className="flex justify-between text-[11px] text-faint">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  )
}
