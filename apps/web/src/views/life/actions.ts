import type { CalendarEvent, MailThread } from '@ai-assistant/shared'
import { api } from '../../api'
import { useLife } from './ui'

/** Approve or deny a calendar hold Mira proposed. The approval is the source of truth; the grid just reacts. */
export async function decideEvent(e: CalendarEvent, decision: 'approved' | 'denied'): Promise<void> {
  if (!e.approvalId) return
  await api.decideApproval(e.approvalId, decision)
  const ui = useLife.getState()
  ui.setFlash(decision === 'approved' ? `Added to your calendar: ${e.title}.` : `Dropped: ${e.title}. I will not propose it again this week.`)
  if (decision === 'denied' && ui.selectedEvent === e.id) ui.selectEvent(null)
}

/** Send (approve) or dismiss (deny) Mira's suggested reply. Sending always goes through the approval. */
export async function decideDraft(m: MailThread, decision: 'approved' | 'denied'): Promise<void> {
  if (!m.approvalId) return
  const ui = useLife.getState()
  ui.markDecided(m.id)
  ui.markRead(m.id)
  ui.setEditing(m.id, false)
  await api.decideApproval(m.approvalId, decision)
}
