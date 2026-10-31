import { FileText, Link2 } from 'lucide-react'
import { cn } from '../lib/cn'
import { useStore } from '../state/store'

/** A citation into the second brain. Click to open the note in the Brain view. */
export function NoteChip({ path, title, className }: { path: string; title?: string; className?: string }) {
  const navigate = useStore((s) => s.navigate)
  const federated = path.startsWith('secondbrain/')
  const label = title ?? path.split('/').pop()?.replace(/\.md$/, '') ?? path
  return (
    <button
      type="button"
      onClick={() => navigate('brain', { note: path })}
      title={`${path}${federated ? ' (federated, read-only)' : ''}`}
      className={cn(
        'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 transition',
        federated ? 'border-dashed border-brain/40 text-brain/90 hover:bg-brain/10' : 'border-brain/30 bg-brain/10 text-brain hover:bg-brain/20',
        className,
      )}
    >
      {federated ? <Link2 className="size-3 shrink-0" /> : <FileText className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </button>
  )
}
