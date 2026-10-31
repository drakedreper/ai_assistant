import { useState } from 'react'
import { useStore } from '../state/store'

/** STUB: replaced by the Chat module (streamed thread, tool chips, inline approvals, voice composer). */
export function ChatPanel({ variant }: { variant: 'dock' | 'overlay' | 'mini' }) {
  const chat = useStore((s) => s.data?.chat ?? [])
  const send = useStore((s) => s.send)
  const [text, setText] = useState('')
  return (
    <div className="glass flex min-h-0 flex-1 flex-col p-3 text-xs text-muted">
      <div className="min-h-0 flex-1 overflow-y-auto">{variant}: {chat.length} messages</div>
      <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void send(text.trim()); setText('') } }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message Mira…" className="w-full rounded-lg bg-white/6 px-3 py-2 text-fg outline-none" />
      </form>
    </div>
  )
}
