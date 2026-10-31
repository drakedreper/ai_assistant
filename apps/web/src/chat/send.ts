import { api } from '../api'
import { useStore } from '../state/store'

/**
 * UI-side helpers around the store's send(): the one place chat input goes through, so the Composer,
 * the Room's mic button and the "Look at this" button behave identically.
 */

const GOODNIGHT = /good ?night|going to bed|off to bed|time to sleep/i
let sleepToken = 0

/** After a goodnight reply has finished streaming she actually goes to bed (the Room reads store.asleep). */
function scheduleSleep(token: number): void {
  const started = Date.now()
  const tick = () => {
    if (token !== sleepToken) return
    const s = useStore.getState()
    if (!s.streaming && s.assistantState === 'idle') {
      setTimeout(() => {
        if (token === sleepToken) useStore.getState().setAsleep(true)
      }, 1400)
      return
    }
    if (Date.now() - started < 30_000) setTimeout(tick, 400)
  }
  setTimeout(tick, 600)
}

export async function sendMessage(text: string, modality: 'text' | 'voice' = 'text'): Promise<void> {
  const clean = text.trim()
  if (!clean) return
  sleepToken++
  const token = sleepToken
  await useStore.getState().send(clean, modality)
  if (GOODNIGHT.test(clean)) scheduleSleep(token)
}

/** Barge-in. The fixture client does not emit chat.done on interrupt, so clear the flag here. */
export async function stopReply(): Promise<void> {
  sleepToken++
  await api.interruptChat()
  useStore.setState({ streaming: false })
}
