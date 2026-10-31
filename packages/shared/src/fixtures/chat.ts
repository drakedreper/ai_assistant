import type { ChatMessage } from '../index'
import { ago } from './time'

/** SEED. The Chat owner enriches the scripted thread. Keep ids in STORY.md valid. */
export function buildChat(now: Date): ChatMessage[] {
  return [
    {
      id: 'c1', role: 'assistant', createdAt: ago(now, 44), modality: 'text',
      parts: [
        { type: 'text', emotion: 'happy', text: 'Good morning! I read your night so you do not have to.' },
        { type: 'text', emotion: 'neutral', text: 'Three things need you: the Atlas migration wants to delete a backup, Priya is waiting on a reply, and I proposed a tweak to your Q4 positioning.' },
        { type: 'tool', tool: 'worklog_status', summary: 'checked your 6 sessions', status: 'done' },
        { type: 'approval', approvalId: 'ap-rm-backup' },
      ],
    },
  ]
}
