import { create } from 'zustand'
import type { PropId } from './constants'

/** Room-local UI state: which prop is highlighted (by pointer in the scene or focus in the HUD). */
interface RoomUi {
  hovered: PropId | null
  setHovered: (p: PropId | null) => void
}

export const useRoomUi = create<RoomUi>((set) => ({
  hovered: null,
  setHovered: (hovered) => set({ hovered }),
}))
