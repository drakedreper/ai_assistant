import { useStore } from '../state/store'
import { sendMessage } from './send'

/** The canned transcript the voice demo "hears". */
export const VOICE_TRANSCRIPT = 'What do I need to look at first?'
export const VOICE_LISTEN_MS = 2400

let timer: ReturnType<typeof setTimeout> | undefined

/** Stop listening without sending (second press on the mic). */
export function cancelVoice(): void {
  clearTimeout(timer)
  timer = undefined
  if (useStore.getState().micOn) useStore.getState().setMic(false)
}

/**
 * Push-to-talk demo shared by the composer and the Room's presence bar: turn the mic on, "listen" for
 * about 2.4 s, then send the canned transcript as a voice message and turn the mic off.
 */
export function toggleVoice(): void {
  const s = useStore.getState()
  if (s.micOn) {
    cancelVoice()
    return
  }
  if (s.asleep) s.setAsleep(false)
  s.setMic(true)
  timer = setTimeout(() => {
    timer = undefined
    useStore.getState().setMic(false)
    void sendMessage(VOICE_TRANSCRIPT, 'voice')
  }, VOICE_LISTEN_MS)
}
