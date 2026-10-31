import { describe, expect, it } from 'vitest'
import { LaunchError, findOnPath, parseCommandOverride, resolveClaudeLaunch, resolveShellLaunch, windowsExtensions, wrapBatch } from '../src/terminal/launch'
import { createTreeKiller, taskkillPath } from '../src/terminal/kill'
import { MemoryFs } from '../src/terminal/testing'

describe('claude resolution on Windows', () => {
  const winFs = () => new MemoryFs('win32')

  it('finds claude.exe on PATH', () => {
    const fs = winFs().addFile('C:\\Users\\Ana\\.local\\bin\\claude.exe')
    const env = { Path: 'C:\\Windows\\System32;C:\\Users\\Ana\\.local\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(resolveClaudeLaunch({ env, platform: 'win32', fs })).toEqual({ kind: 'claude', file: 'C:\\Users\\Ana\\.local\\bin\\claude.exe', args: [], title: 'Claude Code' })
  })

  it('prefers claude.exe over a claude.cmd shim in the same folder', () => {
    const fs = winFs().addFile('C:\\npm\\claude.cmd').addFile('C:\\npm\\claude.exe')
    expect(resolveClaudeLaunch({ env: { PATH: 'C:\\npm' }, platform: 'win32', fs }).file).toBe('C:\\npm\\claude.exe')
  })

  it('wraps claude.cmd in cmd.exe with the documented quoting', () => {
    const fs = winFs().addFile('C:\\Users\\Ana\\AppData\\Roaming\\npm\\claude.cmd').addFile('C:\\Windows\\System32\\cmd.exe')
    const spec = resolveClaudeLaunch({ env: { PATH: 'C:\\Users\\Ana\\AppData\\Roaming\\npm', SystemRoot: 'C:\\Windows' }, platform: 'win32', fs })
    expect(spec.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(spec.args).toBe('/d /s /c ""C:\\Users\\Ana\\AppData\\Roaming\\npm\\claude.cmd""')
  })

  it('honours a quoted PATH entry, ignores relative and empty entries, and PATHEXT order', () => {
    const fs = winFs().addFile('C:\\Program Files\\Claude\\claude.exe').addFile('C:\\cwd\\claude.exe')
    const env = { PATH: ';.;bin;"C:\\Program Files\\Claude"' }
    expect(findOnPath('claude', env, 'win32', fs)).toBe('C:\\Program Files\\Claude\\claude.exe')
    expect(findOnPath('claude', { PATH: ';.;bin' }, 'win32', fs)).toBeUndefined()
    expect(windowsExtensions({ PATHEXT: '.COM;.CMD;.EXE;.VBS;.JS' })).toEqual(['.exe', '.com', '.cmd'])
    expect(windowsExtensions({})).toEqual(['.exe', '.com', '.bat', '.cmd'])
  })

  it('ignores PowerShell scripts: claude.ps1 cannot be started by CreateProcess', () => {
    const fs = winFs().addFile('C:\\npm\\claude.ps1')
    expect(() => resolveClaudeLaunch({ env: { PATH: 'C:\\npm' }, platform: 'win32', fs })).toThrow(LaunchError)
  })

  it('uses CLAUDE_EXECUTABLE, adding the extension when it is missing', () => {
    const fs = winFs().addFile('D:\\tools\\claude\\claude.exe')
    expect(resolveClaudeLaunch({ env: {}, platform: 'win32', fs, claudeExecutable: 'D:\\tools\\claude\\claude.exe' }).file).toBe('D:\\tools\\claude\\claude.exe')
    expect(resolveClaudeLaunch({ env: {}, platform: 'win32', fs, claudeExecutable: 'D:\\tools\\claude\\claude' }).file).toBe('D:\\tools\\claude\\claude.exe')
  })

  it('refuses a CLAUDE_EXECUTABLE that is missing or relative, with help text', () => {
    const fs = winFs()
    for (const claudeExecutable of ['D:\\gone\\claude.exe', 'claude.exe']) {
      try {
        resolveClaudeLaunch({ env: { PATH: 'C:\\x' }, platform: 'win32', fs, claudeExecutable })
        throw new Error('expected a LaunchError')
      } catch (err) {
        expect(err).toBeInstanceOf(LaunchError)
        expect((err as LaunchError).code).toBe('claude_not_found')
        expect((err as LaunchError).message).toMatch(/CLAUDE_EXECUTABLE/)
      }
    }
  })

  it('reports claude_not_found with install help when nothing is on PATH', () => {
    try {
      resolveClaudeLaunch({ env: { PATH: 'C:\\Windows' }, platform: 'win32', fs: winFs() })
      throw new Error('expected a LaunchError')
    } catch (err) {
      expect((err as LaunchError).code).toBe('claude_not_found')
      expect((err as LaunchError).message).toMatch(/claude\.exe/)
      expect((err as LaunchError).message).toMatch(/CLAUDE_EXECUTABLE/)
    }
  })

  it('refuses to hand cmd.exe a path with a quote or a percent sign', () => {
    const fs = winFs().addFile('C:\\100%\\claude.cmd')
    expect(() => wrapBatch('C:\\100%\\claude.cmd', {}, fs, 'claude_not_found')).toThrow(LaunchError)
    expect(() => wrapBatch('C:\\a"b\\claude.cmd', {}, fs, 'claude_not_found')).toThrow(LaunchError)
  })
})

describe('claude resolution elsewhere', () => {
  it('finds an executable on PATH and ignores a non-executable file', () => {
    const fs = new MemoryFs('linux').addFile('/usr/local/bin/claude').addFile('/opt/bin/claude', false)
    expect(resolveClaudeLaunch({ env: { PATH: '/opt/bin:/usr/local/bin' }, platform: 'linux', fs }).file).toBe('/usr/local/bin/claude')
    expect(() => resolveClaudeLaunch({ env: { PATH: '/opt/bin' }, platform: 'linux', fs })).toThrow(LaunchError)
  })
  it('uses CLAUDE_EXECUTABLE when executable', () => {
    const fs = new MemoryFs('linux').addFile('/home/ana/bin/claude')
    expect(resolveClaudeLaunch({ env: {}, platform: 'linux', fs, claudeExecutable: '/home/ana/bin/claude' }).file).toBe('/home/ana/bin/claude')
    expect(() => resolveClaudeLaunch({ env: {}, platform: 'linux', fs, claudeExecutable: '/nope/claude' })).toThrow(LaunchError)
  })
})

describe('TERMINAL_CLAUDE_COMMAND (test override)', () => {
  it('beats everything and accepts a JSON array or one path', () => {
    const fs = new MemoryFs('linux')
    expect(resolveClaudeLaunch({ env: {}, platform: 'linux', fs, commandOverride: '["/usr/bin/node","/tmp/fake claude.mjs","--x"]' })).toMatchObject({ file: '/usr/bin/node', args: ['/tmp/fake claude.mjs', '--x'] })
    expect(parseCommandOverride('/tmp/fake')).toEqual({ file: '/tmp/fake', args: [] })
  })
  it('rejects malformed overrides', () => {
    for (const bad of ['[', '[]', '[1]', '[""]', '{"a":1}', '']) expect(() => parseCommandOverride(bad), bad).toThrow(LaunchError)
  })
})

describe('shell resolution', () => {
  it('Windows: System32 PowerShell first, then PATH, then COMSPEC', () => {
    const sys = new MemoryFs('win32').addFile('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe').addFile('C:\\Windows\\System32\\cmd.exe')
    expect(resolveShellLaunch({ env: { SystemRoot: 'C:\\Windows' }, platform: 'win32', fs: sys })).toMatchObject({ file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'], title: 'PowerShell' })
    const pathOnly = new MemoryFs('win32').addFile('C:\\Tools\\powershell.exe')
    expect(resolveShellLaunch({ env: { PATH: 'C:\\Tools' }, platform: 'win32', fs: pathOnly }).file).toBe('C:\\Tools\\powershell.exe')
    const cmdOnly = new MemoryFs('win32').addFile('C:\\Windows\\System32\\cmd.exe')
    expect(resolveShellLaunch({ env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, platform: 'win32', fs: cmdOnly })).toMatchObject({ file: 'C:\\Windows\\System32\\cmd.exe', title: 'Command Prompt' })
  })
  it('Windows: throws when there is no shell at all', () => {
    expect(() => resolveShellLaunch({ env: {}, platform: 'win32', fs: new MemoryFs('win32') })).toThrow(LaunchError)
  })
  it('POSIX: $SHELL when absolute and executable, else /bin/sh', () => {
    const fs = new MemoryFs('linux').addFile('/usr/bin/zsh').addFile('/bin/sh')
    expect(resolveShellLaunch({ env: { SHELL: '/usr/bin/zsh' }, platform: 'linux', fs })).toMatchObject({ file: '/usr/bin/zsh', title: 'zsh' })
    expect(resolveShellLaunch({ env: { SHELL: 'zsh' }, platform: 'linux', fs }).file).toBe('/bin/sh')
    expect(resolveShellLaunch({ env: { SHELL: '/gone/shell' }, platform: 'linux', fs }).file).toBe('/bin/sh')
    expect(resolveShellLaunch({ env: {}, platform: 'linux', fs }).file).toBe('/bin/sh')
  })
})

describe('the tree killer', () => {
  it('Windows: taskkill via execFile with an argument array, from System32, windowsHide, no shell', async () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = []
    const killer = createTreeKiller({
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      fileExists: () => true,
      execFile: (file, args, options, cb) => {
        calls.push({ file, args, options })
        cb(null)
      },
    })
    await killer.terminate(4242)
    await killer.forceKill(4242)
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.file).toBe('C:\\Windows\\System32\\taskkill.exe')
      expect(c.args).toEqual(['/PID', '4242', '/T', '/F'])
      expect(c.options).toMatchObject({ windowsHide: true })
      expect(c.options).not.toHaveProperty('shell')
    }
  })

  it('Windows: falls back to the bare name, swallows taskkill errors, refuses odd pids', async () => {
    expect(taskkillPath(undefined, () => false)).toBe('taskkill.exe')
    expect(taskkillPath('C:\\Windows', () => false)).toBe('taskkill.exe')
    const calls: Array<readonly string[]> = []
    const killer = createTreeKiller({
      platform: 'win32',
      fileExists: () => false,
      execFile: (_f, args, _o, cb) => {
        calls.push(args)
        cb(Object.assign(new Error('process not found'), { code: 128 }) as never)
      },
    })
    await expect(killer.terminate(77)).resolves.toBeUndefined()
    for (const bad of [0, 1, -5, 1.5, Number.NaN, 2 ** 60]) await killer.terminate(bad)
    expect(calls).toEqual([['/PID', '77', '/T', '/F']])
  })

  it('POSIX: SIGTERM then SIGKILL to the process GROUP (negative pid)', async () => {
    const sent: Array<[number, string]> = []
    const killer = createTreeKiller({ platform: 'linux', signal: (pid, sig) => void sent.push([pid, sig]) })
    await killer.terminate(500)
    await killer.forceKill(500)
    expect(sent).toEqual([
      [-500, 'SIGTERM'],
      [-500, 'SIGKILL'],
    ])
  })

  it('forceKillSync: Windows runs execFileSync with an argument array, POSIX signals the group', () => {
    const calls: Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }> = []
    const win = createTreeKiller({ platform: 'win32', systemRoot: 'C:\\Windows', fileExists: () => true, execFileSync: (file, args, options) => void calls.push({ file, args, options }) })
    win.forceKillSync(900)
    win.forceKillSync(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '900', '/T', '/F'], options: { windowsHide: true, stdio: 'ignore' } })
    expect(calls[0]!.options).not.toHaveProperty('shell')
    const throwing = createTreeKiller({ platform: 'win32', execFileSync: () => { throw new Error('gone') } })
    expect(() => throwing.forceKillSync(900)).not.toThrow()
    const sent: Array<[number, string]> = []
    createTreeKiller({ platform: 'linux', signal: (p, s) => void sent.push([p, s]) }).forceKillSync(77)
    expect(sent).toEqual([[-77, 'SIGKILL']])
  })

  it('POSIX: never signals pid 0 or 1 (kill(-1) would hit everything), falls back to the leader, ignores ESRCH', async () => {
    const sent: Array<[number, string]> = []
    const killer = createTreeKiller({
      platform: 'linux',
      signal: (pid, sig) => {
        sent.push([pid, sig])
        if (pid < 0 && pid !== -900) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
        if (pid === -900) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      },
    })
    await killer.terminate(0)
    await killer.terminate(1)
    expect(sent).toEqual([])
    await killer.terminate(600)
    expect(sent).toEqual([
      [-600, 'SIGTERM'],
      [600, 'SIGTERM'],
    ])
    sent.length = 0
    await killer.terminate(900)
    expect(sent).toEqual([[-900, 'SIGTERM']])
  })
})
