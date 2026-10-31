import {
  Brain,
  Briefcase,
  CalendarDays,
  Globe,
  LayoutDashboard,
  Settings,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

/** The five life/work areas. Each owns one hue; class strings are literal so Tailwind can see them. */
export type Area = 'work' | 'brain' | 'life' | 'money' | 'world'

export const AREA: Record<
  Area,
  { label: string; text: string; bg: string; border: string; dot: string; ring: string; icon: LucideIcon; hex: string }
> = {
  work: { label: 'Work', text: 'text-work', bg: 'bg-work/12', border: 'border-work/30', dot: 'bg-work', ring: 'ring-work/40', icon: Briefcase, hex: '#2dd4bf' },
  brain: { label: 'Brain', text: 'text-brain', bg: 'bg-brain/12', border: 'border-brain/30', dot: 'bg-brain', ring: 'ring-brain/40', icon: Brain, hex: '#a78bfa' },
  life: { label: 'Life', text: 'text-life', bg: 'bg-life/12', border: 'border-life/30', dot: 'bg-life', ring: 'ring-life/40', icon: CalendarDays, hex: '#fb923c' },
  money: { label: 'Money', text: 'text-money', bg: 'bg-money/12', border: 'border-money/30', dot: 'bg-money', ring: 'ring-money/40', icon: Wallet, hex: '#fbbf24' },
  world: { label: 'World', text: 'text-world', bg: 'bg-world/12', border: 'border-world/30', dot: 'bg-world', ring: 'ring-world/40', icon: Globe, hex: '#60a5fa' },
}

export type View = 'today' | Area | 'settings'

export const VIEWS: Array<{ id: View; label: string; icon: LucideIcon; hint: string }> = [
  { id: 'today', label: 'Today', icon: LayoutDashboard, hint: 'Briefing and what needs you' },
  { id: 'work', label: 'Work', icon: Briefcase, hint: 'Claude sessions, kanban, cost' },
  { id: 'brain', label: 'Brain', icon: Brain, hint: 'Second brain: notes, graph, memory' },
  { id: 'life', label: 'Life', icon: CalendarDays, hint: 'Calendar, inbox, people' },
  { id: 'money', label: 'Money (Atlas)', icon: Wallet, hint: 'Net worth, budget, bills' },
  { id: 'world', label: 'World', icon: Globe, hint: 'News and world overview' },
  { id: 'settings', label: 'Settings', icon: Settings, hint: 'Persona, trust, privacy' },
]
