import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { PAL, SEAT_Y, type V3 } from './constants'
import { Box, Cyl, Hotspot, Sph, useAtmo } from './primitives'
import { useDayNumber, useEventsToday, useMonthLabel, useNeedsLevel, usePendingProposals, useRunning } from './signals'
import { drawBooks, drawCalendar, drawMonitor, drawPinboard, drawRug, useCanvasTexture } from './textures'

// ------------------------------------------------------------------ desk (Work)
export function Desk({ working }: { working: boolean }) {
  const atmo = useAtmo()
  const running = useRunning()
  const level = useNeedsLevel()
  const screenTex = useCanvasTexture(512, 320, drawMonitor(running, level), [running, level])
  const screen = useRef<THREE.MeshBasicMaterial>(null)
  const frame = useRef<THREE.MeshBasicMaterial>(null)
  const light = useRef<THREE.PointLight>(null)
  const col = useMemo(() => new THREE.Color(), [])

  useFrame(() => {
    const t = atmo.current.t
    const flicker = working ? 0.9 + 0.1 * Math.sin(t * 23) * Math.sin(t * 7.3) : 1
    if (screen.current) screen.current.color.setScalar(flicker * (1 - atmo.current.dim * 0.35))
    if (frame.current) {
      if (level === 0) {
        col.set(PAL.teal)
        frame.current.opacity = 0.35
      } else {
        col.set(level === 2 ? '#f87171' : '#fbbf24')
        frame.current.opacity = 0.6 + 0.4 * Math.sin(t * (level === 2 ? 6.5 : 4))
      }
      frame.current.color.copy(col)
    }
    if (light.current) {
      light.current.color.copy(col.set(level === 0 ? PAL.teal : level === 2 ? '#f87171' : '#fbbf24'))
      light.current.intensity = (working ? 1.6 : 0.7) * (1 - atmo.current.dim * 0.6) * (level ? 0.7 + 0.3 * Math.sin(t * 5) : 1)
    }
  })

  return (
    <group>
      {/* desk top and end panels */}
      <Box p={[-1.68, 0.6, -0.16]} s={[0.62, 0.05, 1.56]} c="#c79a78" rough={0.7} />
      <Box p={[-1.68, 0.3, -0.9]} s={[0.54, 0.58, 0.05]} c="#a77d5e" />
      <Box p={[-1.68, 0.3, 0.58]} s={[0.54, 0.58, 0.05]} c="#a77d5e" />
      <Box p={[-1.9, 0.3, -0.16]} s={[0.04, 0.58, 1.4]} c="#8f6a50" cast={false} />
      {/* drawers */}
      <Box p={[-1.52, 0.4, 0.3]} s={[0.04, 0.16, 0.5]} c="#b58b6b" />
      <Box p={[-1.52, 0.2, 0.3]} s={[0.04, 0.16, 0.5]} c="#b58b6b" />
      {/* monitor, angled a little toward the room */}
      <group position={[-1.86, 0.628, -0.16]} rotation={[0, 1.2, 0]}>
        <Box p={[0, 0.02, 0]} s={[0.2, 0.025, 0.14]} c="#252048" />
        <Box p={[0, 0.12, 0]} s={[0.05, 0.22, 0.05]} c="#252048" />
        <Box p={[0, 0.34, 0]} s={[0.66, 0.42, 0.04]} c="#14122e" rough={0.4} />
        <mesh position={[0, 0.34, 0.0215]}>
          <planeGeometry args={[0.62, 0.38]} />
          <meshBasicMaterial ref={frame} color={PAL.teal} transparent opacity={0.35} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0.34, 0.0225]}>
          <planeGeometry args={[0.57, 0.33]} />
          <meshBasicMaterial ref={screen} map={screenTex} toneMapped={false} />
        </mesh>
      </group>
      <pointLight ref={light} position={[-1.4, 0.95, -0.15]} color={PAL.teal} intensity={0.8} distance={2.4} decay={1.6} />
      {/* keyboard, mouse, mug, notebook */}
      <Box p={[-1.55, 0.635, -0.16]} s={[0.15, 0.015, 0.42]} c="#2d2859" rough={0.5} />
      <Box p={[-1.55, 0.646, -0.16]} s={[0.12, 0.006, 0.38]} c="#6f68b0" rough={0.5} cast={false} />
      <Box p={[-1.53, 0.635, 0.16]} s={[0.05, 0.02, 0.07]} c="#2d2859" />
      <Cyl p={[-1.82, 0.68, 0.38]} d={[0.04, 0.035, 0.08]} c="#f5f0ff" seg={10} />
      <Box p={[-1.85, 0.633, -0.62]} s={[0.2, 0.012, 0.15]} c={PAL.rose} />
      {/* stool */}
      <Cyl p={[-1.2, SEAT_Y - 0.025, -0.16]} d={[0.2, 0.2, 0.05]} c={PAL.violet} seg={16} rough={0.7} />
      <Cyl p={[-1.2, SEAT_Y - 0.05, -0.16]} d={[0.19, 0.19, 0.012]} c="#e9defa" seg={16} cast={false} />
      <Cyl p={[-1.2, (SEAT_Y - 0.05) / 2, -0.16]} d={[0.03, 0.03, SEAT_Y - 0.06]} c="#cfc2ee" seg={8} />
      <Cyl p={[-1.2, 0.012, -0.16]} d={[0.17, 0.17, 0.024]} c="#cfc2ee" seg={12} />
      <Hotspot id="work" position={[-1.72, 0.9, -0.16]} size={[0.62, 0.6, 1.36]} />
    </group>
  )
}

