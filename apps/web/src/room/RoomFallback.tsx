import { useMemo, type KeyboardEvent } from 'react'
import { useStore } from '../state/store'
import { PAL, PROPS, type PropId } from './constants'
import { useRoomUi } from './roomUi'
import { useDayNumber, useEffState, useEventsToday, useIsNight, useNeedsLevel, usePendingProposals, useRunning } from './signals'

/**
 * The room as a flat SVG illustration, shown when WebGL is unavailable (or the context is lost) so the
 * panel is never blank. Same props, same click targets, same states; the HUD is drawn on top as usual.
 */
export function RoomFallback() {
  const night = useIsNight()
  const state = useEffState()
  const day = useDayNumber()
  const events = useEventsToday()
  const running = useRunning()
  const level = useNeedsLevel()
  const pending = usePendingProposals()
  const emotion = useStore((s) => s.emotion)
  const hovered = useRoomUi((s) => s.hovered)
  const setHovered = useRoomUi((s) => s.setHovered)
  const navigate = useStore((s) => s.navigate)

  const place = state === 'sleeping' ? 'bed' : state === 'working' ? 'desk' : 'rug'
  const pos = { rug: [196, 236, 0, 1], desk: [96, 226, 0, 0.78], bed: [346, 176, -90, 0.9] }[place]
  const bulbs = useMemo(() => Array.from({ length: 12 }, (_, i) => [74 + i * 24, 46 + Math.sin((i / 11) * Math.PI) * 9, [PAL.rose, PAL.violet, PAL.teal, PAL.gold, PAL.blue][i % 5]] as const), [])
  const sleeping = state === 'sleeping'
  const smile = emotion === 'happy' || emotion === 'relaxed' || state === 'listening'
  const talking = state === 'speaking'

  const hot = (id: PropId) => ({
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': PROPS[id].aria,
    onClick: () => navigate(PROPS[id].view),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        navigate(PROPS[id].view)
      }
    },
    onMouseEnter: () => setHovered(id),
    onMouseLeave: () => setHovered(null),
    onFocus: () => setHovered(id),
    onBlur: () => setHovered(null),
    style: { cursor: 'pointer', outline: 'none' },
  })
  const ring = (id: PropId) => (hovered === id ? { stroke: PROPS[id].hex, strokeWidth: 2.2 } : { stroke: 'none' })
  const alert = level === 2 ? '#f87171' : level === 1 ? '#fbbf24' : PAL.teal

  return (
    <svg viewBox="0 0 400 290" className="absolute inset-0 h-full w-full" role="img" aria-label="Illustration of Mira's room" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="rf-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={night ? '#0a0e2c' : '#79b6ff'} />
          <stop offset="1" stopColor={night ? '#3a2a6b' : '#ffe6d0'} />
        </linearGradient>
        <filter id="rf-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>

      {/* shell */}
      <polygon points="14,64 62,40 62,194 14,262" fill={PAL.wallLeft} />
      <rect x="62" y="40" width="296" height="154" fill={PAL.wallBack} />
      <polygon points="62,194 358,194 392,262 14,262" fill="#8a5a58" />
      <polygon points="14,262 392,262 392,272 14,272" fill={PAL.slab} />
      <rect x="62" y="186" width="296" height="8" fill="#e9defa" opacity="0.8" />
      <ellipse cx="196" cy="230" rx="84" ry="19" fill="#d86a95" />
      <ellipse cx="196" cy="230" rx="64" ry="14" fill="#7e5bd0" />
      <ellipse cx="196" cy="230" rx="30" ry="6.5" fill="#f08cae" />

      {/* fairy lights */}
      <path d={`M70,40 Q216,${night ? 70 : 66} 354,40`} stroke="#2a2358" strokeWidth="1.2" fill="none" />
      {bulbs.map(([x, y, c], i) => (
        <circle key={i} cx={x} cy={y + 8} r="3" fill={c} opacity={sleeping ? 0.4 : night ? 1 : 0.55} />
      ))}

      {/* desk with monitor against the back wall (work) */}
      <g {...hot('work')}>
        <rect x="66" y="116" width="52" height="38" rx="3" fill="#14122e" />
        <rect x="69" y="119" width="46" height="32" rx="2" fill="#0b0e22" />
        <rect x="66" y="116" width="52" height="38" rx="3" fill="none" stroke={alert} strokeWidth="2.2" opacity={level ? 1 : 0.7} />
        <text x="92" y="141" textAnchor="middle" fontSize="18" fontWeight="800" fill="#fff">{running}</text>
        <rect x="88" y="154" width="8" height="8" fill="#252048" />
        <rect x="64" y="162" width="92" height="7" rx="2" fill="#c79a78" />
        <rect x="68" y="169" width="6" height="25" fill="#8f6a50" />
        <rect x="146" y="169" width="6" height="25" fill="#8f6a50" />
        <rect x="78" y="166" width="20" height="3" rx="1" fill="#2d2859" />
        <rect x="62" y="110" width="98" height="88" rx="5" fill="none" {...ring('work')} />
      </g>
      <ellipse cx="108" cy="208" rx="14" ry="4.5" fill={PAL.violet} />

      {/* bookshelf (brain) */}
      <g {...hot('brain')}>
        {pending > 0 && <rect x="164" y="64" width="44" height="130" rx="4" fill={PAL.violet} opacity="0.4" filter="url(#rf-glow)" />}
        <rect x="166" y="68" width="40" height="124" fill="#2a2060" stroke={pending > 0 ? PAL.violet : '#6d4fb3'} strokeWidth="3" />
        {[0, 1, 2, 3].map((r) => (
          <g key={r}>
            <rect x="169" y={94 + r * 24} width="34" height="3" fill="#6d4fb3" />
            {Array.from({ length: 6 }, (_, i) => (
              <rect key={i} x={171 + i * 5.2} y={75 + r * 24 + (i % 3) * 2.5} width="4.2" height={18 - (i % 3) * 2.5} fill={[PAL.violet, PAL.rose, PAL.teal, PAL.gold, PAL.blue][(i + r) % 5]} opacity="0.85" />
            ))}
          </g>
        ))}
        <rect x="163" y="64" width="46" height="130" rx="4" fill="none" {...ring('brain')} />
      </g>

      {/* window */}
      <g>
        <rect x="224" y="72" width="62" height="74" fill="url(#rf-sky)" />
        {night && [0, 1, 2, 3, 4, 5].map((i) => <circle key={i} cx={232 + i * 9} cy={80 + (i % 3) * 8} r="0.9" fill="#fff" />)}
        <path d="M224,140 L232,128 L244,134 L256,122 L270,132 L286,126 L286,146 L224,146 Z" fill={night ? '#17143a' : '#8f95c4'} />
        <rect x="222" y="70" width="66" height="78" fill="none" stroke="#e9defa" strokeWidth="4" />
        <line x1="255" y1="72" x2="255" y2="146" stroke="#e9defa" strokeWidth="2.2" />
        <line x1="224" y1="106" x2="286" y2="106" stroke="#e9defa" strokeWidth="2.2" />
        <rect x="210" y="68" width="11" height="88" rx="3" fill="#8a6bd8" />
        <rect x="289" y="68" width="11" height="88" rx="3" fill="#8a6bd8" />
      </g>

      {/* calendar (life) */}
      <g {...hot('calendar')}>
        <rect x="312" y="78" width="38" height="50" rx="4" fill="#fbf2ea" />
        <path d="M312,82 a4,4 0 0 1 4,-4 h30 a4,4 0 0 1 4,4 v10 h-38 z" fill={PAL.rose} />
        <text x="331" y="112" textAnchor="middle" fontSize="18" fontWeight="800" fill="#2a2350">{day}</text>
        {Array.from({ length: Math.min(events, 5) }, (_, i) => <circle key={i} cx={331 + (i - (Math.min(events, 5) - 1) / 2) * 7} cy="122" r="2.1" fill={PAL.orange} />)}
        <rect x="309" y="75" width="44" height="56" rx="5" fill="none" {...ring('calendar')} />
      </g>

      {/* bed */}
      <rect x="276" y="158" width="82" height="32" rx="4" fill="#f2e6f1" />
      <rect x="276" y="178" width="82" height="13" rx="3" fill="#7a5a86" />
      <rect x="276" y="142" width="7" height="48" rx="2" fill="#6d4fb3" />
      <rect x="286" y="158" width="22" height="9" rx="4" fill="#ffe9f1" />
      <rect x="326" y="164" width="30" height="16" rx="4" fill="#8a6bd8" />

      {/* side table with ledger (money) */}
      <g {...hot('money')}>
        <rect x="248" y="160" width="26" height="24" fill={PAL.gold} opacity="0.35" filter="url(#rf-glow)" />
        <rect x="244" y="170" width="30" height="22" rx="2" fill="#a77d5e" />
        <rect x="242" y="166" width="34" height="5" fill="#c79a78" />
        <rect x="247" y="158" width="20" height="5" fill={PAL.rose} />
        <rect x="248" y="152" width="18" height="6" fill="#c99a2c" />
        <rect x="239" y="148" width="40" height="46" rx="4" fill="none" {...ring('money')} />
      </g>

      {/* plant */}
      <rect x="216" y="176" width="13" height="13" rx="2" fill="#c2705a" />
      {[-18, -6, 6, 18].map((a) => <ellipse key={a} cx="222" cy="165" rx="4" ry="12" fill="#4fb783" transform={`rotate(${a} 222 176)`} />)}

      {/* floor lamp */}
      <rect x="378" y="150" width="2" height="90" fill="#cfc2ee" />
      <polygon points="368,150 390,150 384,130 374,130" fill="#ffdcae" opacity={sleeping ? 0.5 : 1} />
      <ellipse cx="379" cy="241" rx="9" ry="3" fill="#4a2f6b" />

      {/* Mira */}
      <g style={{ transform: `translate(${pos[0]}px, ${pos[1]}px) rotate(${pos[2]}deg) scale(${pos[3]})`, transition: 'transform 0.9s ease' }}>
        <ellipse cx="0" cy="0" rx="20" ry="5" fill="#000" opacity="0.25" />
        <rect x="-8" y="-22" width="5" height="22" rx="2" fill={PAL.skin} />
        <rect x="3" y="-22" width="5" height="22" rx="2" fill={PAL.skin} />
        <path d="M-9,-52 L9,-52 L17,-20 L-17,-20 Z" fill={PAL.dress} />
        <rect x="-9" y="-62" width="18" height="14" rx="5" fill={PAL.blouse} />
        <circle cx="0" cy="-76" r="17" fill={PAL.skin} />
        <path d="M-18,-78 a18,18 0 0 1 36,0 q-18,-12 -36,0 z" fill={PAL.hair} />
        <ellipse cx="-19" cy="-70" rx="5" ry="12" fill={PAL.hair} />
        <ellipse cx="19" cy="-70" rx="5" ry="12" fill={PAL.hair} />
        <circle cx="19" cy="-90" r="6" fill={PAL.hair} />
        {sleeping ? (
          <>
            <path d="M-10,-74 q3,3 6,0" stroke="#2a1b3f" strokeWidth="1.6" fill="none" />
            <path d="M4,-74 q3,3 6,0" stroke="#2a1b3f" strokeWidth="1.6" fill="none" />
          </>
        ) : (
          <>
            <ellipse cx="-7" cy="-74" rx="3.4" ry="4.4" fill="#7d5fe0" />
            <ellipse cx="7" cy="-74" rx="3.4" ry="4.4" fill="#7d5fe0" />
            <circle cx="-6" cy="-76" r="1.1" fill="#fff" />
            <circle cx="8" cy="-76" r="1.1" fill="#fff" />
          </>
        )}
        <circle cx="-11" cy="-67" r="3" fill="#ff7fa6" opacity="0.4" />
        <circle cx="11" cy="-67" r="3" fill="#ff7fa6" opacity="0.4" />
        {talking ? <ellipse cx="0" cy="-64" rx="3" ry="2.6" fill="#6b1f3d" /> : <path d={smile ? 'M-4,-65 q4,4 8,0' : 'M-3,-64 h6'} stroke="#8d3556" strokeWidth="1.4" fill="none" strokeLinecap="round" />}
      </g>
      {sleeping && (
        <g fill="#efe7ff" fontWeight="800" opacity="0.9">
          <text x="296" y="140" fontSize="14">z</text>
          <text x="308" y="126" fontSize="11">z</text>
        </g>
      )}
      {/* night wash */}
      <rect x="14" y="40" width="378" height="232" fill="#0a0b30" opacity={night ? (sleeping ? 0.42 : 0.26) : sleeping ? 0.3 : 0} pointerEvents="none" />
    </svg>
  )
}
