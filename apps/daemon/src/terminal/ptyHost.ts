import type { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { FrameDecoder, FrameType, MAX_DATA_FRAME, ProtocolError, encodeFrame, parseResize, parseSpawnRequest, type Frame, type SpawnRequest } from './hostProtocol'
import { createTreeKiller, type TreeKiller } from './kill'
import { PtyUnavailableError, createNodePtyFactory, type PtyFactory, type PtyLike } from './pty'

/**
 * The PTY host: ONE process per terminal, started by the daemon, speaking the framed protocol of hostProtocol.ts over
 * its stdin and stdout. It owns exactly one PTY master descriptor, so no descriptor can leak from one terminal into
 * another (the shell never has any master: forkpty closes its own in the child, and this process has no other), and it
 * outlives the daemon just long enough to end the terminal's whole process tree when the daemon dies.
 *
 * What it does:
 *   - `spawn` starts the program on a PTY (node-pty: forkpty, or ConPTY on Windows) and answers `spawned {pid}`;
 *   - the PTY's output goes to the daemon as `data` frames, keystrokes come in as `write` frames, `resize` and `kill`
 *     are passed on, and the program's end is reported as `exit` (the host then exits too);
 *   - when the daemon's end of the pipe closes (the daemon exited, crashed or was killed, even with SIGKILL: the kernel
 *     closes its descriptors), the host ends the tree itself: polite signal, a grace period, then a hard kill of the
 *     whole family (src/terminal/kill.ts), and exits. The hang-up that closing the master causes is only a safety net:
 *     it does nothing to a process that ignores SIGHUP.
 *
 * Console signals (Ctrl+C or a closed console reach every process of the daemon's process group, this one included) are
 * ignored here: the daemon decides what happens to a terminal, and the host ends only through its input closing, its
 * program ending, or an explicit SIGTERM.
 *
 * Nothing in here logs terminal bytes. Diagnostics (stderr) are short fixed strings and error messages.
 */

export interface PtyHostDeps {
  input: Readable
  output: Writable
  ptyFactory: PtyFactory
  killer: TreeKiller
  /** The polite-to-hard grace when the SPAWN frame does not carry one. */
  defaultGraceMs?: number
  /** One line of diagnostics. Never terminal bytes. */
  diag?: (line: string) => void
  /** Called once when the host is finished (process.exit in production). */
  onDone: (code: number) => void
}

export interface PtyHostHandle {
  /** The same thing that happens when the daemon's end closes: end the tree and finish (also what SIGTERM does). */
  shutdown(reason: string): void
}

const FLUSH_FALLBACK_MS = 1000

export function runPtyHost(deps: PtyHostDeps): PtyHostHandle {
  const { input, output, killer } = deps
  const diag = deps.diag ?? (() => undefined)
  const decoder = new FrameDecoder()

  let pty: PtyLike | undefined
  let spawning = false
  let spawnedReq: SpawnRequest | undefined
  let ptyExited = false
  let daemonGone = false
  let finished = false
  let backpressured = false
  const exitWaiters: Array<() => void> = []

  const send = (frame: Buffer): boolean => {
    if (finished || output.destroyed || !output.writable) return true
    try {
      return output.write(frame)
    } catch {
      return true
    }
  }

  const finish = (code: number): void => {
    if (finished) return
    finished = true
    let called = false
    const done = (): void => {
      if (called) return
      called = true
      deps.onDone(code)
    }
    const timer = setTimeout(done, FLUSH_FALLBACK_MS)
    timer.unref?.()
    try {
      if (output.destroyed || !output.writable) return done()
      output.end(done)
    } catch {
      done()
    }
  }

  const waitExit = (ms: number): Promise<boolean> => {
    if (ptyExited) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const i = exitWaiters.indexOf(done)
        if (i >= 0) exitWaiters.splice(i, 1)
        resolve(false)
      }, ms)
      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      exitWaiters.push(done)
    })
  }

  /** The daemon is gone: end the whole tree (polite, grace, hard, sweep), then finish. */
  const endTree = async (): Promise<void> => {
    const p = pty
    if (!p) return finish(0)
    const grace = spawnedReq?.graceMs ?? deps.defaultGraceMs ?? 1500
    const pid = p.pid
    try {
      await killer.terminate(pid)
    } catch {
      /* gone */
    }
    try {
      p.kill()
    } catch {
      /* already closed */
    }
    if (!(await waitExit(grace))) {
      try {
        await killer.forceKill(pid)
        p.kill()
      } catch {
        /* gone */
      }
      await waitExit(grace)
    }
    try {
      // The leader is gone; whatever outlived the polite signal (a job that ignores SIGHUP and SIGTERM) is killed now.
      const left = await killer.reap(pid, grace)
      if (left.length > 0) diag(`${left.length} process(es) of the terminal could not be ended`)
    } catch {
      /* nothing more to do */
    }
    finish(0)
  }

  const onDaemonGone = (reason: string): void => {
    if (daemonGone) return
    daemonGone = true
    diag(`daemon gone (${reason})`)
    if (spawning && !pty) return // the spawn result handler ends the tree as soon as there is one
    if (!pty || ptyExited) return finish(0)
    void endTree()
  }

  const onPtyData = (d: string | Uint8Array): void => {
    if (ptyExited) return
    const buf = typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d.buffer, d.byteOffset, d.byteLength)
    for (let off = 0; off < buf.length; off += MAX_DATA_FRAME) {
      const ok = send(encodeFrame(FrameType.data, buf.subarray(off, Math.min(buf.length, off + MAX_DATA_FRAME))))
      if (!ok && !backpressured && pty?.pause) {
        // The daemon is not keeping up: stop reading the PTY (its program blocks) instead of queueing without bound.
        backpressured = true
        pty.pause()
        output.once('drain', () => {
          backpressured = false
          try {
            pty?.resume?.()
          } catch {
            /* closed */
          }
        })
      }
    }
  }

  const onPtyExit = (e: { exitCode: number | null; signal?: number }): void => {
    if (ptyExited) return
    ptyExited = true
    for (const w of exitWaiters.splice(0)) w()
    send(encodeFrame(FrameType.exit, { exitCode: typeof e.exitCode === 'number' ? e.exitCode : null, ...(typeof e.signal === 'number' ? { signal: e.signal } : {}) }))
    // When the daemon is gone, endTree is running and finishes after its sweep; otherwise this is the normal end.
    if (!daemonGone) finish(0)
  }

  const startPty = (req: SpawnRequest): void => {
    spawning = true
    spawnedReq = req
    let created: Promise<PtyLike>
    try {
      created = Promise.resolve(deps.ptyFactory({ file: req.file, args: req.args, cwd: req.cwd, env: req.env, cols: req.cols, rows: req.rows }))
    } catch (err) {
      created = Promise.reject(err)
    }
    created.then(
      (p) => {
        pty = p
        spawning = false
        send(encodeFrame(FrameType.spawned, { pid: p.pid }))
        p.onData(onPtyData)
        p.onExit(onPtyExit)
        if (daemonGone) void endTree()
      },
      (err: unknown) => {
        spawning = false
        const unavailable = err instanceof PtyUnavailableError
        // The message of a failed spawn names a program or a folder at most, never terminal bytes.
        send(encodeFrame(FrameType.spawnFailed, { message: (err instanceof Error ? err.message : 'spawn failed').slice(0, 300), unavailable }))
        diag(`spawn failed${unavailable ? ' (node-pty unavailable)' : ''}`)
        finish(1)
      },
    )
  }

  const handle = (f: Frame): void => {
    switch (f.type) {
      case FrameType.spawn:
        if (pty || spawning) throw new ProtocolError('a second spawn')
        return startPty(parseSpawnRequest(f.payload))
      case FrameType.write:
        if (!pty || ptyExited) return
        try {
          pty.write(f.payload.toString('utf8'))
        } catch {
          /* the pty closed under us; its exit is reported separately */
        }
        return
      case FrameType.resize: {
        const { cols, rows } = parseResize(f.payload)
        if (!pty || ptyExited) return
        try {
          pty.resize(cols, rows)
        } catch {
          /* closed */
        }
        return
      }
      case FrameType.kill:
        if (!pty || ptyExited) return
        try {
          pty.kill()
        } catch {
          /* closed */
        }
        return
      default:
        throw new ProtocolError('a frame only the host sends')
    }
  }

  input.on('data', (chunk: Buffer) => {
    if (finished) return
    try {
      for (const f of decoder.push(chunk)) handle(f)
    } catch (err) {
      diag(`protocol error: ${err instanceof Error ? err.message : 'unknown'}`)
      // A stream we cannot trust: treat it like a vanished daemon (end whatever runs, then exit).
      onDaemonGone('protocol error')
    }
  })
  input.on('end', () => onDaemonGone('input ended'))
  input.on('close', () => onDaemonGone('input closed'))
  input.on('error', () => onDaemonGone('input error'))
  // EPIPE when the daemon vanished: its closing input says the same, so just do not crash on it.
  output.on('error', () => undefined)

  return { shutdown: (reason) => onDaemonGone(reason) }
}