// ------------------------------------------------------------------ bookshelf (Brain)
export function Bookshelf() {
  const atmo = useAtmo()
  const pending = usePendingProposals()
  const books = useCanvasTexture(256, 384, drawBooks, [])
  const glow = useRef<THREE.MeshBasicMaterial>(null)
  const frameMats = useRef<Array<THREE.MeshStandardMaterial | null>>([])
  const on = pending > 0

  useFrame(() => {
    const t = atmo.current.t
    const pulse = 0.65 + 0.35 * Math.sin(t * 1.6)
    if (glow.current) glow.current.opacity = on ? 0.18 + 0.2 * pulse : 0
    for (const m of frameMats.current) if (m) m.emissiveIntensity = on ? 0.25 + 0.35 * pulse : 0
  })

  const boardYs = [0.05, 0.52, 0.99, 1.46, 1.93]
  const x0 = -1.95
  const x1 = -0.99
  const cx = (x0 + x1) / 2
  const w = x1 - x0
  return (
    <group>
      <Box p={[cx, 0.99, -1.62]} s={[w, 1.95, 0.03]} c="#2a2060" />
      <mesh position={[cx, 0.99, -1.6]}>
        <planeGeometry args={[w - 0.08, 1.9]} />
        <meshBasicMaterial ref={glow} color={PAL.violet} transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh position={[cx, 1.0, -1.5]}>
        <planeGeometry args={[w - 0.08, 1.84]} />
        <meshStandardMaterial map={books} roughness={0.9} emissive={PAL.violet} emissiveIntensity={0.0} />
      </mesh>
      {[x0 + 0.02, x1 - 0.02].map((x, i) => (
        <mesh key={x} position={[x, 0.99, -1.49]} castShadow receiveShadow>
          <boxGeometry args={[0.045, 1.98, 0.3]} />
          <meshStandardMaterial ref={(m) => { frameMats.current[i] = m }} color="#6d4fb3" roughness={0.7} emissive={PAL.violet} emissiveIntensity={0} />
        </mesh>
      ))}
      {boardYs.map((y, i) => (
        <mesh key={y} position={[cx, y, -1.49]} castShadow receiveShadow>
          <boxGeometry args={[w, 0.04, 0.3]} />
          <meshStandardMaterial ref={(m) => { frameMats.current[2 + i] = m }} color="#6d4fb3" roughness={0.7} emissive={PAL.violet} emissiveIntensity={0} />
        </mesh>
      ))}
      {/* a few leaning books and a tiny cactus on top */}
      <Box p={[-1.33, 2.0, -1.5]} s={[0.22, 0.05, 0.16]} c={PAL.rose} />
      <Box p={[-1.32, 2.045, -1.5]} s={[0.18, 0.04, 0.14]} c={PAL.gold} />
      <Cyl p={[-1.7, 2.0, -1.5]} d={[0.05, 0.04, 0.07]} c="#c2705a" seg={8} />
      <Sph p={[-1.7, 2.07, -1.5]} s={[0.045, 0.06, 0.045]} c="#5fbf8a" seg={8} />
      <Hotspot id="brain" position={[cx, 1.0, -1.48]} size={[w + 0.05, 2.05, 0.4]} />
    </group>
  )
}

