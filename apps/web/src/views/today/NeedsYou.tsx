import { CheckCheck, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'
import { ApprovalCard } from '../../components/ApprovalCard'
import { Badge, EmptyState, Panel } from '../../components/ui'
import { useSnap } from '../../state/store'

/** The queue of everything that waits for a human tap. Nothing outward happens without it. */
export function NeedsYou() {
  const approvals = useSnap((d) => d.approvals)
  const { pending, decided } = useMemo(() => {
    const order = { high: 0, medium: 1, low: 2 } as const
    const p = approvals.filter((a) => a.status === 'pending').sort((x, y) => order[x.risk] - order[y.risk])
    return { pending: p, decided: approvals.filter((a) => a.status !== 'pending') }
  }, [approvals])

  return (
    <Panel
      title="Needs you"
      subtitle="Nothing outward happens without your tap"
      icon={ShieldCheck}
      area="work"
      actions={pending.length ? <Badge tone="mira">{pending.length} waiting</Badge> : <Badge tone="ok">All clear</Badge>}
    >
      {pending.length === 0 ? (
        <EmptyState title="Nothing is waiting on you." hint={decided.length ? `${decided.length} handled today.` : undefined} />
      ) : (
        <div className="flex flex-col gap-2.5">
          {pending.map((a) => (
            <ApprovalCard key={a.id} id={a.id} variant="compact" />
          ))}
        </div>
      )}
      {decided.length > 0 && pending.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-faint">
          <CheckCheck className="size-3.5 text-ok" /> {decided.length} already handled
        </p>
      )}
    </Panel>
  )
}
