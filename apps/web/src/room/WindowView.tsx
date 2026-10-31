import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Box, useAtmo } from './primitives'
import { IS_STATIC, mulberry32, prefersReducedMotion } from './constants'
import { drawSky, useCanvasTexture, type Draw } from './textures'

export type Cond = 'clear' | 'cloudy' | 'rain' | 'snow' | 'fog' | 'storm'

const W = 1.0
const H = 1.15
const CX = -0.28
const CY = 1.58
const Z = -1.636

const cloudAmount: Record<Cond, number> = { clear: 0.2, cloudy: 0.85, rain: 1, snow: 0.9, fog: 0.5, storm: 1 }

/** Tileable cloud strip (drawn at +-w too, so scrolling the texture offset loops seamlessly). */
const drawClouds = (cond: Cond, night: boolean): Draw => (ctx, w, h) => {
  const rnd = mulberry32(night ? 4 : 2)
  const n = Math.round(2 + cloudAmount[cond] * 6)
  const dark = cond === 'rain' || cond === 'storm'
  const tone = night ? (dark ? '70,74,120' : '120,126,180') : dark ? '120,128,160' : '255,255,255'
  for (let i = 0; i < n; i++) {
    const cx = (i / n) * w + rnd() * 40
    const cy = 20 + rnd() * h * 0.5
    const s = 36 + rnd() * 40
    for (const off of [-w, 0, w]) {
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = `rgba(${tone},${(night ? 0.55 : 0.85) * (0.65 + rnd() * 0.35)})`
        ctx.beginPath()
        ctx.ellipse(cx + off + (k - 2) * s * 0.55, cy + Math.sin(k * 1.7) * s * 0.18, s * 0.7, s * 0.42, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

/** The glass: sky, clouds, rain/snow, frame, curtains. Everything is cheap planes and one point cloud. */
export function WindowView({ night, cond }: { night: boolean; cond: Cond }) {
  const atmo = useAtmo()
  const skyDay = useCanvasTexture(256, 296, drawSky(false), [])
  const skyNight = useCanvasTexture(256, 296, drawSky(true), [])
  const cloudDay = useCanvasTexture(256, 296, drawClouds(cond, false), [cond])
  const cloudNight = useCanvasTexture(256, 296, drawClouds(cond, true), [cond])
  useMemo(() => {
    for (const t of [cloudDay, cloudNight]) t.wrapS = THREE.RepeatWrapping
  }, [cloudDay, cloudNight])

  const nightSky = useRef<THREE.MeshBasicMaterial>(null)
  const nightCloud = useRef<THREE.MeshBasicMaterial>(null)
  const dayCloud = useRef<THREE.MeshBasicMaterial>(null)
  const flash = useRef<THREE.MeshBasicMaterial>(null)
  const fogMat = useRef<THREE.MeshBasicMaterial>(null)
  const rainGeo = useRef<THREE.BufferGeometry>(null)
  const snowGeo = useRef<THREE.BufferGeometry>(null)
  const reduced = useMemo(() => prefersReducedMotion(), [])

  const N = 46
  const parts = useMemo(() => {
    const rnd = mulberry32(99)
    const base = new Float32Array(N * 3)
    for (let i = 0; i < N; i++) {
      base[i * 3] = (rnd() - 0.5) * W
      base[i * 3 + 1] = (rnd() - 0.5) * H
      base[i * 3 + 2] = rnd() * 0.01
    }
    return {
      base,
      rain: new Float32Array(N * 6),
      snow: new Float32Array(N * 3),
    }
  }, [])
  const flashAt = useRef(4)

  useFrame((_, dt) => {
    const t = atmo.current.t
    const m = atmo.current.night
    const cloudA = Math.min(1, cloudAmount[cond] * 1.1)
    if (nightSky.current) nightSky.current.opacity = m
    if (dayCloud.current) dayCloud.current.opacity = (1 - m) * cloudA
    if (nightCloud.current) nightCloud.current.opacity = m * cloudA
    const drift = reduced || IS_STATIC ? 0 : (t * 0.006) % 1
    cloudDay.offset.x = drift
    cloudNight.offset.x = drift
    if (fogMat.current) fogMat.current.opacity = cond === 'fog' ? 0.5 : 0
    if (flash.current) {
      flashAt.current -= dt
      let v = 0
      if (cond === 'storm' && !IS_STATIC) {
        if (flashAt.current <= 0) flashAt.current = 5 + Math.random() * 5
        else if (flashAt.current < 0.25) v = Math.random() < 0.5 ? 0.55 : 0.1
      }
      flash.current.opacity = v
    }
    const rainy = cond === 'rain' || cond === 'storm'
    if (rainy && rainGeo.current) {
      const pos = rainGeo.current.getAttribute('position') as THREE.BufferAttribute
      const a = parts.rain
      const fall = reduced || IS_STATIC ? 0 : t
      for (let i = 0; i < N; i++) {
        const bx = parts.base[i * 3] ?? 0
        const by = parts.base[i * 3 + 1] ?? 0
        const y = ((((by - fall * (1.1 + (i % 5) * 0.12)) % H) + H) % H) - H / 2
        const x = bx + (y * 0.18)
        a[i * 6] = Math.max(-W / 2, Math.min(W / 2, x))
        a[i * 6 + 1] = y
        a[i * 6 + 2] = 0.002
        a[i * 6 + 3] = Math.max(-W / 2, Math.min(W / 2, x + 0.02))
        a[i * 6 + 4] = y - 0.07
        a[i * 6 + 5] = 0.002
      }
      pos.array.set(a)
      pos.needsUpdate = true
    }
    if (cond === 'snow' && snowGeo.current) {
      const pos = snowGeo.current.getAttribute('position') as THREE.BufferAttribute
      const a = parts.snow
      const fall = reduced || IS_STATIC ? 0 : t
      for (let i = 0; i < N; i++) {
        const bx = parts.base[i * 3] ?? 0
        const by = parts.base[i * 3 + 1] ?? 0
        a[i * 3] = Math.max(-W / 2 + 0.01, Math.min(W / 2 - 0.01, bx + Math.sin(fall * 0.8 + i) * 0.04))
        a[i * 3 + 1] = ((((by - fall * (0.12 + (i % 4) * 0.03)) % H) + H) % H) - H / 2
        a[i * 3 + 2] = 0.002
      }
      pos.array.set(a)
      pos.needsUpdate = true
    }
  })

  const rainy = cond === 'rain' || cond === 'storm'
  return (
    <group>
      {/* the view */}
      <group position={[CX, CY, Z]}>
        <mesh>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial map={skyDay} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, 0.0005]}>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial ref={nightSky} map={skyNight} transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
        <mesh position={[0, 0.12, 0.001]} scale={[1, 0.8, 1]}>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial ref={dayCloud} map={cloudDay} transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
        <mesh position={[0, 0.12, 0.0015]} scale={[1, 0.8, 1]}>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial ref={nightCloud} map={cloudNight} transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
        <mesh position={[0, 0, 0.002]}>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial ref={fogMat} color="#c9cfe6" transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
        <mesh position={[0, 0, 0.0025]}>
          <planeGeometry args={[W, H]} />
          <meshBasicMaterial ref={flash} color="#ffffff" transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
        {rainy && (
          <lineSegments position={[0, 0, 0.003]} frustumCulled={false}>
            <bufferGeometry ref={rainGeo}>
              <bufferAttribute attach="attributes-position" args={[parts.rain, 3]} />
            </bufferGeometry>
            <lineBasicMaterial color={night ? '#9db4ff' : '#dbe8ff'} transparent opacity={0.65} toneMapped={false} />
          </lineSegments>
        )}
        {cond === 'snow' && (
          <points position={[0, 0, 0.003]} frustumCulled={false}>
            <bufferGeometry ref={snowGeo}>
              <bufferAttribute attach="attributes-position" args={[parts.snow, 3]} />
            </bufferGeometry>
            <pointsMaterial color="#ffffff" size={0.028} sizeAttenuation toneMapped={false} />
          </points>
        )}
      </group>

      {/* frame, muntins, sill */}
      <Box p={[CX, CY + H / 2 + 0.03, Z + 0.03]} s={[W + 0.16, 0.07, 0.07]} c="#e9defa" cast={false} />
      <Box p={[CX, CY - H / 2 - 0.03, Z + 0.03]} s={[W + 0.16, 0.07, 0.07]} c="#e9defa" cast={false} />
      <Box p={[CX - W / 2 - 0.04, CY, Z + 0.03]} s={[0.07, H + 0.14, 0.07]} c="#e9defa" cast={false} />
      <Box p={[CX + W / 2 + 0.04, CY, Z + 0.03]} s={[0.07, H + 0.14, 0.07]} c="#e9defa" cast={false} />
      <Box p={[CX, CY, Z + 0.025]} s={[0.035, H, 0.04]} c="#e9defa" cast={false} />
      <Box p={[CX, CY + 0.1, Z + 0.025]} s={[W, 0.035, 0.04]} c="#e9defa" cast={false} />
      <Box p={[CX, CY - H / 2 - 0.08, Z + 0.1]} s={[W + 0.3, 0.05, 0.2]} c="#f2e9fb" />
      {/* curtains */}
      <Box p={[CX - W / 2 - 0.17, CY + 0.02, Z + 0.07]} s={[0.2, H + 0.4, 0.07]} c="#8a6bd8" rough={0.95} />
      <Box p={[CX + W / 2 + 0.17, CY + 0.02, Z + 0.07]} s={[0.2, H + 0.4, 0.07]} c="#8a6bd8" rough={0.95} />
      <Box p={[CX - W / 2 - 0.17, CY + 0.02, Z + 0.11]} s={[0.035, H + 0.4, 0.03]} c="#b79cf5" rough={0.95} cast={false} />
      <Box p={[CX + W / 2 + 0.17, CY + 0.02, Z + 0.11]} s={[0.035, H + 0.4, 0.03]} c="#b79cf5" rough={0.95} cast={false} />
      <Box p={[CX, CY + H / 2 + 0.2, Z + 0.1]} s={[W + 0.62, 0.035, 0.035]} c="#c9b8f2" metal={0.4} cast={false} />
    </group>
  )
}