// ------------------------------------------------------------------ bed
export function Bed() {
  return (
    <group>
      <Box p={[1.35, 0.15, -1.2]} s={[1.3, 0.18, 0.88]} c="#7a5a86" />
      <Box p={[1.35, 0.3, -1.2]} s={[1.26, 0.14, 0.84]} c="#f2e6f1" rough={0.95} />
      {/* headboard on the wall side (the camera looks from the right, so it never hides her face) */}
      <Box p={[0.69, 0.4, -1.2]} s={[0.06, 0.56, 0.94]} c="#6d4fb3" rough={0.7} />
      <Box p={[0.69, 0.68, -1.2]} s={[0.07, 0.08, 0.98]} c="#8a6bd8" rough={0.7} />
      {/* pillow and folded blanket at the foot */}
      <Box p={[0.93, 0.44, -1.17]} s={[0.34, 0.12, 0.46]} c="#ffe9f1" rough={0.95} />
      <Box p={[1.82, 0.4, -1.2]} s={[0.3, 0.13, 0.82]} c="#8a6bd8" rough={0.95} />
      <Box p={[1.98, 0.4, -1.2]} s={[0.04, 0.14, 0.84]} c={PAL.rose} rough={0.95} />
      {/* legs */}
      {[0.75, 1.95].flatMap((x) => [-1.58, -0.82].map((z) => <Box key={`${x}${z}`} p={[x, 0.03, z]} s={[0.07, 0.07, 0.07]} c="#4a2f6b" cast={false} />))}
    </group>
  )
}

