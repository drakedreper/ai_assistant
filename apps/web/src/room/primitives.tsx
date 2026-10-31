import { Edges, Html, useCursor } from '@react-three/drei'
import { createContext, useContext, type MutableRefObject } from 'react'
import { useStore } from '../state/store'
import { PROPS, type PropId, type V3 } from './constants'
import { useRoomUi } from './roomUi'

/** Smoothed atmosphere shared by every light and glowing thing in the scene (updated by <Lighting/>). */
export interface Atmosphere {
  /** 0 = day, 1 = night. */
  night: number
  /** 0 = awake, 1 = room dimmed for sleep. */
  dim: number
  /** Seconds since mount, for pulses. */
  t: number
}
export const AtmoContext = createContext<MutableRefObject<Atmosphere>>({ current: { night: 0, dim: 0, t: 0 } })
export const useAtmo = () => useContext(AtmoContext)

interface MatProps {
  c: string
  rough?: number
  emissive?: string
  ei?: number
  metal?: number
}

interface BoxProps extends MatProps {
  p: V3
  s: V3
  r?: V3
  cast?: boolean
  receive?: boolean
}

export function Box({ p, s, r, c, rough = 0.85, emissive, ei = 0, metal = 0, cast = true, receive = true }: BoxProps) {
  return (
    <mesh position={p} rotation={r} scale={s} castShadow={cast} receiveShadow={receive}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={c} roughness={rough} metalness={metal} emissive={emissive ?? '#000000'} emissiveIntensity={ei} />
    </mesh>
  )
}

interface CylProps extends MatProps {
  p: V3
  /** radius top, radius bottom, height */
  d: V3
  r?: V3
  seg?: number
  cast?: boolean
  open?: boolean
  double?: boolean
}

export function Cyl({ p, d, r, c, rough = 0.85, emissive, ei = 0, metal = 0, seg = 12, cast = true, open, double }: CylProps) {
  return (
    <mesh position={p} rotation={r} castShadow={cast} receiveShadow>
      <cylinderGeometry args={[d[0], d[1], d[2], seg, 1, open]} />
      <meshStandardMaterial
        color={c}
        roughness={rough}
        metalness={metal}
        emissive={emissive ?? '#000000'}
        emissiveIntensity={ei}
        side={double ? 2 : 0}
      />
    </mesh>
  )
}

export function Sph({ p, s, c, rough = 0.85, emissive, ei = 0, seg = 10, cast = true }: MatProps & { p: V3; s: V3; seg?: number; cast?: boolean }) {
  return (
    <mesh position={p} scale={s} castShadow={cast} receiveShadow>
      <sphereGeometry args={[1, seg, Math.max(5, Math.round(seg * 0.7))]} />
      <meshStandardMaterial color={c} roughness={rough} emissive={emissive ?? '#000000'} emissiveIntensity={ei} />
    </mesh>
  )
}

/**
 * Invisible click target around a prop. Hover (from the scene or from a HUD button focus) shows a
 * tinted outline and a small label; click navigates to the screen behind the prop.
 */
export function Hotspot({ id, position, size, labelY }: { id: PropId; position: V3; size: V3; labelY?: number }) {
  const hovered = useRoomUi((s) => s.hovered === id)
  const info = PROPS[id]
  useCursor(hovered)
  return (
    <group position={position}>
      <mesh
        onPointerOver={(e) => {
          e.stopPropagation()
          useRoomUi.getState().setHovered(id)
        }}
        onPointerOut={() => {
          if (useRoomUi.getState().hovered === id) useRoomUi.getState().setHovered(null)
        }}
        onClick={(e) => {
          e.stopPropagation()
          useStore.getState().navigate(info.view)
        }}
      >
        <boxGeometry args={size} />
        <meshBasicMaterial color={info.hex} transparent opacity={hovered ? 0.22 : 0} depthWrite={false} />
        {hovered && <Edges color={info.hex} threshold={15} />}
      </mesh>
      {hovered && (
        <Html center position={[0, labelY ?? size[1] / 2 + 0.14, 0]} pointerEvents="none" zIndexRange={[30, 0]}>
          <span
            className="pointer-events-none rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-fg shadow-lg backdrop-blur-md"
            style={{ borderColor: `${info.hex}88`, background: 'rgb(10 12 22 / 0.78)' }}
          >
            {info.label}
          </span>
        </Html>
      )}
    </group>
  )
}
