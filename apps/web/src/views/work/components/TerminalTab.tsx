import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo, TerminalKind } from '@ai-assistant/shared'
import { Accessibility, Bot, FolderOpen, Plus, RotateCw, ShieldAlert, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  attachTerminal,
  closeTerminal,
  createTerminal,
  describeTerminalError,
  hasPairingProof,
  listTerminals,
  type TerminalSession,
  type TerminalViewState,
} from '../../../api/terminalClient'
import { Badge, Button, EmptyState, Panel } from '../../../components/ui'
import { cn } from '../../../lib/cn'
import { useSnap, useStore } from '../../../state/store'

/**
 * WORK > Terminal (daemon mode only): the user's own `claude` and a shell, running on this PC through the daemon's PTY.
 * This is the one place in the app that runs commands as the user, so it says so, and it is off until the user
 * switches it on in Settings, Privacy. Loaded lazily (with xterm.js) the first time the tab is opened.
 */

const EMPTY: TerminalInfo[] = []
let lastSelected: string | null = null

const KIND_LABEL: Record<TerminalKind, string> = { claude: 'Claude', shell: 'Shell' }

function PhaseBadge({ info, view }: { info: TerminalInfo; view?: TerminalViewState }) {
  if (info.state === 'exited') {
    return (
      <Badge tone="neutral" title="The process has ended. Open it to see what it printed, then remove it.">
        Exited{info.exitCode === null || info.exitCode === undefined ? '' : ` (${info.exitCode})`}
      </Badge>
    )
  }
  if (view && view.phase !== 'live') return <Badge tone="warn">{view.phase === 'connecting' ? 'Connecting' : 'Reconnecting'}</Badge>
  return <Badge tone="ok">Running</Badge>
}

function statusText(v: TerminalViewState): string {
  switch (v.phase) {
    case 'connecting':
      return 'Connecting to the terminal...'
    case 'live':
      return 'Connected. Shift+Esc leaves the terminal.'
    case 'reconnecting':
      return `${v.detail ?? 'Reconnecting'}... The process on this PC keeps running.`
    case 'exited':
      return v.exitCode === null || v.exitCode === undefined ? 'The process ended.' : `The process ended with exit code ${v.exitCode}.`
    case 'gone':
      return v.detail ?? 'This terminal no longer exists.'
    case 'disabled':
      return v.detail ?? 'Embedded terminals are switched off.'
    case 'failed':
      return v.detail ?? 'The connection failed.'
  }
}