// ---------------------------------------------------------------- the process entry

function main(): void {
  // Console signals reach every process of the daemon's group: not this one's business.
  process.on('SIGINT', () => undefined)
  process.on('SIGHUP', () => undefined)
  // The daemon's end of stderr closes with it: a diagnostic written then must not take the process down mid cleanup.
  process.stderr.on('error', () => undefined)
  const diag = (line: string): void => {
    try {
      process.stderr.write(`pty-host: ${line}\n`)
    } catch {
      /* nobody is listening */
    }
  }
  const killer = createTreeKiller({ platform: process.platform, systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT })
  const host = runPtyHost({
    input: process.stdin,
    output: process.stdout,
    ptyFactory: createNodePtyFactory(),
    killer,
    diag,
    onDone: (code) => process.exit(code),
  })
  // An explicit SIGTERM (a person or a tool ending this process) means "clean up like the daemon had gone".
  process.on('SIGTERM', () => host.shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    diag(`uncaught: ${err instanceof Error ? err.message : 'unknown'}`)
    // State unknown: end the terminal's tree and exit, with a hard stop if that wedges.
    host.shutdown('uncaught exception')
    setTimeout(() => process.exit(1), 10_000)
  })
  process.on('unhandledRejection', (reason) => diag(`unhandled rejection: ${reason instanceof Error ? reason.message : 'unknown'}`))
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) main()
