import { useEffect } from 'react'
import { Badge, Segmented } from '../../components/ui'
import { pendingApprovals, useSnap, useStore } from '../../state/store'
import { ApprovalsTab } from './components/ApprovalsTab'
import { Board } from './components/Board'
import { CostTab } from './components/CostTab'
import { MonitorHealth } from './components/MonitorHealth'
import { Overview } from './components/Overview'
import { StatStrip } from './components/StatStrip'
import { Toasts } from './components/Toasts'
import { useWork, type WorkTab } from './ui'

const TABS: WorkTab[] = ['overview', 'board', 'cost', 'approvals']
const isTab = (v: string | undefined): v is WorkTab => !!v && (TABS as string[]).includes(v)

/**
 * WORK: Claude Code mission control. Sessions come from hooks (observed), the SDK (launched by Mira's daemon)
 * and imported history; cost is an API-equivalent estimate, never a bill.
 */
export function WorkView() {
  const tab = useWork((s) => s.tab)
  const setTab = useWork((s) => s.setTab)
  const params = useStore((s) => s.viewParams)
  const clearParams = useStore((s) => s.clearParams)
  const pending = useSnap((d) => pendingApprovals(d).filter((a) => a.area === 'work').length)

  // Deep links from other screens: apply once, then clear.
  useEffect(() => {
    if (!params || Object.keys(params).length === 0) return
    const ui = useWork.getState()
    const approval = params.approval ? useStore.getState().data?.approvals.find((a) => a.id === params.approval) : undefined
    if (params.session) {
      ui.selectSession(params.session)
      ui.clearProjects()
      ui.setStatusFilter('all')
      ui.setQuery('')
    }
    if (params.task) ui.flash({ task: params.task })
    if (params.approval) {
      if (approval && approval.area !== 'work') ui.setIncludeAllAreas(true)
      ui.flash({ approval: params.approval })
    }
    const next = isTab(params.tab) ? params.tab : params.approval ? 'approvals' : params.task ? 'board' : params.session ? 'overview' : undefined
    if (next) setTab(next)
    if (params.session) {
      const id = params.session
      setTimeout(() => document.querySelector(`[data-session-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }), 80)
    }
    clearParams()
  }, [params, clearParams, setTab])

  return (
    <div className="@container flex flex-col gap-3 pb-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="mr-auto min-w-0">
          <h1 className="text-[17px] leading-tight font-semibold text-fg">Mission control</h1>
          <p className="text-[12px] text-faint">Claude Code sessions, observed live. Costs are estimates.</p>
        </div>
        <Segmented
          ariaLabel="Work sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'board', label: 'Board' },
            { value: 'cost', label: 'Cost' },
            {
              value: 'approvals',
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Approvals
                  {pending > 0 && <Badge tone="warn" className="px-1.5 py-0 tabular-nums">{pending}</Badge>}
                </span>
              ),
            },
          ]}
        />
        <MonitorHealth />
      </header>

      <StatStrip />

      <div role="tabpanel" aria-label={`${tab} panel`}>
        {tab === 'overview' && <Overview />}
        {tab === 'board' && <Board />}
        {tab === 'cost' && <CostTab />}
        {tab === 'approvals' && <ApprovalsTab />}
      </div>
      <Toasts />
    </div>
  )
}
