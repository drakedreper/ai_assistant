import type { AssistantState, Emotion } from '@ai-assistant/shared'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactNode, type Ref } from 'react'
import * as THREE from 'three'
import { DEBUG, DT_MAX, GAZE, HIPS_Y, IS_STATIC, PAL, SEAT_Y, SPOTS, prefersReducedMotion, type LookTarget } from './constants'
import { useCanvasTexture, drawZ } from './textures'

/**
 * Mira, the placeholder avatar: a chibi figure built from primitives and animated procedurally.
 * A VRM model replaces this component later and only needs the same props. Nothing outside this file
 * knows how she is built; the Room only tells her what is going on.
 */
export interface CharacterProps {
  state: AssistantState
  emotion: Emotion
  /** 0..1 strength of the emotion. */
  intensity: number
  /** True while a reply is being spoken (drives the mouth). */
  speaking: boolean
  lookAt: LookTarget
}

type Place = 'rug' | 'desk' | 'bed'

// ---------------------------------------------------------------- temp objects (no allocation per frame)
const tmpV = new THREE.Vector3()
const tmpW = new THREE.Vector3()

const damp = THREE.MathUtils.damp
const lerp = THREE.MathUtils.lerp
const clamp = THREE.MathUtils.clamp

function angleDiff(to: number, from: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

// ---------------------------------------------------------------- pose + expression tables
const POSE_KEYS = ['sit', 'lie', 'lean', 'hRoll', 'hPitch', 'nAx', 'nAz', 'nEl', 'pAx', 'pAz', 'pEl'] as const
type PoseKey = (typeof POSE_KEYS)[number]
type Pose = Record<PoseKey, number>
const newPose = (): Pose => ({ sit: 0, lie: 0, lean: 0, hRoll: 0, hPitch: 0, nAx: 0, nAz: 0.1, nEl: -0.12, pAx: 0, pAz: 0.1, pEl: -0.12 })

const EXPR_KEYS = ['bN', 'bP', 'tilt', 'curve', 'width', 'open', 'eye', 'blush'] as const
type ExprKey = (typeof EXPR_KEYS)[number]
type Expr = Record<ExprKey, number>
const expr = (bN: number, bP: number, tilt: number, curve: number, width: number, open: number, eye: number, blush: number): Expr => ({
  bN, bP, tilt, curve, width, open, eye, blush,
})
// brow raise (far, near), brow tilt (+ inner end down, - inner end up), mouth curve (+ smile), width, open, eye openness, blush
const EMO: Record<Emotion, Expr> = {
  neutral: expr(0, 0, 0, 0.28, 1, 0, 1, 0.12),
  happy: expr(0.5, 0.5, -0.1, 1, 1.25, 0.18, 0.82, 0.5),
  sad: expr(0.1, 0.1, -0.7, -0.75, 0.8, 0, 0.82, 0),
  angry: expr(-0.3, -0.3, 0.8, -0.5, 0.9, 0, 0.85, 0),
  relaxed: expr(0.1, 0.1, 0, 0.6, 1.05, 0, 0.62, 0.3),
  surprised: expr(1, 1, 0, 0, 0.7, 0.62, 1.22, 0.1),
  shy: expr(0.3, 0.3, -0.45, 0.4, 0.75, 0, 0.88, 0.95),
  thinking: expr(0.75, -0.15, 0, 0.05, 0.7, 0, 0.95, 0.1),
}
const newExpr = (): Expr => ({ ...EMO.neutral })
const tgtExpr = newExpr()

// ---------------------------------------------------------------- face helper
const FACE_R = 0.266

/** Place children on the head sphere at yaw `a` / pitch `b` (radians), local +z pointing out. */
function OnHead({ a, b, r = FACE_R, children }: { a: number; b: number; r?: number; children: ReactNode }) {
  const cb = Math.cos(b)
  return (
    <group position={[r * cb * Math.sin(a), r * Math.sin(b), r * cb * Math.cos(a)]} rotation={[-b, a, 0, 'YXZ']}>
      {children}
    </group>
  )
}

const flat = (c: string, extra?: Partial<THREE.MeshBasicMaterialParameters>) => ({ color: c, ...extra })

function Eye({ side, irisRef, groupRef }: { side: 1 | -1; irisRef: Ref<THREE.Group>; groupRef: Ref<THREE.Group> }) {
  return (
    <OnHead a={side * 0.4} b={-0.1}>
      <group ref={groupRef}>
        <mesh scale={[0.074, 0.09, 1]}>
          <circleGeometry args={[1, 20]} />
          <meshBasicMaterial color="#ffffff" />
        </mesh>
        <group ref={irisRef} position={[0, 0, 0.0015]}>
          <mesh scale={[0.058, 0.074, 1]}>
            <circleGeometry args={[1, 20]} />
            <meshBasicMaterial color="#7d5fe0" />
          </mesh>
          <mesh scale={[0.044, 0.034, 1]} position={[0, -0.03, 0.0008]}>
            <circleGeometry args={[1, 16]} />
            <meshBasicMaterial color="#c5b4ff" />
          </mesh>
          <mesh scale={[0.026, 0.036, 1]} position={[0, 0.002, 0.0016]}>
            <circleGeometry args={[1, 14]} />
            <meshBasicMaterial color="#231a40" />
          </mesh>
          <mesh scale={[0.015, 0.015, 1]} position={[0.017, 0.024, 0.0026]}>
            <circleGeometry args={[1, 10]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          <mesh scale={[0.0075, 0.0075, 1]} position={[-0.014, -0.02, 0.0026]}>
            <circleGeometry args={[1, 8]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
        </group>
        {/* upper lash line */}
        <mesh scale={[0.078, 0.095, 1]} position={[0, 0, 0.0038]}>
          <ringGeometry args={[0.9, 1, 20, 1, 0.15, Math.PI - 0.3]} />
          <meshBasicMaterial color="#2a1b3f" side={THREE.DoubleSide} />
        </mesh>
      </group>
    </OnHead>
  )
}

function Hair({ ponyRef, pony2Ref }: { ponyRef: Ref<THREE.Group>; pony2Ref: Ref<THREE.Group> }) {
  const hair = { color: PAL.hair, roughness: 0.7, emissive: PAL.hair, emissiveIntensity: 0.14 } as const
  return (
    <>
      {/* crown */}
      <mesh position={[0, 0.012, -0.01]}>
        <sphereGeometry args={[0.285, 18, 10, 0, Math.PI * 2, 0, 1.2]} />
        <meshStandardMaterial {...hair} side={THREE.DoubleSide} />
      </mesh>
      {/* back of the head */}
      <mesh position={[0, 0.0, -0.025]} rotation={[0, 0, 0]}>
        <sphereGeometry args={[0.283, 18, 12, Math.PI, Math.PI, 0, 2.15]} />
        <meshStandardMaterial {...hair} side={THREE.DoubleSide} />
      </mesh>
      {/* side locks */}
      {([-1, 1] as const).map((s) => (
        <group key={s} position={[s * 0.245, -0.07, 0.05]} rotation={[0, 0, s * -0.1]}>
          <mesh scale={[0.05, 0.17, 0.07]}>
            <sphereGeometry args={[1, 8, 6]} />
            <meshStandardMaterial {...hair} />
          </mesh>
        </group>
      ))}
      {/* bangs */}
      {[
        [-0.17, 0.155, 0.185, 0.07, 0.085, 0.045, 0.5],
        [-0.085, 0.185, 0.21, 0.07, 0.075, 0.04, 0.22],
        [0.0, 0.195, 0.225, 0.065, 0.07, 0.04, 0],
        [0.085, 0.185, 0.21, 0.07, 0.075, 0.04, -0.22],
        [0.17, 0.155, 0.185, 0.07, 0.085, 0.045, -0.5],
      ].map(([x, y, z, sx, sy, sz, rz], i) => (
        <mesh key={i} position={[x as number, y as number, z as number]} rotation={[0.35, 0, rz as number]} scale={[sx as number, sy as number, sz as number]}>
          <sphereGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={i % 2 ? PAL.hairLight : PAL.hair} roughness={0.7} />
        </mesh>
      ))}
      {/* ahoge */}
      <mesh position={[0.02, 0.3, 0.06]} rotation={[0.3, 0, -0.5]} scale={[0.012, 0.07, 0.012]}>
        <sphereGeometry args={[1, 6, 5]} />
        <meshStandardMaterial {...hair} />
      </mesh>
      {/* ponytail */}
      <group position={[0, 0.13, -0.27]}>
        <mesh position={[0, 0, 0.01]} rotation={[0, 0, Math.PI / 2]} scale={[0.5, 1, 1]}>
          <torusGeometry args={[0.035, 0.012, 6, 12]} />
          <meshStandardMaterial color={PAL.rose} roughness={0.5} />
        </mesh>
        <group ref={ponyRef}>
          <mesh position={[0, -0.07, -0.03]} scale={[0.07, 0.12, 0.07]}>
            <sphereGeometry args={[1, 10, 8]} />
            <meshStandardMaterial {...hair} />
          </mesh>
          <group ref={pony2Ref} position={[0, -0.16, -0.04]}>
            <mesh position={[0, -0.09, 0]} scale={[0.06, 0.13, 0.06]}>
              <sphereGeometry args={[1, 10, 8]} />
              <meshStandardMaterial color={PAL.hairLight} roughness={0.7} />
            </mesh>
            <mesh position={[0, -0.22, 0.0]} rotation={[Math.PI, 0, 0]}>
              <coneGeometry args={[0.05, 0.15, 8]} />
              <meshStandardMaterial {...hair} />
            </mesh>
          </group>
        </group>
      </group>
      {/* ribbon on the crown */}
      <group position={[-0.1, 0.25, 0.04]} rotation={[0.2, 0, 0.5]}>
        <mesh position={[-0.035, 0, 0]} rotation={[0, 0, 0.5]} scale={[0.05, 0.028, 0.02]}>
          <sphereGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={PAL.rose} roughness={0.5} emissive={PAL.rose} emissiveIntensity={0.15} />
        </mesh>
        <mesh position={[0.035, 0, 0]} rotation={[0, 0, -0.5]} scale={[0.05, 0.028, 0.02]}>
          <sphereGeometry args={[1, 8, 6]} />
          <meshStandardMaterial color={PAL.rose} roughness={0.5} emissive={PAL.rose} emissiveIntensity={0.15} />
        </mesh>
        <mesh scale={[0.018, 0.018, 0.018]}>
          <sphereGeometry args={[1, 6, 5]} />
          <meshStandardMaterial color="#fff" />
        </mesh>
      </group>
    </>
  )
}

/** A leg: thigh -> knee -> shin -> shoe. Pivot at the hip. */
function Leg({ x, thighRef, kneeRef }: { x: number; thighRef: Ref<THREE.Group>; kneeRef: Ref<THREE.Group> }) {
  return (
    <group ref={thighRef} position={[x, HIPS_Y, 0]}>
      <mesh position={[0, -0.14, 0]} castShadow>
        <cylinderGeometry args={[0.052, 0.046, 0.29, 8]} />
        <meshStandardMaterial color={PAL.skin} roughness={0.8} emissive={PAL.skin} emissiveIntensity={0.16} />
      </mesh>
      <group ref={kneeRef} position={[0, -0.28, 0]}>
        <mesh position={[0, -0.12, 0]} castShadow>
        <cylinderGeometry args={[0.044, 0.04, 0.25, 8]} />
          <meshStandardMaterial color="#fdf4fa" roughness={0.9} />
        </mesh>
        <mesh position={[0, -0.255, 0.03]} castShadow>
          <boxGeometry args={[0.095, 0.06, 0.17]} />
          <meshStandardMaterial color={PAL.shoe} roughness={0.6} />
        </mesh>
      </group>
    </group>
  )
}

/** An arm: shoulder -> upper arm -> elbow -> forearm -> hand. Pivot at the shoulder. */
function Arm({ x, shRef, elRef }: { x: number; shRef: Ref<THREE.Group>; elRef: Ref<THREE.Group> }) {
  return (
    <group ref={shRef} position={[x, 0.27, 0]}>
      <mesh position={[0, -0.1, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.036, 0.21, 8]} />
        <meshStandardMaterial color={PAL.blouse} roughness={0.85} />
      </mesh>
      <group ref={elRef} position={[0, -0.2, 0]}>
        <mesh position={[0, -0.09, 0]} castShadow>
          <cylinderGeometry args={[0.034, 0.03, 0.18, 8]} />
          <meshStandardMaterial color={PAL.skin} roughness={0.8} emissive={PAL.skin} emissiveIntensity={0.16} />
        </mesh>
        <mesh position={[0, -0.2, 0]} castShadow>
          <sphereGeometry args={[0.04, 10, 8]} />
          <meshStandardMaterial color={PAL.skin} roughness={0.8} emissive={PAL.skin} emissiveIntensity={0.16} />
        </mesh>
      </group>
    </group>
  )
}

export function Character(props: CharacterProps) {
  const propsRef = useRef(props)
  propsRef.current = props

  // ---- refs to animated parts
  const root = useRef<THREE.Group>(null)
  const fx = useRef<THREE.Group>(null)
  const body = useRef<THREE.Group>(null)
  const spine = useRef<THREE.Group>(null)
  const torso = useRef<THREE.Group>(null)
  const head = useRef<THREE.Group>(null)
  const thighN = useRef<THREE.Group>(null)
  const thighP = useRef<THREE.Group>(null)
  const kneeN = useRef<THREE.Group>(null)
  const kneeP = useRef<THREE.Group>(null)
  const shN = useRef<THREE.Group>(null)
  const shP = useRef<THREE.Group>(null)
  const elN = useRef<THREE.Group>(null)
  const elP = useRef<THREE.Group>(null)
  const eyeN = useRef<THREE.Group>(null)
  const eyeP = useRef<THREE.Group>(null)
  const irisN = useRef<THREE.Group>(null)
  const irisP = useRef<THREE.Group>(null)
  const browN = useRef<THREE.Mesh>(null)
  const browP = useRef<THREE.Mesh>(null)
  const smile = useRef<THREE.Mesh>(null)
  const mouthOpen = useRef<THREE.Group>(null)
  const blushN = useRef<THREE.MeshBasicMaterial>(null)
  const blushP = useRef<THREE.MeshBasicMaterial>(null)
  const pony = useRef<THREE.Group>(null)
  const pony2 = useRef<THREE.Group>(null)
  const auraRing = useRef<THREE.Mesh>(null)
  const auraRing2 = useRef<THREE.Mesh>(null)
  const auraLight = useRef<THREE.PointLight>(null)
  const dots = useRef<THREE.Group>(null)
  const zs = useRef<THREE.Group>(null)
  const glow = useRef<THREE.MeshBasicMaterial>(null)

  const camera = useThree((s) => s.camera)
  const zTex = useCanvasTexture(64, 64, drawZ, [])
  const reduced = useMemo(() => prefersReducedMotion(), [])

  // ---- animation state, created once
  const A = useRef({
    t: 0,
    init: false,
    base: 'idle' as AssistantState,
    x: SPOTS.rug.x,
    z: SPOTS.rug.z,
    y: 0,
    yaw: 0,
    speed: 0,
    phase: 0,
    env: 0,
    gate: 1,
    gx: 0,
    gy: 0,
    eyeGx: 0,
    eyeGy: 0,
    blinkAt: 2,
    blink: 0,
    glanceAt: 3,
    glance: 0,
    aura: 0,
    dotsA: 0,
    zA: 0,
    pose: newPose(),
    tgt: newPose(),
    ex: newExpr(),
  })

  useEffect(() => {
    if (head.current) head.current.rotation.order = 'YXZ'
  }, [])

  useFrame((st, dtRaw) => {
    const a = A.current
    const dt = Math.min(dtRaw, DT_MAX)
    const motion = reduced ? 0.25 : 1
    a.t += dt
    const t = a.t
    const p = propsRef.current
    const stt = p.state

    // ---------------------------------------------------------- where is she
    if (stt === 'idle' || stt === 'working' || stt === 'sleeping') a.base = stt
    else if (a.base === 'sleeping') a.base = 'idle'
    const place: Place = stt === 'sleeping' ? 'bed' : stt === 'working' ? 'desk' : stt === 'idle' ? 'rug' : a.base === 'working' ? 'desk' : 'rug'
    const spot = SPOTS[place]
    let tx: number = spot.x
    let tz: number = spot.z
    if (place === 'rug' && stt === 'listening') {
      tx += 0.25
      tz += 0.35
    }
    if (!a.init) {
      a.x = tx
      a.z = tz
      a.y = place === 'bed' ? spot.y : 0
      a.yaw = place === 'desk' ? -0.95 : 0.5
    }
    const dx = tx - a.x
    const dz = tz - a.z
    const dist = Math.hypot(dx, dz)
    const speedT = dist > 0.07 ? Math.min(1.3, 0.4 + dist * 1.5) : 0
    a.speed = damp(a.speed, speedT, 5, dt)
    if (dist > 0.0005) {
      const step = Math.min(dist, a.speed * dt)
      a.x += (dx / dist) * step
      a.z += (dz / dist) * step
    }
    if (dist < 0.09) {
      a.x = damp(a.x, tx, 7, dt)
      a.z = damp(a.z, tz, 7, dt)
    }
    const walking = a.speed > 0.2 && dist > 0.1
    const w = clamp(a.speed / 0.9, 0, 1)
    a.phase += a.speed * dt * 7.5

    // facing
    let yawT: number
    const faceCam = Math.atan2(camera.position.x - a.x, camera.position.z - a.z)
    if (walking) yawT = Math.atan2(dx, dz)
    else if (place === 'desk') yawT = stt === 'working' ? -0.95 : faceCam * 0.85
    else if (place === 'bed') yawT = 0
    else yawT = faceCam - 0.05
    a.yaw += angleDiff(yawT, a.yaw) * (1 - Math.exp(-(a.init ? 6 : 100) * dt))

    // ---------------------------------------------------------- pose targets
    const T = a.tgt
    const sitNear = place === 'desk' && dist < 0.16
    const lieNear = place === 'bed' && dist < 0.7
    T.sit = sitNear ? 1 : 0
    T.lie = lieNear ? 1 : 0
    T.lean = 0
    T.hRoll = Math.sin(t * 0.5) * 0.035 * motion
    T.hPitch = 0
    const relaxed = 0.1
    T.nAx = 0.04 + Math.sin(t * 0.9) * 0.02 * motion
    T.pAx = 0.04 + Math.sin(t * 0.9 + 1) * 0.02 * motion
    T.nAz = relaxed
    T.pAz = relaxed
    T.nEl = -0.14
    T.pEl = -0.14

    // chat-driven speaking envelope
    const speakingNow = stt === 'speaking' || p.speaking
    if (speakingNow) {
      const gateTarget = Math.sin(t * 1.9) > -0.55 ? 1 : 0.1
      a.gate = damp(a.gate, gateTarget, 14, dt)
      const raw = (0.5 + 0.5 * Math.sin(t * 11.3)) * (0.55 + 0.45 * Math.sin(t * 6.1 + 1.3)) * a.gate
      a.env = damp(a.env, raw, 18, dt)
    } else {
      a.env = damp(a.env, 0, 10, dt)
      a.gate = 1
    }
    const env = a.env

    switch (stt) {
      case 'listening':
        T.lean = 0.1
        T.hRoll = 0.2
        T.hPitch = 0.04
        T.pAx = -0.78; T.pAz = -0.16; T.pEl = -1.3
        T.nAx = -0.78; T.nAz = -0.16; T.nEl = -1.3
        break
      case 'thinking':
        T.lean = 0.03
        T.hRoll = -0.16 + Math.sin(t * 0.8) * 0.03 * motion
        T.hPitch = -0.06
        T.pAx = -1.36; T.pAz = -0.06; T.pEl = -1.95
        T.nAx = -0.85; T.nAz = -0.22; T.nEl = -1.5
        break
      case 'speaking':
        T.lean = 0.04
        T.hPitch = Math.sin(t * 3.1) * 0.05 * env
        T.hRoll = Math.sin(t * 1.3) * 0.06
        T.pAx = -0.45 - env * 0.55 + Math.sin(t * 2.3) * 0.18 * motion
        T.pEl = -0.85 - env * 0.45
        T.pAz = 0.22 + Math.sin(t * 1.7) * 0.1 * motion
        T.nAx = -0.2 - env * 0.25 + Math.sin(t * 1.9 + 2) * 0.1 * motion
        T.nEl = -0.55 - env * 0.2
        T.nAz = 0.16
        break
      case 'working':
        T.lean = 0.16
        T.hPitch = 0.1
        T.hRoll = 0.03
        T.pAx = -0.95; T.pAz = -0.04; T.pEl = -0.95 + Math.sin(t * 17) * 0.07
        T.nAx = -0.95; T.nAz = -0.04; T.nEl = -0.95 + Math.sin(t * 13 + 1) * 0.07
        break
      case 'sleeping':
        T.hRoll = 0.12
        T.hPitch = 0.05
        T.pAx = -0.5; T.pAz = -0.2; T.pEl = -1.75
        T.nAx = -0.95; T.nAz = -0.2; T.nEl = -1.6
        break
      default:
        break
    }
    // walking swings the arms
    if (walking && stt === 'idle') {
      T.nAx += Math.sin(a.phase) * 0.55 * w
      T.pAx -= Math.sin(a.phase) * 0.55 * w
    }

    // smooth the pose
    const P = a.pose
    for (let i = 0; i < POSE_KEYS.length; i++) {
      const k = POSE_KEYS[i] as PoseKey
      P[k] = a.init ? damp(P[k], T[k], k === 'sit' || k === 'lie' ? 4 : 7, dt) : T[k]
    }

    // ---------------------------------------------------------- apply body
    const bob = Math.abs(Math.sin(a.phase)) * 0.035 * w
    const breath = Math.sin(t * (stt === 'sleeping' ? 1.2 : 1.9)) * (stt === 'sleeping' ? 0.02 : 0.012) * motion
    a.y = damp(a.y, place === 'bed' ? (lieNear ? spot.y : 0) : 0, 5, dt)
    const sitDrop = P.sit * (SEAT_Y - HIPS_Y + 0.012)
    root.current?.position.set(a.x, a.y + bob, a.z)
    fx.current?.position.set(a.x, 0, a.z)
    if (root.current) root.current.rotation.y = a.yaw
    if (body.current) {
      body.current.position.y = sitDrop
      body.current.rotation.z = P.lie * Math.PI * 0.5 + Math.sin(t * 0.6) * 0.012 * (1 - P.lie) * motion
    }
    if (spine.current) spine.current.rotation.x = P.lean + breath * 0.5
    if (torso.current) torso.current.scale.set(1 + breath * 0.6, 1 + breath, 1 + breath * 0.6)

    // arms
    if (shN.current) shN.current.rotation.set(P.nAx, 0, -P.nAz)
    if (shP.current) shP.current.rotation.set(P.pAx, 0, P.pAz)
    if (elN.current) elN.current.rotation.x = P.nEl
    if (elP.current) elP.current.rotation.x = P.pEl
    // legs
    const sb = Math.max(P.sit, P.lie)
    const swing = Math.sin(a.phase) * 0.65 * w
    const sitThigh = -1.5 + P.lie * 0.45
    if (thighN.current) thighN.current.rotation.x = lerp(swing, sitThigh, sb)
    if (thighP.current) thighP.current.rotation.x = lerp(-swing, sitThigh - P.lie * 0.15, sb)
    if (kneeN.current) kneeN.current.rotation.x = lerp(Math.max(0, -Math.sin(a.phase + 0.6)) * 0.8 * w, 1.5 + P.lie * 0.25, sb)
    if (kneeP.current) kneeP.current.rotation.x = lerp(Math.max(0, Math.sin(a.phase + 0.6)) * 0.8 * w, 1.5 + P.lie * 0.25, sb)

    // ---------------------------------------------------------- gaze
    let look: LookTarget = p.lookAt
    if (!IS_STATIC && stt === 'idle' && look === 'user') {
      a.glanceAt -= dt
      if (a.glanceAt <= 0) {
        const r = Math.random()
        a.glance = r < 0.45 ? 0 : r < 0.7 ? 1 : r < 0.85 ? 2 : 3
        a.glanceAt = a.glance === 0 ? 2 + Math.random() * 3 : 1.4 + Math.random() * 1.6
      }
    } else if (stt !== 'idle') a.glance = 0
    if (stt === 'thinking') a.glance = 1
    if (stt === 'working') {
      // mostly on the screen, now and then a glance at you
      a.glanceAt -= IS_STATIC ? 0 : dt
      if (a.glanceAt <= 0) {
        a.glance = a.glance === 2 && Math.random() < 0.5 ? 0 : 2
        a.glanceAt = a.glance === 0 ? 1.1 + Math.random() * 1.2 : 3 + Math.random() * 4
      }
      if (a.glance !== 0) a.glance = 2
    }
    if (a.glance === 1) look = 'window'
    else if (a.glance === 2) look = 'screen'

    let gazeX = 0
    let gazeY = 0
    let gazeZ = 0
    if (look === 'user') {
      tmpV.copy(camera.position)
      tmpV.x += st.pointer.x * 2.2 * motion
      tmpV.y += st.pointer.y * 1.4 * motion
    } else if (look === 'screen') tmpV.set(GAZE.screen[0], GAZE.screen[1], GAZE.screen[2])
    else if (look === 'window') tmpV.set(GAZE.window[0], GAZE.window[1], GAZE.window[2])
    else tmpV.set(look.x * 2.5, 1.2 + look.y * 1.5, 3)
    if (a.glance === 3) tmpV.set(GAZE.floor[0], GAZE.floor[1], GAZE.floor[2])
    if (head.current && P.lie < 0.5) {
      head.current.getWorldPosition(tmpW)
      tmpV.sub(tmpW)
      const c = Math.cos(a.yaw)
      const s = Math.sin(a.yaw)
      gazeX = tmpV.x * c - tmpV.z * s
      gazeZ = tmpV.x * s + tmpV.z * c
      gazeY = tmpV.y
    } else {
      gazeZ = 1
    }
    const yawWanted = clamp(Math.atan2(gazeX, gazeZ), -1.0, 1.0)
    const pitchWanted = clamp(-Math.atan2(gazeY, Math.hypot(gazeX, gazeZ)), -0.45, 0.4)
    a.gx = damp(a.gx, yawWanted * (stt === 'sleeping' ? 0 : 0.8), 5, dt)
    a.gy = damp(a.gy, pitchWanted * (stt === 'sleeping' ? 0 : 0.7), 5, dt)
    a.eyeGx = damp(a.eyeGx, clamp((yawWanted - a.gx) * 0.9, -1, 1), 9, dt)
    a.eyeGy = damp(a.eyeGy, clamp((pitchWanted - a.gy) * -1.2, -1, 1), 9, dt)
    if (head.current) head.current.rotation.set(a.gy + P.hPitch, a.gx, P.hRoll)

    // ---------------------------------------------------------- expression
    const emo: Emotion = stt === 'thinking' && p.emotion === 'neutral' ? 'thinking' : p.emotion
    const inten = emo === 'thinking' && p.emotion === 'neutral' ? 0.9 : clamp(p.intensity, 0, 1)
    const E = EMO[emo]
    const N = EMO.neutral
    for (let i = 0; i < EXPR_KEYS.length; i++) {
      const k = EXPR_KEYS[i] as ExprKey
      tgtExpr[k] = lerp(N[k], E[k], inten)
    }
    if (stt === 'listening') {
      tgtExpr.eye = Math.max(tgtExpr.eye, 1.12)
      tgtExpr.curve = Math.max(tgtExpr.curve, 0.45)
    }
    if (stt === 'working') {
      tgtExpr.eye = Math.min(tgtExpr.eye, 0.92)
      tgtExpr.curve = 0.18
    }
    if (stt === 'sleeping') {
      tgtExpr.eye = 0
      tgtExpr.curve = 0.45
      tgtExpr.blush = 0.35
      tgtExpr.bN = tgtExpr.bP = 0
      tgtExpr.tilt = 0
    }
    const X = a.ex
    for (let i = 0; i < EXPR_KEYS.length; i++) {
      const k = EXPR_KEYS[i] as ExprKey
      X[k] = damp(X[k], tgtExpr[k], 9, dt)
    }

    // blinking
    if (!IS_STATIC && stt !== 'sleeping') {
      a.blinkAt -= dt
      if (a.blinkAt <= 0) {
        a.blink = 1
        a.blinkAt = 2.2 + Math.random() * 3.8
      }
    }
    a.blink = Math.max(0, a.blink - dt * 7)
    const blinkK = 1 - Math.sin(Math.min(1, a.blink) * Math.PI) * 0.94
    const eyeScaleY = Math.max(0.06, X.eye * blinkK)
    if (eyeN.current) eyeN.current.scale.set(1, eyeScaleY, 1)
    if (eyeP.current) eyeP.current.scale.set(1, eyeScaleY, 1)
    if (irisN.current) irisN.current.position.set(a.eyeGx * 0.013, a.eyeGy * 0.014, 0.0015)
    if (irisP.current) irisP.current.position.set(a.eyeGx * 0.013, a.eyeGy * 0.014, 0.0015)

    // brows. positive tilt = inner end down. Far (N, x<0): inner end is its +x end.
    if (browN.current) {
      browN.current.position.y = 0.083 + X.bN * 0.04
      browN.current.rotation.z = -X.tilt * 0.55
    }
    if (browP.current) {
      browP.current.position.y = 0.083 + X.bP * 0.04
      browP.current.rotation.z = X.tilt * 0.55
    }
    // mouth
    const openAmt = clamp(X.open + env * 0.85, 0, 1)
    if (smile.current) {
      smile.current.scale.set(X.width, Math.max(0.1, Math.abs(X.curve)) * (X.curve >= 0 ? -1 : 1), 1)
      smile.current.visible = openAmt < 0.3
    }
    if (mouthOpen.current) {
      mouthOpen.current.visible = openAmt > 0.06
      mouthOpen.current.scale.set(X.width * (1 - openAmt * 0.25), 0.2 + openAmt * 1.5, 1)
    }
    if (blushN.current) blushN.current.opacity = X.blush * 0.6
    if (blushP.current) blushP.current.opacity = X.blush * 0.6

    // ponytail follows her motion
    const sway = Math.sin(t * 2.1) * 0.08 * motion + w * 0.4 + P.lean * 0.5
    if (pony.current) pony.current.rotation.x = 0.28 + sway - P.lie * 0.2
    if (pony2.current) pony2.current.rotation.x = Math.sin(t * 2.1 - 0.8) * 0.14 * motion + w * 0.25

    // ---------------------------------------------------------- effects
    const listening = stt === 'listening'
    a.aura = damp(a.aura, listening ? 1 : 0, 5, dt)
    if (auraRing.current) {
      const k = 1 + ((t * 0.8) % 1) * 0.9
      auraRing.current.scale.set(k, k, 1)
      auraRing.current.visible = a.aura > 0.02
      const m = auraRing.current.material as THREE.MeshBasicMaterial
      m.opacity = a.aura * 0.5 * (1 - ((t * 0.8) % 1))
    }
    if (auraRing2.current) {
      const k = 1 + ((t * 0.8 + 0.5) % 1) * 0.9
      auraRing2.current.scale.set(k, k, 1)
      auraRing2.current.visible = a.aura > 0.02
      const m = auraRing2.current.material as THREE.MeshBasicMaterial
      m.opacity = a.aura * 0.5 * (1 - ((t * 0.8 + 0.5) % 1))
    }
    if (auraLight.current) auraLight.current.intensity = a.aura * 0.9
    if (glow.current) glow.current.opacity = a.aura * 0.16

    a.dotsA = damp(a.dotsA, stt === 'thinking' ? 1 : 0, 6, dt)
    if (dots.current) {
      dots.current.visible = a.dotsA > 0.03
      dots.current.scale.setScalar(a.dotsA)
      for (let i = 0; i < dots.current.children.length; i++) {
        const c = dots.current.children[i]
        if (c) c.position.set((i - 1) * 0.13, Math.sin(t * 3.4 + i * 1.1) * 0.05 + i * 0.03, 0)
      }
    }
    a.zA = damp(a.zA, stt === 'sleeping' && P.lie > 0.8 ? 1 : 0, 3, dt)
    if (zs.current) {
      zs.current.visible = a.zA > 0.03
      zs.current.quaternion.copy(camera.quaternion)
      for (let i = 0; i < zs.current.children.length; i++) {
        const c = zs.current.children[i] as THREE.Mesh | undefined
        if (!c) continue
        const ph = (t * 0.35 + i / 3) % 1
        c.position.set(-ph * 0.45 - i * 0.04, ph * 0.7, 0)
        c.scale.setScalar((0.12 + ph * 0.2) * a.zA)
        const m = c.material as THREE.MeshBasicMaterial
        m.opacity = Math.sin(ph * Math.PI) * 0.9 * a.zA
      }
    }
    if (DEBUG) (window as unknown as Record<string, unknown>).__mira = { x: a.x, y: a.y, z: a.z, yaw: a.yaw, lie: P.lie, sit: P.sit, speed: a.speed, place, stt, dist, T: { ...T }, P: { ...P }, bodyRotZ: body.current?.rotation.z }
    a.init = true
  })

  return (
    <>
      {/* effects follow her position but not her facing (aura, thought dots, sleep z's) */}
      <group ref={fx}>
        <mesh ref={auraRing} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} visible={false}>
          <ringGeometry args={[0.36, 0.4, 32]} />
          <meshBasicMaterial color={PAL.rose} transparent opacity={0} depthWrite={false} />
        </mesh>
        <mesh ref={auraRing2} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} visible={false}>
          <ringGeometry args={[0.36, 0.4, 32]} />
          <meshBasicMaterial color={PAL.rose} transparent opacity={0} depthWrite={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <circleGeometry args={[0.55, 24]} />
          <meshBasicMaterial ref={glow} color={PAL.rose} transparent opacity={0} depthWrite={false} />
        </mesh>
        <pointLight ref={auraLight} color={PAL.rose} intensity={0} distance={2.6} position={[0, 1.0, 0.5]} />
        {/* floating things around her head */}
        <group ref={dots} position={[0.06, 1.72, 0]} visible={false}>
          {[PAL.rose, PAL.violet, PAL.teal].map((c, i) => (
            <mesh key={c} position={[(i - 1) * 0.13, 0, 0]}>
              <sphereGeometry args={[0.03 + i * 0.007, 10, 8]} />
              <meshBasicMaterial color={c} />
            </mesh>
          ))}
        </group>
        <group ref={zs} position={[-0.55, 0.95, 0]} visible={false}>
          {[0, 1, 2].map((i) => (
            <mesh key={i}>
              <planeGeometry args={[1, 1]} />
              <meshBasicMaterial map={zTex} transparent opacity={0} depthWrite={false} />
            </mesh>
          ))}
        </group>
      </group>

      <group ref={root}>
        <group ref={body}>
          {/* legs */}
          <Leg x={-0.075} thighRef={thighN} kneeRef={kneeN} />
          <Leg x={0.075} thighRef={thighP} kneeRef={kneeP} />

          {/* skirt */}
          <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[0.135, 0.255, 0.27, 16]} />
            <meshStandardMaterial color={PAL.dress} roughness={0.75} emissive={PAL.dress} emissiveIntensity={0.12} />
          </mesh>
          <mesh position={[0, 0.375, 0]}>
            <cylinderGeometry args={[0.256, 0.256, 0.018, 16]} />
            <meshStandardMaterial color="#fff3f8" roughness={0.8} />
          </mesh>

          {/* upper body pivots at the hips */}
          <group ref={spine} position={[0, HIPS_Y, 0]}>
            <group ref={torso}>
              <mesh position={[0, 0.15, 0]} castShadow>
                <cylinderGeometry args={[0.105, 0.13, 0.3, 12]} />
                <meshStandardMaterial color={PAL.blouse} roughness={0.8} emissive={PAL.blouse} emissiveIntensity={0.1} />
              </mesh>
              {/* pinafore bodice + straps */}
              <mesh position={[0, 0.08, 0.004]}>
                <cylinderGeometry args={[0.125, 0.134, 0.15, 14]} />
                <meshStandardMaterial color={PAL.dress} roughness={0.75} emissive={PAL.dress} emissiveIntensity={0.12} />
              </mesh>
              <mesh position={[0, 0.265, 0]}>
                <cylinderGeometry args={[0.07, 0.108, 0.04, 12]} />
                <meshStandardMaterial color="#fff" roughness={0.9} />
              </mesh>
              {/* bow at the collar */}
              <group position={[0, 0.235, 0.115]}>
                <mesh position={[-0.025, 0, 0]} rotation={[0, 0, 0.4]} scale={[0.032, 0.02, 0.016]}>
                  <sphereGeometry args={[1, 8, 6]} />
                  <meshStandardMaterial color={PAL.violet} roughness={0.5} />
                </mesh>
                <mesh position={[0.025, 0, 0]} rotation={[0, 0, -0.4]} scale={[0.032, 0.02, 0.016]}>
                  <sphereGeometry args={[1, 8, 6]} />
                  <meshStandardMaterial color={PAL.violet} roughness={0.5} />
                </mesh>
              </group>
            </group>
            <Arm x={-0.145} shRef={shN} elRef={elN} />
            <Arm x={0.145} shRef={shP} elRef={elP} />
            {/* neck */}
            <mesh position={[0, 0.315, 0]}>
              <cylinderGeometry args={[0.035, 0.04, 0.05, 8]} />
              <meshStandardMaterial color={PAL.skin} roughness={0.8} emissive={PAL.skin} emissiveIntensity={0.16} />
            </mesh>

            {/* head pivots at the neck */}
            <group ref={head} position={[0, 0.33, 0]}>
              <group position={[0, 0.25, 0]}>
                <mesh scale={[1.04, 0.97, 1]} castShadow>
                  <sphereGeometry args={[0.26, 22, 16]} />
                  <meshStandardMaterial color={PAL.skin} roughness={0.75} emissive={PAL.skin} emissiveIntensity={0.2} />
                </mesh>
                <Hair ponyRef={pony} pony2Ref={pony2} />

                <Eye side={-1} groupRef={eyeN} irisRef={irisN} />
                <Eye side={1} groupRef={eyeP} irisRef={irisP} />

                {/* brows */}
                <OnHead a={-0.4} b={0.3} r={FACE_R + 0.004}>
                  <mesh ref={browN} position={[0, 0.083, 0]}>
                    <boxGeometry args={[0.075, 0.014, 0.008]} />
                    <meshBasicMaterial {...flat('#3a2658')} />
                  </mesh>
                </OnHead>
                <OnHead a={0.4} b={0.3} r={FACE_R + 0.004}>
                  <mesh ref={browP} position={[0, 0.083, 0]}>
                    <boxGeometry args={[0.075, 0.014, 0.008]} />
                    <meshBasicMaterial {...flat('#3a2658')} />
                  </mesh>
                </OnHead>

                {/* blush */}
                {([-1, 1] as const).map((s) => (
                  <OnHead key={s} a={s * 0.78} b={-0.3} r={FACE_R - 0.004}>
                    <mesh scale={[0.045, 0.025, 1]}>
                      <circleGeometry args={[1, 14]} />
                      <meshBasicMaterial ref={s === -1 ? blushN : blushP} color="#ff7fa6" transparent opacity={0.2} depthWrite={false} />
                    </mesh>
                  </OnHead>
                ))}

                {/* mouth */}
                <OnHead a={0} b={-0.62} r={FACE_R + 0.002}>
                  <mesh ref={smile} position={[0, 0.012, 0]}>
                    <torusGeometry args={[0.03, 0.0048, 5, 14, Math.PI]} />
                    <meshBasicMaterial {...flat('#8d3556')} />
                  </mesh>
                  <group ref={mouthOpen} visible={false}>
                    <mesh scale={[0.03, 0.03, 1]}>
                      <circleGeometry args={[1, 14]} />
                      <meshBasicMaterial {...flat('#6b1f3d')} />
                    </mesh>
                    <mesh scale={[0.02, 0.012, 1]} position={[0, -0.012, 0.0012]}>
                      <circleGeometry args={[1, 10]} />
                      <meshBasicMaterial {...flat('#ff8fa8')} />
                    </mesh>
                  </group>
                </OnHead>
              </group>
            </group>
          </group>
        </group>

      </group>
    </>
  )
}
