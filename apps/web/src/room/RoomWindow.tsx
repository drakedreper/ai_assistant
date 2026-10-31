import { Canvas } from '@react-three/fiber'
import { Component, useEffect, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import type { RoomMode } from '../state/store'
import { useStore } from '../state/store'
import { DEBUG, FORCE_FALLBACK } from './constants'
import { RoomFallback } from './RoomFallback'
import { RoomHud } from './RoomHud'
import { RoomScene } from './RoomScene'
import { useIsNight } from './signals'
import { webglAvailable } from './webgl'

/** If the 3D scene throws (shader failure, context creation error), fall back to the illustration. */
class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    this.props.onError()
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * Her window into the room. A real-time 3D diorama (react-three-fiber, procedural everything) with an
 * HTML HUD on top. Fills its parent. Falls back to an SVG illustration where WebGL is unavailable.
 */
if (DEBUG && import.meta.env.DEV) (window as unknown as Record<string, unknown>).__store = useStore

export function RoomWindow({ mode }: { mode: RoomMode }) {
  const night = useIsNight()
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(480)
  const [fallback, setFallback] = useState(() => FORCE_FALLBACK || !webglAvailable())

  useEffect(() => {
    const el = host.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={host} className="relative h-full w-full overflow-hidden" data-room-mode={mode}>
      {/* backdrop: deep indigo "night study", a touch warmer by day */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 95% at 50% 35%, #26225e 0%, #14122f 58%, #0b0a1d 100%)' }} />
      <div
        className="absolute inset-0 transition-opacity duration-1000"
        style={{ opacity: night ? 0 : 1, background: 'radial-gradient(120% 95% at 50% 30%, rgba(255,196,160,0.30) 0%, rgba(120,110,210,0.22) 55%, rgba(0,0,0,0) 100%)' }}
      />
      {fallback ? (
        <RoomFallback />
      ) : (
        <SceneBoundary onError={() => setFallback(true)}>
          <Canvas
            frameloop="demand"
            dpr={[1, 1.5]}
            flat
            shadows="percentage"
            gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
            camera={{ fov: 30, near: 0.1, far: 60, position: [6, 4, 8] }}
            role="img"
            aria-label="Mira's room: a small 3D study with her desk, bookshelf, calendar and bed. Use the shortcut buttons to open each area."
            style={{ position: 'absolute', inset: 0, touchAction: 'pan-y' }}
            onCreated={({ gl }) => {
              gl.setClearColor(0x000000, 0)
              if (DEBUG) (window as unknown as Record<string, unknown>).__gl = gl
              gl.outputColorSpace = THREE.SRGBColorSpace
              gl.domElement.addEventListener('webglcontextlost', (e) => {
                e.preventDefault()
                setFallback(true)
              })
            }}
          >
            <RoomScene mode={mode} />
          </Canvas>
        </SceneBoundary>
      )}
      <RoomHud mode={mode} width={width} />
    </div>
  )
}