/** One xterm.js viewport attached to one terminal. Unmounting only detaches: the process keeps running. */
function Viewport({ info, onRemove }: { info: TerminalInfo; onRemove: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const session = useRef<TerminalSession | undefined>(undefined)
  const [view, setView] = useState<TerminalViewState>({ phase: 'connecting' })
  const [screenReader, setScreenReader] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let cancelled = false
    let mine: TerminalSession | undefined
    setView({ phase: 'connecting' })
    attachTerminal({
      container: el,
      terminalId: info.id,
      label: `Terminal: ${info.title}`,
      onState: (s) => !cancelled && setView(s),
      onNotice: (t) => {
        if (cancelled) return
        setNotice(t)
        clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(null), 5000)
      },
    })
      .then((s) => {
        if (cancelled) return s.dispose()
        mine = s
        session.current = s
        s.focus()
      })
      .catch(() => !cancelled && setView({ phase: 'failed', detail: 'The terminal view could not be loaded.' }))
    return () => {
      cancelled = true
      clearTimeout(noticeTimer.current)
      mine?.dispose()
      session.current = undefined
    }
  }, [info.id, info.title])

  const toggleScreenReader = (): void => {
    const next = !screenReader
    setScreenReader(next)
    session.current?.setScreenReaderMode(next)
  }

  return (
    <section className="flex min-h-0 flex-col gap-2" aria-label={`Terminal viewport: ${info.title}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          {info.kind === 'claude' ? <Bot className="size-4 shrink-0 text-mira" aria-hidden /> : <SquareTerminal className="size-4 shrink-0 text-work" aria-hidden />}
          <h3 className="truncate text-[13px] font-semibold text-fg">{info.title}</h3>
          <PhaseBadge info={info} view={view} />
        </div>
        <Button size="xs" variant="ghost" onClick={() => session.current?.focus()} aria-label="Focus the terminal">
          Focus
        </Button>
        {(view.phase === 'failed' || view.phase === 'reconnecting') && (
          <Button size="xs" variant="outline" onClick={() => session.current?.reconnect()} aria-label="Reconnect to the terminal">
            <RotateCw className="size-3" aria-hidden /> Reconnect
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={toggleScreenReader} aria-pressed={screenReader} aria-label="Screen reader mode">
          <Accessibility className="size-3" aria-hidden /> Screen reader mode
        </Button>
        <Button size="xs" variant="danger" onClick={() => onRemove(info.id)} aria-label={info.state === 'exited' ? 'Remove this terminal' : 'Close this terminal and end its process'}>
          <X className="size-3" aria-hidden /> {info.state === 'exited' ? 'Remove' : 'Close'}
        </Button>
      </div>

      <div className="rounded-xl border border-line bg-canvas p-2" data-testid="terminal-frame">
        <div
          ref={host}
          role="group"
          aria-label={`Terminal: ${info.title}. This terminal runs commands as you.`}
          data-testid="terminal-host"
          data-phase={view.phase}
          className="h-[min(62vh,640px)] min-h-[300px] w-full overflow-hidden"
        />
      </div>

      <p role="status" aria-live="polite" className={cn('min-h-4 text-[11px]', view.phase === 'failed' || view.phase === 'gone' ? 'text-bad' : 'text-faint')} data-testid="terminal-status">
        {statusText(view)}
        {notice && <span className="ml-2 text-warn">{notice}</span>}
      </p>
    </section>
  )
}

/** The Work screen's Terminal tab. */
export function TerminalTab() {
  const enabled = useSnap((d) => d.settings.terminals?.enabled === true)
  const fromSnapshot = useSnap((d) => d.terminals ?? EMPTY)
  const projects = useSnap((d) => d.projects)
  const navigate = useStore((s) => s.navigate)

  const [list, setList] = useState<TerminalInfo[]>(fromSnapshot)
  const [selected, setSelected] = useState<string | null>(lastSelected)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setList(fromSnapshot), [fromSnapshot])
  useEffect(() => {
    lastSelected = selected
  }, [selected])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList(await listTerminals())
    } catch {
      /* the snapshot list stays; the connection banner already says when the daemon is away */
    }
  }, [])

  // A terminal that disappeared (closed elsewhere, terminals switched off) cannot stay selected.
  useEffect(() => {
    if (selected && !list.some((t) => t.id === selected)) setSelected(null)
  }, [list, selected])

  const open = useCallback(
    async (kind: TerminalKind, projectId?: string): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const info = await createTerminal({ kind, ...(projectId ? { projectId } : {}) })
        setList((l) => [...l.filter((t) => t.id !== info.id), info])
        setSelected(info.id)
      } catch (err) {
        setError(describeTerminalError(err))
      } finally {
        setBusy(false)
        void refresh()
      }
    },
    [refresh],
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setError(null)
      try {
        await closeTerminal(id)
        setList((l) => l.filter((t) => t.id !== id))
        setSelected((s) => (s === id ? null : s))
      } catch (err) {
        setError(describeTerminalError(err))
      } finally {
        void refresh()
      }
    },
    [refresh],
  )

  if (!enabled) {
    return (
      <Panel title="Terminals are off" subtitle="Your own Claude Code and a shell, inside the app" icon={ShieldAlert} area="work">
        <div data-testid="terminal-disabled">
          <EmptyState
            title="Embedded terminals are switched off."
            hint="A terminal runs commands as you, with your permissions. Nothing can open one until you turn this on."
          />
          <div className="flex justify-center pb-2">
            <Button variant="primary" size="md" onClick={() => navigate('settings', { tab: 'privacy' })}>
              Open Settings, Privacy
            </Button>
          </div>
        </div>
      </Panel>
    )
  }

  const current = list.find((t) => t.id === selected)
  const running = list.filter((t) => t.state === 'running').length
  // Terminals need the pairing from the sign-in link besides the cookie (see terminalClient.ts); say so before it fails.
  const unpaired = !hasPairingProof()

  return (
    <div className="flex flex-col gap-3" data-testid="terminal-tab">
      <div role="note" className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] leading-snug text-muted">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
        <p>
          <strong className="font-semibold text-fg">Terminals run commands as you</strong>, on this PC, with your normal permissions. &ldquo;Claude&rdquo; here is your own{' '}
          <code className="font-mono text-fg">claude</code>: you sign in to it yourself and Mira never touches its login. The daemon only relays the bytes: recent output is kept in memory so a reload can
          reattach, and neither it nor what you type is written to disk or logs by the daemon or shown to Mira. The programs inside the terminal keep their own records, though: your shell writes a
          history file (for example <code className="font-mono text-fg">~/.bash_history</code>) and Claude Code keeps its own session transcripts, so do not type secrets you would not want there.
          Mira cannot open or read a terminal.
        </p>
      </div>

      {unpaired && (
        <p role="note" className="rounded-xl border border-warn/30 bg-warn/[0.07] px-3 py-2 text-[12px] leading-snug text-muted" data-testid="terminal-unpaired">
          <strong className="font-semibold text-fg">This browser is not paired for terminals yet.</strong> Open the sign-in link the daemon printed when it started (the part after the # is the pairing), or restart the
          daemon for a new link. It is needed because another program on this PC could receive this browser&apos;s cookie.
        </p>
      )}

      <Panel
        title="Terminals"
        subtitle={`${running} running${list.length > running ? `, ${list.length - running} ended` : ''}`}
        icon={SquareTerminal}
        area="work"
        actions={
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void open('claude')}>
              <Bot className="size-3.5" aria-hidden /> New Claude terminal
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void open('shell')}>
              <Plus className="size-3.5" aria-hidden /> New shell
            </Button>
          </div>
        }
      >
        {error && (
          <p role="alert" className="mb-2 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad" data-testid="terminal-error">
            {error}
          </p>
        )}

        {list.length === 0 ? (
          <EmptyState title="No terminals yet." hint="Start Claude Code or a shell. They stay running if you leave this page, and reattach when you come back." />
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label="Terminals">
            {list.map((t) => (
              <li key={t.id}>
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5',
                    t.id === selected ? 'border-mira/40 bg-white/6' : 'border-line bg-white/[0.03]',
                  )}
                  data-terminal-id={t.id}
                  data-terminal-kind={t.kind}
                  data-terminal-state={t.state}
                >
                  {t.kind === 'claude' ? <Bot className="size-4 shrink-0 text-mira" aria-hidden /> : <SquareTerminal className="size-4 shrink-0 text-work" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">{t.title}</span>
                      <Badge tone={t.kind === 'claude' ? 'mira' : 'work'}>{KIND_LABEL[t.kind]}</Badge>
                      <PhaseBadge info={t} />
                    </div>
                    <p className="truncate font-mono text-[11px] text-faint" title={t.cwd}>
                      {t.cwd}
                    </p>
                  </div>
                  <Button size="xs" variant={t.id === selected ? 'primary' : 'outline'} onClick={() => setSelected(t.id)} aria-label={`Open ${t.title}`}>
                    {t.id === selected ? 'Open' : 'Show'}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => void remove(t.id)} aria-label={t.state === 'exited' ? `Remove ${t.title}` : `Close ${t.title} and end its process`}>
                    <X className="size-3" aria-hidden /> {t.state === 'exited' ? 'Remove' : 'Close'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {projects.length > 0 && (
          <div className="mt-3 border-t border-line pt-2">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] tracking-wide text-faint uppercase">
              <FolderOpen className="size-3" aria-hidden /> Start in a project
            </h3>
            <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto" aria-label="Projects">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-[12px]">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-muted" title={p.rootPath}>
                    {p.name}
                  </span>
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => void open('claude', p.id)} aria-label={`Open Claude here: ${p.name}`}>
                    Open Claude here
                  </Button>
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => void open('shell', p.id)} aria-label={`Open a shell in ${p.name}`}>
                    Shell here
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      {current ? (
        <Viewport key={current.id} info={current} onRemove={(id) => void remove(id)} />
      ) : (
        list.length > 0 && <p className="px-1 text-[12px] text-faint">Pick a terminal above to open it here.</p>
      )}
    </div>
  )
}
