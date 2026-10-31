import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { mulberry32, PAL } from './constants'

type Ctx = CanvasRenderingContext2D
export type Draw = (ctx: Ctx, w: number, h: number) => void

/**
 * A CanvasTexture that redraws whenever `deps` change and is disposed on unmount. Everything in the
 * Room is procedural: no image files, no network.
 */
export function useCanvasTexture(w: number, h: number, draw: Draw, deps: ReadonlyArray<unknown>): THREE.CanvasTexture {
  const tex = useMemo(() => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    return t
  }, [w, h])
  useEffect(() => {
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)
    draw(ctx, w, h)
    tex.needsUpdate = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tex, ...deps])
  useEffect(() => () => tex.dispose(), [tex])
  return tex
}

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export const drawFloor: Draw = (ctx, w, h) => {
  const rnd = mulberry32(7)
  const planks = 9
  const ph = h / planks
  for (let i = 0; i < planks; i++) {
    const l = 38 + rnd() * 7
    ctx.fillStyle = `hsl(${352 + rnd() * 10} ${28 + rnd() * 6}% ${l}%)`
    ctx.fillRect(0, i * ph, w, ph)
    // butt joints
    let x = rnd() * 120
    while (x < w) {
      ctx.fillStyle = 'rgba(30,12,28,0.35)'
      ctx.fillRect(x, i * ph, 2, ph)
      x += 160 + rnd() * 140
    }
    // grain
    for (let k = 0; k < 5; k++) {
      ctx.fillStyle = `rgba(255,220,220,${0.03 + rnd() * 0.04})`
      ctx.fillRect(rnd() * w, i * ph + rnd() * ph, 60 + rnd() * 120, 1.5)
    }
    ctx.fillStyle = 'rgba(25,10,24,0.5)'
    ctx.fillRect(0, i * ph, w, 2)
  }
}

export const drawWall = (tone: 'back' | 'left'): Draw => (ctx, w, h) => {
  ctx.fillStyle = tone === 'back' ? PAL.wallBack : PAL.wallLeft
  ctx.fillRect(0, 0, w, h)
  const stripe = w / 22
  for (let i = 0; i < 22; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)'
    ctx.fillRect(i * stripe, 0, stripe, h)
  }
  // soft top shade and a wainscot band near the floor
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgba(8,6,30,0.38)')
  g.addColorStop(0.35, 'rgba(8,6,30,0)')
  g.addColorStop(1, 'rgba(8,6,30,0.12)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const wy = h * 0.8
  ctx.fillStyle = 'rgba(0,0,0,0.16)'
  ctx.fillRect(0, wy, w, h - wy)
  ctx.fillStyle = 'rgba(255,255,255,0.1)'
  ctx.fillRect(0, wy, w, 2)
}

