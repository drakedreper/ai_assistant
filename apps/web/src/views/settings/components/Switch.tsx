import { Lock } from 'lucide-react'
import { cn } from '../../../lib/cn'

/** Accessible on/off switch. Always give it a `label` for screen readers (it is not rendered). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-mira/50 bg-mira/80' : 'border-line-strong bg-white/10',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full bg-fg shadow transition-[left] duration-150', checked ? 'left-[19px]' : 'left-[3px]')}
      />
    </button>
  )
}

/** Ask / Auto switch for a trust rule. A locked rule shows a lock and cannot change. */
export function ModeSwitch({
  mode,
  onChange,
  label,
  locked,
}: {
  mode: 'ask' | 'auto'
  onChange: (next: 'ask' | 'auto') => void
  label: string
  locked?: boolean
}) {
  const auto = mode === 'auto'
  return (
    <div className="inline-flex items-center gap-2 text-[12px]">
      <span className={cn('w-7 text-right', !auto ? 'font-semibold text-fg' : 'text-faint')}>Ask</span>
      <Switch checked={auto} onChange={(v) => onChange(v ? 'auto' : 'ask')} label={label} disabled={locked} />
      <span className={cn('w-8', auto ? 'font-semibold text-fg' : 'text-faint')}>Auto</span>
      {locked && <Lock className="size-3.5 text-faint" aria-label="Locked" />}
    </div>
  )
}