// ------------------------------------------------------------------ side table with the ledger (Money)
export function SideTable() {
  const atmo = useAtmo()
  const ledger = useRef<THREE.MeshStandardMaterial>(null)
  const halo = useRef<THREE.Mesh>(null)
  const lampShade = useRef<THREE.MeshStandardMaterial>(null)
  const lampLight = useRef<THREE.PointLight>(null)
  useFrame(() => {
    const t = atmo.current.t
    if (ledger.current) ledger.current.emissiveIntensity = 0.5 + 0.2 * Math.sin(t * 1.3)
    if (halo.current) (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.08 + 0.06 * Math.sin(t * 1.3)
    // the bedside lamp stays on at night, even when she sleeps, so the bed is always readable
    const lamp = 0.35 + atmo.current.night * 1.1 - atmo.current.dim * 0.3
    if (lampShade.current) lampShade.current.emissiveIntensity = lamp
    if (lampLight.current) lampLight.current.intensity = (0.2 + atmo.current.night * 1.5) * (1 - atmo.current.dim * 0.35)
  })
  return (
    <group>
      <Box p={[0.4, 0.46, -1.4]} s={[0.46, 0.04, 0.4]} c="#c79a78" rough={0.7} />
      <Box p={[0.4, 0.23, -1.4]} s={[0.4, 0.42, 0.34]} c="#a77d5e" />
      <Box p={[0.4, 0.23, -1.22]} s={[0.34, 0.12, 0.02]} c="#8f6a50" cast={false} />
      <Box p={[0.4, 0.34, -1.22]} s={[0.1, 0.02, 0.015]} c={PAL.gold} metal={0.6} cast={false} />
      {/* book stack, the top one is the ledger */}
      <Box p={[0.32, 0.51, -1.38]} s={[0.26, 0.04, 0.19]} c={PAL.rose} />
      <Box p={[0.33, 0.55, -1.38]} s={[0.24, 0.04, 0.18]} c={PAL.teal} />
      {/* soft gold halo: the ledger is Money's beacon */}
      <mesh ref={halo} position={[0.31, 0.62, -1.36]}>
        <sphereGeometry args={[0.16, 10, 8]} />
        <meshBasicMaterial color={PAL.gold} transparent opacity={0.1} blending={2} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh position={[0.31, 0.595, -1.38]} castShadow rotation={[0, 0.12, 0]}>
        <boxGeometry args={[0.22, 0.045, 0.17]} />
        <meshStandardMaterial ref={ledger} color="#c99a2c" roughness={0.45} metalness={0.3} emissive={PAL.gold} emissiveIntensity={0.5} />
      </mesh>
      <Box p={[0.31, 0.62, -1.38]} s={[0.12, 0.004, 0.012]} c="#fff3c4" cast={false} r={[0, 0.12, 0]} />
      {/* small table lamp */}
      <Cyl p={[0.53, 0.515, -1.42]} d={[0.03, 0.04, 0.07]} c="#e9defa" seg={8} />
      <mesh position={[0.53, 0.6, -1.42]} castShadow>
        <cylinderGeometry args={[0.05, 0.08, 0.11, 12, 1, true]} />
        <meshStandardMaterial ref={lampShade} color="#ffd9a8" emissive="#ffb866" emissiveIntensity={0.4} side={2} />
      </mesh>
      <pointLight ref={lampLight} position={[0.55, 0.82, -1.2]} color="#ffb877" intensity={0.5} distance={3.4} decay={1.4} />
      <Hotspot id="money" position={[0.36, 0.52, -1.38]} size={[0.5, 0.4, 0.42]} labelY={0.34} />
    </group>
  )
}

// ------------------------------------------------------------------ wall calendar (Life)
export function WallCalendar() {
  const day = useDayNumber()
  const month = useMonthLabel()
  const count = useEventsToday()
  const tex = useCanvasTexture(256, 320, drawCalendar(day, month, count), [day, month, count])
  return (
    <group position={[1.33, 1.55, -1.625]}>
      <Box p={[0, 0, -0.005]} s={[0.56, 0.7, 0.02]} c="#3f3584" />
      <mesh position={[0, 0, 0.007]}>
        <planeGeometry args={[0.5, 0.625]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      <Box p={[0, 0.36, 0.01]} s={[0.04, 0.04, 0.02]} c={PAL.gold} metal={0.6} />
      <Hotspot id="calendar" position={[0, 0, 0.03]} size={[0.62, 0.76, 0.1]} />
    </group>
  )
}

// ------------------------------------------------------------------ decor
export function Pinboard() {
  const tex = useCanvasTexture(256, 160, drawPinboard, [])
  return (
    <group position={[-1.985, 1.42, -0.16]} rotation={[0, Math.PI / 2, 0]}>
      <Box p={[0, 0, -0.005]} s={[1.1, 0.68, 0.025]} c="#e9defa" />
      <mesh position={[0, 0, 0.01]}>
        <planeGeometry args={[1.02, 0.6]} />
        <meshStandardMaterial map={tex} roughness={0.95} />
      </mesh>
    </group>
  )
}

export function Plant() {
  const atmo = useAtmo()
  const g = useRef<THREE.Group>(null)
  const leaves = useMemo(() => {
    const out: Array<{ rot: V3; h: number; c: string }> = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2
      out.push({ rot: [0.45 + (i % 3) * 0.12, a, 0], h: 0.38 + (i % 3) * 0.1, c: i % 2 ? '#4fb783' : '#3a9a73' })
    }
    return out
  }, [])
  useFrame(() => {
    if (g.current) g.current.rotation.z = Math.sin(atmo.current.t * 0.7) * 0.012
  })
  return (
    <group position={[-0.62, 0, -1.38]}>
      <Cyl p={[0, 0.1, 0]} d={[0.14, 0.1, 0.2]} c="#c2705a" seg={10} />
      <Cyl p={[0, 0.2, 0]} d={[0.13, 0.13, 0.02]} c="#3b2a3a" seg={10} cast={false} />
      <group ref={g} position={[0, 0.2, 0]}>
        {leaves.map((l, i) => (
          <group key={i} rotation={l.rot as V3}>
            <mesh position={[0, l.h / 2, 0]} scale={[0.07, l.h / 2, 0.025]} castShadow>
              <sphereGeometry args={[1, 8, 6]} />
              <meshStandardMaterial color={l.c} roughness={0.7} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  )
}

export function FloorLamp() {
  const atmo = useAtmo()
  const shade = useRef<THREE.MeshStandardMaterial>(null)
  const light = useRef<THREE.PointLight>(null)
  useFrame(() => {
    const a = atmo.current
    const on = (0.3 + a.night * 0.7) * (1 - a.dim * 0.85)
    if (shade.current) shade.current.emissiveIntensity = 0.3 + on * 1.4
    if (light.current) light.current.intensity = on * 3.2
  })
  return (
    <group position={[-1.74, 0, 1.08]}>
      <Cyl p={[0, 0.02, 0]} d={[0.14, 0.15, 0.04]} c="#4a2f6b" seg={14} />
      <Cyl p={[0, 0.7, 0]} d={[0.015, 0.015, 1.4]} c="#cfc2ee" seg={6} metal={0.5} />
      <mesh position={[0, 1.45, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.19, 0.26, 14, 1, true]} />
        <meshStandardMaterial ref={shade} color="#ffdcae" emissive="#ffb35e" emissiveIntensity={0.6} side={2} />
      </mesh>
      <pointLight ref={light} position={[0, 1.4, 0]} color="#ffbd7a" intensity={1} distance={4.4} decay={1.5} />
    </group>
  )
}

export function Rug() {
  const tex = useCanvasTexture(512, 512, drawRug, [])
  return (
    <mesh position={[0.3, 0.006, 0.4]} rotation={[-Math.PI / 2, 0, 0]} scale={[1.15, 0.85, 1]} receiveShadow>
      <circleGeometry args={[1, 40]} />
      <meshStandardMaterial map={tex} roughness={1} />
    </mesh>
  )
}

export function Cushion() {
  return (
    <group position={[-0.5, 0, 1.0]}>
      <Cyl p={[0, 0.07, 0]} d={[0.2, 0.22, 0.14]} c={PAL.rose} seg={14} rough={0.95} />
      <Cyl p={[0, 0.145, 0]} d={[0.12, 0.17, 0.02]} c="#ffb8cf" seg={14} rough={0.95} cast={false} />
    </group>
  )
}

/** Strings of bulbs along the back and left walls. They glow warmer at night and dim when she sleeps. */
export function FairyLights() {
  const atmo = useAtmo()
  const mats = useRef<Array<THREE.MeshStandardMaterial | null>>([])
  const { curves, bulbs } = useMemo(() => {
    const sag = (a: V3, b: V3, drop: number, n: number): { pts: THREE.Vector3[]; pos: V3[] } => {
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 24; i++) {
        const u = i / 24
        pts.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - Math.sin(u * Math.PI) * drop, a[2] + (b[2] - a[2]) * u))
      }
      const pos: V3[] = []
      for (let i = 1; i <= n; i++) {
        const u = i / (n + 1)
        pos.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u - Math.sin(u * Math.PI) * drop - 0.02, a[2] + (b[2] - a[2]) * u])
      }
      return { pts, pos }
    }
    const back = sag([-1.95, 2.4, -1.62], [1.95, 2.4, -1.62], 0.2, 13)
    const left = sag([-1.97, 2.4, -1.6], [-1.97, 2.4, 1.4], 0.16, 9)
    return {
      curves: [new THREE.CatmullRomCurve3(back.pts), new THREE.CatmullRomCurve3(left.pts)],
      bulbs: [...back.pos, ...left.pos],
    }
  }, [])
  const colors = [PAL.rose, PAL.violet, PAL.teal, PAL.gold, PAL.blue]
  useFrame(() => {
    const a = atmo.current
    const level = (0.5 + a.night * 1.4) * (1 - a.dim * 0.65)
    for (let i = 0; i < mats.current.length; i++) {
      const m = mats.current[i]
      if (m) m.emissiveIntensity = level * (0.78 + 0.22 * Math.sin(a.t * 1.7 + i * 1.3))
    }
  })
  return (
    <group>
      {curves.map((c, i) => (
        <mesh key={i}>
          <tubeGeometry args={[c, 28, 0.0045, 4, false]} />
          <meshBasicMaterial color="#2a2358" />
        </mesh>
      ))}
      {bulbs.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.026, 6, 4]} />
          <meshStandardMaterial
            ref={(m) => {
              mats.current[i] = m
            }}
            color="#fff"
            emissive={colors[i % colors.length]}
            emissiveIntensity={1}
          />
        </mesh>
      ))}
    </group>
  )
}