export const drawRug: Draw = (ctx, w, h) => {
  const cx = w / 2
  const cy = h / 2
  const rings: Array<[number, string]> = [
    [0.5, '#d86a95'],
    [0.46, '#f6d7e3'],
    [0.42, '#7e5bd0'],
    [0.3, '#9d7df0'],
    [0.26, '#f6d7e3'],
    [0.2, '#f08cae'],
    [0.08, '#fbbf24'],
  ]
  for (const [r, c] of rings) {
    ctx.fillStyle = c
    ctx.beginPath()
    ctx.arc(cx, cy, r * w, 0, Math.PI * 2)
    ctx.fill()
  }
  // stitched dots on the outer band
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(cx + Math.cos(a) * w * 0.44, cy + Math.sin(a) * w * 0.44, 2, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** The view through the window: sky, a low skyline, stars at night. */
export const drawSky = (night: boolean): Draw => (ctx, w, h) => {
  const rnd = mulberry32(night ? 11 : 5)
  const g = ctx.createLinearGradient(0, 0, 0, h)
  if (night) {
    g.addColorStop(0, '#080b27')
    g.addColorStop(0.6, '#1b1a52')
    g.addColorStop(1, '#3a2a6b')
  } else {
    g.addColorStop(0, '#79b6ff')
    g.addColorStop(0.65, '#bcdcff')
    g.addColorStop(1, '#ffe6d0')
  }
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  if (night) {
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.65})`
      const s = rnd() < 0.15 ? 2.2 : 1.2
      ctx.fillRect(rnd() * w, rnd() * h * 0.7, s, s)
    }
    // crescent moon
    ctx.fillStyle = '#fff6d6'
    ctx.beginPath()
    ctx.arc(w * 0.74, h * 0.2, w * 0.07, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#0d1033'
    ctx.beginPath()
    ctx.arc(w * 0.77, h * 0.18, w * 0.065, 0, Math.PI * 2)
    ctx.fill()
  } else {
    const sun = ctx.createRadialGradient(w * 0.75, h * 0.18, 4, w * 0.75, h * 0.18, w * 0.32)
    sun.addColorStop(0, 'rgba(255,248,214,0.95)')
    sun.addColorStop(1, 'rgba(255,248,214,0)')
    ctx.fillStyle = sun
    ctx.fillRect(0, 0, w, h)
  }
  // skyline: two layers of rooftops
  for (let layer = 0; layer < 2; layer++) {
    const base = h * (layer ? 0.9 : 0.8)
    ctx.fillStyle = night ? (layer ? '#14122e' : '#221d4d') : layer ? '#7d83b3' : '#a3a9d3'
    let x = -10
    while (x < w) {
      const bw = 26 + rnd() * 40
      const bh = 30 + rnd() * (layer ? 40 : 70)
      ctx.fillRect(x, base - bh, bw, h - base + bh)
      if (night && rnd() < 0.8) {
        for (let k = 0; k < 4; k++) {
          if (rnd() < 0.5) {
            ctx.fillStyle = rnd() < 0.5 ? '#ffd27a' : '#ffb86b'
            ctx.fillRect(x + 6 + rnd() * (bw - 14), base - bh + 8 + rnd() * (bh - 14), 4, 5)
          }
        }
        ctx.fillStyle = layer ? '#14122e' : '#221d4d'
      }
      x += bw + 2
    }
  }
}

export const drawBooks: Draw = (ctx, w, h) => {
  const rnd = mulberry32(21)
  ctx.fillStyle = '#17133a'
  ctx.fillRect(0, 0, w, h)
  const rows = 4
  const rowH = h / rows
  const cols = [PAL.violet, PAL.rose, PAL.teal, PAL.gold, PAL.blue, '#e9d5ff', '#c4b5fd', '#f9a8d4', '#5eead4']
  for (let r = 0; r < rows; r++) {
    let x = 6
    const floor = (r + 1) * rowH - 6
    while (x < w - 14) {
      const bw = 10 + rnd() * 16
      const bh = rowH * (0.55 + rnd() * 0.38)
      const c = cols[Math.floor(rnd() * cols.length)] ?? PAL.violet
      if (rnd() < 0.14) {
        x += 10 + rnd() * 18 // gap
        continue
      }
      ctx.fillStyle = c
      ctx.globalAlpha = 0.72 + rnd() * 0.25
      rr(ctx, x, floor - bh, bw, bh, 2)
      ctx.fill()
      ctx.globalAlpha = 0.28
      ctx.fillStyle = '#fff'
      ctx.fillRect(x + 2, floor - bh + 6, bw - 4, 2)
      ctx.fillRect(x + 2, floor - bh + 12, bw - 4, 1)
      ctx.globalAlpha = 1
      x += bw + 1.5
    }
  }
}

export const drawCalendar = (day: number, month: string, count: number): Draw => (ctx, w, h) => {
  ctx.fillStyle = '#fbf2ea'
  rr(ctx, 0, 0, w, h, 14)
  ctx.fill()
  ctx.fillStyle = PAL.rose
  ctx.beginPath()
  ctx.moveTo(0, 14)
  ctx.arcTo(0, 0, 14, 0, 14)
  ctx.lineTo(w - 14, 0)
  ctx.arcTo(w, 0, w, 14, 14)
  ctx.lineTo(w, h * 0.27)
  ctx.lineTo(0, h * 0.27)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = '700 44px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(month, w / 2, h * 0.14)
  ctx.fillStyle = '#2a2350'
  ctx.font = '800 150px system-ui, sans-serif'
  ctx.fillText(String(day), w / 2, h * 0.53)
  // event dots
  const n = Math.min(count, 6)
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = PAL.orange
    ctx.beginPath()
    ctx.arc(w / 2 + (i - (n - 1) / 2) * 26, h * 0.78, 8, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#6b6490'
  ctx.font = '600 28px system-ui, sans-serif'
  ctx.fillText(count === 1 ? '1 event today' : `${count} events today`, w / 2, h * 0.92)
}

export const drawMonitor = (running: number, level: 0 | 1 | 2): Draw => (ctx, w, h) => {
  ctx.fillStyle = '#0b0e22'
  ctx.fillRect(0, 0, w, h)
  const accent = level === 2 ? '#f87171' : level === 1 ? '#fbbf24' : PAL.teal
  const g = ctx.createRadialGradient(w * 0.5, h * 0.4, 10, w * 0.5, h * 0.4, w * 0.7)
  g.addColorStop(0, level ? 'rgba(251,191,36,0.20)' : 'rgba(45,212,191,0.18)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  // faux code lines
  const rnd = mulberry32(3)
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(167,139,250,${0.2 + rnd() * 0.2})`
    ctx.fillRect(28, 28 + i * 18, 60 + rnd() * 200, 6)
  }
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = '800 150px system-ui, sans-serif'
  ctx.fillText(String(running), w / 2, h * 0.44)
  ctx.fillStyle = '#9ca4c9'
  ctx.font = '600 30px system-ui, sans-serif'
  ctx.fillText(running === 1 ? 'Claude session running' : 'Claude sessions running', w / 2, h * 0.7)
  ctx.fillStyle = accent
  rr(ctx, w * 0.22, h * 0.78, w * 0.56, 46, 23)
  ctx.fill()
  ctx.fillStyle = '#0b0e22'
  ctx.font = '700 28px system-ui, sans-serif'
  ctx.fillText(level === 2 ? 'Needs permission' : level === 1 ? 'Waiting for you' : 'All clear', w / 2, h * 0.78 + 24)
}

