import * as nodePath from 'node:path'
import type { TerminalServerMessage } from '@ai-assistant/shared'
import type { CwdFs } from './cwd'
import type { TreeKiller } from './kill'
import type { LaunchFs } from './launch'
import type { PtyFactory, PtyLike, PtySpawnSpec } from './pty'
import type { TerminalSink } from './service'

/**
 * Test support for the terminal feature: a fake PTY and factory, a recording sink, a fake tree killer and an
 * in-memory file system that understands Windows-style paths and symlinks. Production code never imports this.
 */

export class FakePty implements PtyLike {
  readonly written: string[] = []
  readonly resizes: Array<[number, number]> = []
  killCalls = 0
  exited = false
  /** Echo written text back as output (like a tty in cooked mode). */
  echo = false
  /** When set, kill() makes the process exit with this code (a well-behaved child). Undefined: it ignores kill(). */
  exitOnKill: number | undefined = 0
  private dataListeners: Array<(d: string | Uint8Array) => void> = []
  private exitListeners: Array<(e: { exitCode: number | null; signal?: number }) => void> = []

  constructor(
    readonly pid: number,
    readonly spec: PtySpawnSpec,
  ) {}

  onData(l: (d: string | Uint8Array) => void): void {
    this.dataListeners.push(l)
  }
  onExit(l: (e: { exitCode: number | null; signal?: number }) => void): void {
    this.exitListeners.push(l)
  }
  write(data: string): void {
    this.written.push(data)
    if (this.echo) this.emit(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }
  kill(): void {
    this.killCalls++
    if (this.exitOnKill !== undefined) this.exit(this.exitOnKill)
  }

  /** Output from the "process". */
  emit(data: string | Uint8Array): void {
    for (const l of this.dataListeners) l(data)
  }
  exit(exitCode: number | null, signal?: number): void {
    if (this.exited) return
    this.exited = true
    for (const l of this.exitListeners) l({ exitCode, ...(signal !== undefined ? { signal } : {}) })
  }
  get text(): string {
    return this.written.join('')
  }
}

export interface FakePtyFactory {
  factory: PtyFactory
  ptys: FakePty[]
  specs: PtySpawnSpec[]
  /** Make the next spawn fail with this error. */
  failNext(err: Error): void
  last(): FakePty
}

export function createFakePtyFactory(firstPid = 4100): FakePtyFactory {
  const ptys: FakePty[] = []
  const specs: PtySpawnSpec[] = []
  let next = firstPid
  let failure: Error | undefined
  return {
    ptys,
    specs,
    failNext: (err) => void (failure = err),
    last: () => ptys[ptys.length - 1] as FakePty,
    factory: (spec) => {
      if (failure) {
        const e = failure
        failure = undefined
        throw e
      }
      specs.push(spec)
      const p = new FakePty(next++, spec)
      ptys.push(p)
      return p
    },
  }
}

/** Records the calls and (by default) makes the matching fake pty exit, like a real tree kill would. */
export class FakeKiller implements TreeKiller {
  readonly terminated: number[] = []
  readonly forced: number[] = []
  readonly forcedSync: number[] = []
  constructor(private readonly ptys: () => FakePty[] = () => [], private readonly exitOn: 'terminate' | 'force' | 'never' = 'terminate') {}
  async terminate(pid: number): Promise<void> {
    this.terminated.push(pid)
    if (this.exitOn === 'terminate') this.ptys().find((p) => p.pid === pid)?.exit(143)
  }
  async forceKill(pid: number): Promise<void> {
    this.forced.push(pid)
    if (this.exitOn !== 'never') this.ptys().find((p) => p.pid === pid)?.exit(137)
  }
  forceKillSync(pid: number): void {
    this.forcedSync.push(pid)
  }
}

export class RecordingSink implements TerminalSink {
  readonly chunks: Buffer[] = []
  readonly controls: TerminalServerMessage[] = []
  readonly ended: string[] = []
  /** After this many output chunks, output() returns false (a slow client). */
  failAfter = Infinity
  output(chunk: Buffer): boolean {
    if (this.chunks.length >= this.failAfter) return false
    this.chunks.push(Buffer.from(chunk))
    return true
  }
  control(msg: TerminalServerMessage): void {
    this.controls.push(msg)
  }
  end(reason: 'exited' | 'closed'): void {
    this.ended.push(reason)
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** An in-memory file system for CwdFs and LaunchFs, with Windows-style or POSIX paths and symlinks. */
export class MemoryFs implements CwdFs, LaunchFs {
  private readonly entries = new Map<string, { name: string; kind: 'dir' | 'file' | 'link'; target?: string; exec?: boolean }>()
  private readonly f: typeof nodePath.posix
  constructor(readonly platform: NodeJS.Platform = 'linux') {
    this.f = platform === 'win32' ? nodePath.win32 : nodePath.posix
  }
  private key(p: string): string {
    const r = this.f.resolve(p)
    return this.platform === 'win32' ? r.toLowerCase() : r
  }
  addDir(p: string): this {
    let cur = this.f.resolve(p)
    for (;;) {
      if (!this.entries.has(this.key(cur))) this.entries.set(this.key(cur), { name: cur, kind: 'dir' })
      const up = this.f.dirname(cur)
      if (up === cur) break
      cur = up
    }
    return this
  }
  addFile(p: string, exec = true): this {
    this.addDir(this.f.dirname(this.f.resolve(p)))
    this.entries.set(this.key(p), { name: this.f.resolve(p), kind: 'file', exec })
    return this
  }
  addLink(link: string, target: string): this {
    this.addDir(this.f.dirname(this.f.resolve(link)))
    this.entries.set(this.key(link), { name: this.f.resolve(link), kind: 'link', target })
    return this
  }
  /** Resolve symlinks component by component; the canonical spelling of each existing entry is returned. */
  realpath(p: string, depth = 0): string {
    if (depth > 40) throw new Error('ELOOP')
    const abs = this.f.resolve(p)
    const root = this.f.parse(abs).root
    const rest = abs.slice(root.length).split(this.f.sep).filter(Boolean)
    let cur = root
    for (let i = 0; i < rest.length; i++) {
      const next = this.f.join(cur, rest[i] as string)
      const e = this.entries.get(this.key(next))
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (e.kind === 'link') {
        const resolved = this.f.resolve(this.f.dirname(next), e.target as string)
        return this.realpath(this.f.join(resolved, ...rest.slice(i + 1)), depth + 1)
      }
      cur = e.name
    }
    if (!this.entries.has(this.key(cur))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return cur
  }
  isDirectory(p: string): boolean {
    return this.entries.get(this.key(p))?.kind === 'dir'
  }
  isFile(p: string): boolean {
    return this.entries.get(this.key(p))?.kind === 'file'
  }
  isExecutable(p: string): boolean {
    const e = this.entries.get(this.key(p))
    return e?.kind === 'file' && e.exec === true
  }
}
