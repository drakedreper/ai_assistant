/**
 * Small deterministic force-directed layout for the vault graph. Seeded, fixed number of iterations, no dependencies.
 * Forces: pairwise repulsion, springs along links, a weak pull to the centre, a pull toward the layer's cluster, and
 * collision avoidance so nodes never overlap.
 */

export interface LayoutNode {
  id: string
  /** Cluster key (layer). */
  group: string
  /** Visual radius, used for collisions. */
  r: number
}

export interface Placed {
  x: number
  y: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function layoutGraph(nodes: LayoutNode[], edges: Array<[string, string]>, opts: { seed?: number; iterations?: number } = {}): Map<string, Placed> {
  const iterations = opts.iterations ?? 360
  const rand = mulberry32(opts.seed ?? 20261031)
  const order = [...nodes].sort((a, b) => a.id.localeCompare(b.id))
  const n = order.length
  const idx = new Map(order.map((nd, i) => [nd.id, i]))
  const groups = [...new Set(order.map((nd) => nd.group))].sort()

  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const vx = new Float64Array(n)
  const vy = new Float64Array(n)

  // Start each cluster on its own spoke so the picture is stable and readable from the first frame.
  order.forEach((nd, i) => {
    const gi = groups.indexOf(nd.group)
    const ang = (gi / groups.length) * Math.PI * 2 + rand() * 0.9 - 0.45
    const rad = 190 + rand() * 120
    x[i] = Math.cos(ang) * rad
    y[i] = Math.sin(ang) * rad * 0.72
  })

  const links: Array<[number, number]> = []
  for (const [a, b] of edges) {
    const i = idx.get(a)
    const j = idx.get(b)
    if (i !== undefined && j !== undefined && i !== j) links.push([i, j])
  }
  const deg = new Int32Array(n)
  for (const [i, j] of links) {
    deg[i] = (deg[i] ?? 0) + 1
    deg[j] = (deg[j] ?? 0) + 1
  }

  for (let it = 0; it < iterations; it++) {
    const alpha = Math.pow(1 - it / iterations, 1.6) * 0.95 + 0.03
    const fx = new Float64Array(n)
    const fy = new Float64Array(n)

    // repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = (x[i] ?? 0) - (x[j] ?? 0)
        let dy = (y[i] ?? 0) - (y[j] ?? 0)
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = rand() - 0.5
          dy = rand() - 0.5
          d2 = dx * dx + dy * dy + 0.01
        }
        const d = Math.sqrt(d2)
        const f = 8200 / d2
        const ux = dx / d
        const uy = dy / d
        fx[i] = (fx[i] ?? 0) + ux * f
        fy[i] = (fy[i] ?? 0) + uy * f
        fx[j] = (fx[j] ?? 0) - ux * f
        fy[j] = (fy[j] ?? 0) - uy * f
      }
    }

    // springs: hubs get slightly longer rest lengths so they do not collapse into a ball
    for (const [i, j] of links) {
      const dx = (x[j] ?? 0) - (x[i] ?? 0)
      const dy = (y[j] ?? 0) - (y[i] ?? 0)
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const rest = 70 + Math.min(46, Math.sqrt(((deg[i] ?? 1) + (deg[j] ?? 1)) * 6))
      const f = 0.04 * (d - rest)
      const ux = dx / d
      const uy = dy / d
      fx[i] = (fx[i] ?? 0) + ux * f
      fy[i] = (fy[i] ?? 0) + uy * f
      fx[j] = (fx[j] ?? 0) - ux * f
      fy[j] = (fy[j] ?? 0) - uy * f
    }

    // cluster centroids
    const cx = new Map<string, [number, number, number]>()
    for (let i = 0; i < n; i++) {
      const g = order[i]?.group ?? ''
      const c = cx.get(g) ?? [0, 0, 0]
      c[0] += x[i] ?? 0
      c[1] += y[i] ?? 0
      c[2] += 1
      cx.set(g, c)
    }

    for (let i = 0; i < n; i++) {
      const c = cx.get(order[i]?.group ?? '')
      if (c && c[2] > 1) {
        fx[i] = (fx[i] ?? 0) + (c[0] / c[2] - (x[i] ?? 0)) * 0.03
        fy[i] = (fy[i] ?? 0) + (c[1] / c[2] - (y[i] ?? 0)) * 0.03
      }
      // gravity, stronger for loose notes so orphans stay in frame
      const g = (deg[i] ?? 0) === 0 ? 0.03 : 0.008
      fx[i] = (fx[i] ?? 0) - (x[i] ?? 0) * g
      fy[i] = (fy[i] ?? 0) - (y[i] ?? 0) * g
    }

    for (let i = 0; i < n; i++) {
      vx[i] = ((vx[i] ?? 0) + (fx[i] ?? 0) * alpha) * 0.58
      vy[i] = ((vy[i] ?? 0) + (fy[i] ?? 0) * alpha) * 0.58
      const sp = Math.hypot(vx[i] ?? 0, vy[i] ?? 0)
      const cap = 28
      if (sp > cap) {
        vx[i] = ((vx[i] ?? 0) / sp) * cap
        vy[i] = ((vy[i] ?? 0) / sp) * cap
      }
      x[i] = (x[i] ?? 0) + (vx[i] ?? 0)
      y[i] = (y[i] ?? 0) + (vy[i] ?? 0)
    }

    // collisions
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = (x[j] ?? 0) - (x[i] ?? 0)
          const dy = (y[j] ?? 0) - (y[i] ?? 0)
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01
          const min = (order[i]?.r ?? 8) + (order[j]?.r ?? 8) + 9
          if (d < min) {
            const push = ((min - d) / d) * 0.5
            x[i] = (x[i] ?? 0) - dx * push
            y[i] = (y[i] ?? 0) - dy * push
            x[j] = (x[j] ?? 0) + dx * push
            y[j] = (y[j] ?? 0) + dy * push
          }
        }
      }
    }
  }

  const out = new Map<string, Placed>()
  order.forEach((nd, i) => out.set(nd.id, { x: x[i] ?? 0, y: y[i] ?? 0 }))
  return out
}

/** Scale and centre raw layout coordinates into a width x height box with padding (uniform scale). */
export function fitToBox(pos: Map<string, Placed>, width: number, height: number, pad: number): Map<string, Placed> {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const sx0 = (width - pad * 2) / bw
  const sy0 = (height - pad * 2) / bh
  // Mostly uniform, but allow a gentle stretch so a wide window is used instead of leaving empty margins.
  const sx = Math.min(sx0, sy0 * 1.7)
  const sy = Math.min(sy0, sx0 * 1.7)
  const ox = (width - bw * sx) / 2 - minX * sx
  const oy = (height - bh * sy) / 2 - minY * sy
  const out = new Map<string, Placed>()
  for (const [id, p] of pos) out.set(id, { x: p.x * sx + ox, y: p.y * sy + oy })
  return out
}
