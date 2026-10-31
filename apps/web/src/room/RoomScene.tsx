import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import * as THREE from 'three'
import type { RoomMode } from '../state/store'
import { isNightNow, useStore } from '../state/store'
import { Character } from './Character'
import { DT_MAX, IS_STATIC, PAL, ROOM, prefersReducedMotion } from './constants'
import { Bed, Bookshelf, Cushion, Desk, FairyLights, FloorLamp, Pinboard, Plant, Rug, SideTable, WallCalendar } from './Furniture'
import { AtmoContext, Box, type Atmosphere } from './primitives'
import { useEffState, useIsNight, useWeather } from './signals'
import { drawFloor, drawWall, useCanvasTexture } from './textures'
import { WindowView } from './WindowView'

const FOV = 30
const TARGET = new THREE.Vector3(0.0, 0.98, -0.1)

/** Camera distance so the whole diorama fits whatever shape the panel is, plus gentle pointer parallax. */
function CameraRig({ mode }: { mode: RoomMode }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const reduced = useMemo(() => prefersReducedMotion(), [])
  const par = useRef({ x: 0, y: 0 })

  // Full mode: the chat overlay covers the bottom, so push the picture up a little.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    if (mode === 'full') cam.setViewOffset(size.width, size.height, 0, size.height * 0.1, size.width, size.height)
    else cam.clearViewOffset()
    cam.updateProjectionMatrix()
  }, [camera, size, mode])

  useFrame((st, dt) => {
    const cam = camera as THREE.PerspectiveCamera
    const aspect = size.width / Math.max(1, size.height)
    const tanH = Math.tan((FOV * Math.PI) / 360)
    // half extents the diorama needs on screen (tuned by eye); narrow panels crop a little instead of shrinking her
    const wide = aspect > 1.45
    const needH = mode === 'mini' ? 2.2 : mode !== 'full' && wide ? 2.18 : 2.3
    const needW = mode === 'mini' ? 2.7 : aspect < 1 ? 2.5 : 2.85
    const d = Math.max(needH / tanH, needW / (aspect * tanH))
    par.current.x = THREE.MathUtils.damp(par.current.x, reduced ? 0 : st.pointer.x, 2.5, dt)
    par.current.y = THREE.MathUtils.damp(par.current.y, reduced ? 0 : st.pointer.y, 2.5, dt)
    const az = 0.56 + par.current.x * 0.07
    const el = 0.4 + par.current.y * 0.03
    const ce = Math.cos(el)
    cam.position.set(TARGET.x + d * Math.sin(az) * ce, TARGET.y + d * Math.sin(el), TARGET.z + d * Math.cos(az) * ce)
    cam.lookAt(TARGET)
  })
  return null
}

const cDaySky = new THREE.Color('#cfe0ff')
const cNightSky = new THREE.Color('#5a5fb8')
const cDayGround = new THREE.Color('#ffd9c0')
const cNightGround = new THREE.Color('#3a2a5e')
const cSun = new THREE.Color('#fff0d6')
const cMoon = new THREE.Color('#9db4ff')

/** Day/night and sleep dimming, smoothed. Writes the shared Atmosphere other props read. */
function Lighting({ atmo }: { atmo: MutableRefObject<Atmosphere> }) {
  const hemi = useRef<THREE.HemisphereLight>(null)
  const sun = useRef<THREE.DirectionalLight>(null)
  const fill = useRef<THREE.DirectionalLight>(null)
  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, DT_MAX)
    const s = useStore.getState()
    const target = isNightNow(s)
    const a = atmo.current
    a.t += dt
    a.night = THREE.MathUtils.damp(a.night, target ? 1 : 0, 3, dt)
    const sleeping = s.asleep && s.assistantState === 'idle'
    a.dim = THREE.MathUtils.damp(a.dim, sleeping ? 1 : 0, 2.5, dt)
    const m = a.night
    const k = 1 - a.dim * 0.4
    if (hemi.current) {
      hemi.current.intensity = THREE.MathUtils.lerp(1.15, 0.98, m) * k
      hemi.current.color.copy(cDaySky).lerp(cNightSky, m)
      hemi.current.groundColor.copy(cDayGround).lerp(cNightGround, m)
    }
    if (sun.current) {
      sun.current.intensity = THREE.MathUtils.lerp(2.4, 1.25, m) * (1 - a.dim * 0.5)
      sun.current.color.copy(cSun).lerp(cMoon, m)
    }
    if (fill.current) fill.current.intensity = THREE.MathUtils.lerp(0.35, 0.22, m) * k
  })
  return (
    <>
      <hemisphereLight ref={hemi} args={['#cfe0ff', '#ffd9c0', 1]} />
      <directionalLight
        ref={sun}
        position={[3.4, 5.4, 4.2]}
        intensity={2}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-3.6}
        shadow-camera-right={3.6}
        shadow-camera-top={3.6}
        shadow-camera-bottom={-3.6}
        shadow-camera-near={1}
        shadow-camera-far={14}
        shadow-bias={-0.0006}
        shadow-normalBias={0.025}
      />
      <directionalLight ref={fill} position={[-3, 2.5, 3]} intensity={0.3} color="#ffd7e6" />
    </>
  )
}