export const drawZ: Draw = (ctx, w, h) => {
  ctx.font = '800 54px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = 'rgba(167,139,250,0.9)'
  ctx.shadowBlur = 10
  ctx.fillStyle = '#efe7ff'
  ctx.fillText('z', w / 2, h / 2)
}

export const drawPinboard: Draw = (ctx, w, h) => {
  const rnd = mulberry32(9)
  ctx.fillStyle = '#b98a6a'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#a77a5c'
  for (let i = 0; i < 90; i++) ctx.fillRect(rnd() * w, rnd() * h, 2, 2)
  const notes = [PAL.teal, PAL.rose, PAL.gold, PAL.violet, PAL.blue, '#f9fafb']
  for (let i = 0; i < 7; i++) {
    const nx = 14 + (i % 4) * (w / 4.1) + rnd() * 10
    const ny = 14 + Math.floor(i / 4) * (h / 2.1) + rnd() * 10
    ctx.save()
    ctx.translate(nx + 24, ny + 22)
    ctx.rotate((rnd() - 0.5) * 0.25)
    ctx.fillStyle = notes[i % notes.length] ?? PAL.gold
    ctx.fillRect(-24, -22, 48, 44)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(-16, -10, 32, 3)
    ctx.fillRect(-16, 0, 24, 3)
    ctx.fillStyle = '#ef4444'
    ctx.beginPath()
    ctx.arc(0, -18, 3.5, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}
