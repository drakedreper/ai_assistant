import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { create } from 'zustand'
import type { Asset, CharacterProfile, StageSnapshot } from '@ai-assistant/shared'
import { describeStageError } from '../../../stage/stageClient'
import { useStageFeed } from '../../../stage/feed'

/** View state of the Stage tab that survives switching sections (which character the panels edit). */
interface StageUi {
  characterId: string | null
  select: (id: string) => void
}
export const useStageUi = create<StageUi>((set) => ({ characterId: null, select: (characterId) => set({ characterId }) }))

/** The character the panels edit: the one picked, else the active assistant, else the first one. */
export function useSelectedCharacter(snap: StageSnapshot): CharacterProfile | undefined {
  const picked = useStageUi((s) => s.characterId)
  return snap.characters.find((c) => c.id === picked) ?? snap.characters.find((c) => c.id === snap.assistantCharacterId) ?? snap.characters[0]
}

/**
 * Run a stage call: busy flag, the daemon's refusal as a readable message (never swallowed), and a refresh of the stage
 * state afterwards so what the screen shows is what the daemon holds.
 */
export function useStageAction() {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async <T,>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    setBusy(true)
    setError(null)
    try {
      const value = await fn()
      await useStageFeed.getState().refresh()
      return { ok: true, value }
    } catch (err) {
      setError(describeStageError(err))
      return { ok: false }
    } finally {
      setBusy(false)
    }
  }
  return { run, error, busy, clear: () => setError(null) }
}

/** A refusal or failure, announced to screen readers. */
export function StageNotice({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" data-testid="stage-error" className="mt-2 flex items-start gap-1.5 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] leading-snug text-bad">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{error}</span>
    </p>
  )
}

export const assetById = (snap: StageSnapshot): Map<string, Asset> => new Map(snap.assets.map((a) => [a.id, a]))

/** Does the licence permit personal use at all? (The daemon judges it again on every use.) */
export function licenceBlocks(a: Asset): boolean {
  const id = a.license.id.trim().toLowerCase()
  return !a.license.personalUse || id === '' || id === 'unknown' || id === 'unlicensed' || id === 'none'
}

/** "personal, commercial" style summary of what a licence allows. */
export function licenceSummary(a: Asset): string {
  const l = a.license
  const allowed = [l.personalUse && 'personal use', l.commercialUse && 'commercial use', l.redistribution && 'redistribution'].filter(Boolean)
  return allowed.length > 0 ? `allows ${allowed.join(', ')}` : 'allows nothing'
}
