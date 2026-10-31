import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

type Variant = 'primary' | 'ghost' | 'outline' | 'danger' | 'ok'
type Size = 'xs' | 'sm' | 'md'

const V: Record<Variant, string> = {
  primary: 'bg-mira text-canvas hover:brightness-110 font-semibold',
  ok: 'bg-ok/15 text-ok border border-ok/35 hover:bg-ok/25',
  danger: 'bg-bad/12 text-bad border border-bad/30 hover:bg-bad/22',
  outline: 'border border-line-strong text-fg hover:bg-white/6',
  ghost: 'text-muted hover:text-fg hover:bg-white/6',
}
const S: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export function Button({ variant = 'outline', size = 'sm', className, type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center font-medium transition select-none disabled:cursor-not-allowed disabled:opacity-45',
        V[variant],
        S[size],
        className,
      )}
      {...rest}
    />
  )
}

/** Square icon-only button. Always pass an aria-label. */
export function IconButton({ className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'grid size-8 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-white/8 hover:text-fg disabled:opacity-40',
        active && 'bg-white/10 text-fg',
        className,
      )}
      {...rest}
    />
  )
}
