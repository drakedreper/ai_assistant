/**
 * Scrolls `el` into view inside `container` only. Element.scrollIntoView() would also scroll every ancestor (the
 * stage itself), which makes the whole screen jump by a few pixels.
 */
export function scrollWithin(container: Element | null | undefined, el: Element | null | undefined, opts: { center?: boolean; smooth?: boolean } = {}): void {
  if (!container || !el) return
  const c = container.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  const pad = 10
  let delta = 0
  if (opts.center) delta = r.top - c.top - (c.height - r.height) / 2
  else if (r.top < c.top + pad) delta = r.top - c.top - pad
  else if (r.bottom > c.bottom - pad) delta = r.bottom - c.bottom + pad
  if (Math.abs(delta) < 1) return
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  container.scrollTo({ top: container.scrollTop + delta, behavior: opts.smooth && !calm ? 'smooth' : 'auto' })
}