/** Drives a throttled render loop: demand mode + invalidate every ~33 ms, paused while the tab is hidden. */
function Ticker({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    let raf = 0
    let last = 0
    const gap = 1000 / fps - 2
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      if (t - last >= gap) {
        last = t
        invalidate()
      }
    }
    raf = requestAnimationFrame(loop)
    invalidate()
    return () => cancelAnimationFrame(raf)
  }, [invalidate, fps])
  return null
}

function Shell() {
  const floor = useCanvasTexture(1024, 512, drawFloor, [])
  const wallB = useCanvasTexture(512, 320, drawWall('back'), [])
  const wallL = useCanvasTexture(512, 320, drawWall('left'), [])
  useMemo(() => {
    floor.wrapS = floor.wrapT = THREE.RepeatWrapping
  }, [floor])
  const { x0, x1, zBack, zFront, wallH } = ROOM
  const wBack = x1 - x0
  const dFloor = zFront - zBack
  return (
    <group>
      {/* floor slab and top */}
      <Box p={[-0.06, -0.09, -0.12]} s={[4.12, 0.18, 3.28]} c={PAL.slab} cast={false} />
      <mesh position={[0, 0.002, (zFront + zBack) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[wBack, dFloor]} />
        <meshStandardMaterial map={floor} roughness={0.85} />
      </mesh>
      {/* warm rim on the front edge so the cut-away reads as a diorama */}
      <Box p={[0, -0.01, zFront + 0.01]} s={[wBack, 0.03, 0.02]} c="#a77d6a" cast={false} />
      {/* back wall */}
      <Box p={[-0.06, wallH / 2, -1.7]} s={[4.12, wallH, 0.12]} c={PAL.trim} cast={false} />
      <mesh position={[0, wallH / 2, zBack + 0.0005]} receiveShadow>
        <planeGeometry args={[wBack, wallH]} />
        <meshStandardMaterial map={wallB} roughness={0.95} />
      </mesh>
      {/* left wall */}
      <Box p={[-2.06, wallH / 2, -0.12]} s={[0.12, wallH, 3.28]} c={PAL.trim} cast={false} />
      <mesh position={[x0 + 0.0005, wallH / 2, (zFront + zBack) / 2]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[dFloor, wallH]} />
        <meshStandardMaterial map={wallL} roughness={0.95} />
      </mesh>
      {/* baseboards and crown */}
      <Box p={[0, 0.06, zBack + 0.02]} s={[wBack, 0.12, 0.04]} c="#e9defa" cast={false} />
      <Box p={[x0 + 0.02, 0.06, (zFront + zBack) / 2]} s={[0.04, 0.12, dFloor]} c="#e9defa" cast={false} />
      <Box p={[-0.06, wallH + 0.025, -1.7]} s={[4.16, 0.05, 0.16]} c="#4a3f9a" cast={false} />
      <Box p={[-2.06, wallH + 0.025, -0.12]} s={[0.16, 0.05, 3.32]} c="#4a3f9a" cast={false} />
    </group>
  )
}

export function RoomScene({ mode }: { mode: RoomMode }) {
  const atmoRef = useRef<Atmosphere>({ night: 0, dim: 0, t: 0 })
  const night = useIsNight()
  const state = useEffState()
  const cond = useWeather()
  const emotion = useStore((s) => s.emotion)
  const intensity = useStore((s) => s.emotionIntensity)
  const lookAt = useStore((s) => s.lookAt)
  const speaking = state === 'speaking'
  const fps = IS_STATIC ? 20 : mode === 'mini' ? 24 : 30

  // start the atmosphere at the right value so there is no fade on mount
  useMemo(() => {
    atmoRef.current.night = night ? 1 : 0
    atmoRef.current.dim = state === 'sleeping' ? 1 : 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AtmoContext.Provider value={atmoRef}>
      <Ticker fps={fps} />
      <CameraRig mode={mode} />
      <Lighting atmo={atmoRef} />
      <Shell />
      <WindowView night={night} cond={cond} />
      <Rug />
      <Bookshelf />
      <Desk working={state === 'working'} />
      <Bed />
      <SideTable />
      <WallCalendar />
      <Pinboard />
      <Plant />
      <FloorLamp />
      <Cushion />
      <FairyLights />
      <Character state={state} emotion={emotion} intensity={intensity} speaking={speaking} lookAt={lookAt} />
    </AtmoContext.Provider>
  )
}
