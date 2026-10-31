import { effectiveState, isNightNow, needsYouStatuses, useStore } from '../state/store'

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Primitive selectors over the store, so the Room only re-renders when a value it shows really changes. */
export const useIsNight = () => useStore((s) => isNightNow(s))
export const useEffState = () => useStore((s) => effectiveState(s))
export const useWeather = () => useStore((s) => s.data?.world.weather.condition ?? 'clear')
export const useDayNumber = () => useStore((s) => s.now.getDate())
export const useMonthLabel = () => useStore((s) => s.now.toLocaleDateString([], { month: 'short' }).toUpperCase())
export const useEventsToday = () =>
  useStore((s) => {
    const cal = s.data?.calendar
    if (!cal) return 0
    return cal.filter((e) => sameDay(new Date(e.start), s.now)).length
  })
export const useRunning = () => useStore((s) => s.data?.sessions.filter((x) => x.status === 'running').length ?? 0)
/** 0 = all clear, 1 = something waits for input, 2 = something is blocked on a permission. */
export const useNeedsLevel = () =>
  useStore((s): 0 | 1 | 2 => {
    const ss = s.data?.sessions ?? []
    if (ss.some((x) => x.status === 'blocked_permission')) return 2
    if (ss.some((x) => needsYouStatuses.includes(x.status))) return 1
    return 0
  })
export const usePendingProposals = () => useStore((s) => s.data?.proposals.filter((p) => p.status === 'pending').length ?? 0)
