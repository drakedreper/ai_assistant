import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isInside, isUncLike, nodeCwdFs, resolveHomeCwd, resolveProjectCwd, resolveTerminalCwd, type CwdContext } from '../src/terminal/cwd'
import { MemoryFs } from '../src/terminal/testing'

function winCtx(): { fs: MemoryFs; ctx: CwdContext } {
  const fs = new MemoryFs('win32')
  fs.addDir('C:\\Users\\Ana')
  fs.addDir('C:\\Users\\Ana\\Documents')
  fs.addDir('D:\\dev\\atlas\\src')
  fs.addDir('D:\\dev\\atlas-other')
  fs.addDir('C:\\Windows\\System32')
  fs.addFile('C:\\Users\\Ana\\notes.txt')
  const ctx: CwdContext = { platform: 'win32', home: 'C:\\Users\\Ana', projectRoots: ['D:\\dev\\atlas'], fs }
  return { fs, ctx }
}

function posixCtx(): { fs: MemoryFs; ctx: CwdContext } {
  const fs = new MemoryFs('linux')
  fs.addDir('/home/ana/projects/atlas/src')
  fs.addDir('/home/ana/projects/atlas-other')
  fs.addDir('/srv/data')
  fs.addDir('/etc')
  fs.addFile('/home/ana/file.txt')
  const ctx: CwdContext = { platform: 'linux', home: '/home/ana', projectRoots: ['/srv/data'], fs }
  return { fs, ctx }
}

describe('isUncLike', () => {
  it('flags UNC and device paths', () => {
    for (const p of ['\\\\server\\share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '//server/share', '\\\\?\\UNC\\server\\share\\x']) expect(isUncLike(p, 'win32'), p).toBe(true)
    expect(isUncLike('\\\\server\\share', 'linux')).toBe(true)
  })
  it('does not flag ordinary paths, and a double slash on POSIX is just a path', () => {
    for (const p of ['C:\\Users\\Ana', 'C:/Users/Ana', '\\Users']) expect(isUncLike(p, 'win32'), p).toBe(false)
    expect(isUncLike('//srv/data', 'linux')).toBe(false)
  })
})

describe('isInside', () => {
  it('is boundary safe and case insensitive on Windows only', () => {
    expect(isInside('C:\\Users\\Ana', 'c:\\users\\ana\\Documents', 'win32')).toBe(true)
    expect(isInside('C:\\Users\\Ana', 'C:\\Users\\Ana', 'win32')).toBe(true)
    expect(isInside('C:\\Users\\Ana', 'C:\\Users\\Anabel', 'win32')).toBe(false)
    expect(isInside('C:\\Users\\Ana', 'D:\\Users\\Ana', 'win32')).toBe(false)
    expect(isInside('/home/ana', '/home/ana/x', 'linux')).toBe(true)
    expect(isInside('/home/ana', '/home/anabel', 'linux')).toBe(false)
    expect(isInside('/home/ana', '/HOME/ANA/x', 'linux')).toBe(false)
    expect(isInside('/home/ana', '/home/ana/..hidden', 'linux')).toBe(true)
  })
})

describe('resolveTerminalCwd (Windows-style strings, in-memory file system)', () => {
  it('accepts the home folder, a subfolder and a project root, with either separator', () => {
    const { ctx } = winCtx()
    expect(resolveTerminalCwd('C:\\Users\\Ana', ctx)).toMatchObject({ ok: true, cwd: 'C:\\Users\\Ana' })
    expect(resolveTerminalCwd('C:/Users/Ana/Documents', ctx)).toMatchObject({ ok: true, cwd: 'C:\\Users\\Ana\\Documents' })
    expect(resolveTerminalCwd('D:\\dev\\atlas\\src', ctx)).toMatchObject({ ok: true, root: 'D:\\dev\\atlas' })
  })

  it('is case-insensitive and returns the canonical spelling', () => {
    const { ctx } = winCtx()
    expect(resolveTerminalCwd('c:\\USERS\\ana\\documents', ctx)).toMatchObject({ ok: true, cwd: 'C:\\Users\\Ana\\Documents' })
    expect(resolveTerminalCwd('d:\\DEV\\Atlas', ctx)).toMatchObject({ ok: true })
  })

  it('refuses folders outside every root', () => {
    const { ctx } = winCtx()
    expect(resolveTerminalCwd('C:\\Windows\\System32', ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
    expect(resolveTerminalCwd('D:\\dev\\atlas-other', ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
  })

  it('refuses UNC and device paths before touching the file system', () => {
    const { fs, ctx } = winCtx()
    let touched = 0
    const spy = { realpath: (p: string) => (touched++, fs.realpath(p)), isDirectory: (p: string) => fs.isDirectory(p) }
    for (const p of ['\\\\server\\share\\x', '//server/share/x', '\\\\?\\C:\\Users\\Ana', '\\\\?\\UNC\\server\\share', '\\\\.\\C:\\']) {
      expect(resolveTerminalCwd(p, { ...ctx, fs: spy }), p).toMatchObject({ ok: false, code: 'cwd_unc' })
    }
    expect(touched).toBe(0)
  })

  it('refuses a path that realpath resolves onto a network share', () => {
    const { fs, ctx } = winCtx()
    fs.addDir('C:\\Users\\Ana\\mapped')
    const lying = { realpath: (p: string) => (p.toLowerCase().endsWith('mapped') ? '\\\\fileserver\\share\\mapped' : fs.realpath(p)), isDirectory: () => true }
    expect(resolveTerminalCwd('C:\\Users\\Ana\\mapped', { ...ctx, fs: lying })).toMatchObject({ ok: false, code: 'cwd_unc' })
    const extended = { realpath: (p: string) => (p.toLowerCase().endsWith('mapped') ? '\\\\?\\UNC\\fileserver\\share' : fs.realpath(p)), isDirectory: () => true }
    expect(resolveTerminalCwd('C:\\Users\\Ana\\mapped', { ...ctx, fs: extended })).toMatchObject({ ok: false, code: 'cwd_unc' })
  })

  it('strips the \\\\?\\ prefix that a realpath may return for a drive path', () => {
    const { fs, ctx } = winCtx()
    const prefixed = { realpath: (p: string) => `\\\\?\\${fs.realpath(p)}`, isDirectory: (p: string) => fs.isDirectory(p) }
    expect(resolveTerminalCwd('C:\\Users\\Ana\\Documents', { ...ctx, fs: prefixed })).toMatchObject({ ok: true, cwd: 'C:\\Users\\Ana\\Documents' })
  })

  it('refuses ".." anywhere, even when it stays inside', () => {
    const { ctx } = winCtx()
    for (const p of ['C:\\Users\\Ana\\..\\..\\Windows', 'C:\\Users\\Ana\\Documents\\..', 'C:/Users/Ana/../Ana', 'D:\\dev\\atlas\\src\\..\\..\\atlas-other']) {
      expect(resolveTerminalCwd(p, ctx), p).toMatchObject({ ok: false, code: 'cwd_traversal' })
    }
  })

  it('requires a drive letter and a full path', () => {
    const { ctx } = winCtx()
    for (const p of ['Users\\Ana', '\\Users\\Ana', 'C:Users', '.\\x', 'C:', '~']) {
      expect(resolveTerminalCwd(p, ctx), p).toMatchObject({ ok: false, code: 'cwd_not_absolute' })
    }
  })

  it('refuses characters Windows does not allow, alternate data streams and trailing dots or spaces', () => {
    const { ctx } = winCtx()
    for (const p of ['C:\\Users\\Ana\\Docu*ments', 'C:\\Users\\Ana\\a<b', 'C:\\Users\\Ana\\Documents:stream', 'C:\\Users\\Ana\\Documents.', 'C:\\Users\\Ana\\Documents ', 'C:\\Users\\Ana\\a|b']) {
      expect(resolveTerminalCwd(p, ctx), JSON.stringify(p)).toMatchObject({ ok: false, code: 'cwd_invalid' })
    }
  })

  it('refuses empty, NUL and absurdly long input', () => {
    const { ctx } = winCtx()
    expect(resolveTerminalCwd('', ctx)).toMatchObject({ ok: false, code: 'cwd_empty' })
    expect(resolveTerminalCwd('   ', ctx)).toMatchObject({ ok: false, code: 'cwd_empty' })
    expect(resolveTerminalCwd('C:\\Users\\Ana\\a\0b', ctx)).toMatchObject({ ok: false, code: 'cwd_invalid' })
    expect(resolveTerminalCwd(`C:\\Users\\Ana\\${'a'.repeat(5000)}`, ctx)).toMatchObject({ ok: false, code: 'cwd_invalid' })
  })

  it('refuses a missing folder and a file', () => {
    const { ctx } = winCtx()
    expect(resolveTerminalCwd('C:\\Users\\Ana\\nope', ctx)).toMatchObject({ ok: false, code: 'cwd_not_found' })
    expect(resolveTerminalCwd('C:\\Users\\Ana\\notes.txt', ctx)).toMatchObject({ ok: false, code: 'cwd_not_directory' })
  })

  it('refuses a junction or symlink inside home that points outside every root', () => {
    const { fs, ctx } = winCtx()
    fs.addLink('C:\\Users\\Ana\\sneaky', 'C:\\Windows\\System32')
    expect(resolveTerminalCwd('C:\\Users\\Ana\\sneaky', ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
  })

  it('follows a link that stays inside', () => {
    const { fs, ctx } = winCtx()
    fs.addLink('C:\\Users\\Ana\\docs', 'C:\\Users\\Ana\\Documents')
    expect(resolveTerminalCwd('C:\\Users\\Ana\\docs', ctx)).toMatchObject({ ok: true, cwd: 'C:\\Users\\Ana\\Documents' })
  })

  it('never treats a drive root as a project root, and ignores roots on missing paths or UNC', () => {
    const { fs, ctx } = winCtx()
    const wide = { ...ctx, projectRoots: ['C:\\', '\\\\server\\share', 'Z:\\gone'] }
    expect(resolveTerminalCwd('C:\\Windows\\System32', wide)).toMatchObject({ ok: false, code: 'cwd_outside' })
    expect(resolveTerminalCwd('C:\\Users\\Ana', wide)).toMatchObject({ ok: true })
    expect(fs).toBeTruthy()
  })

  it('narrows to the given roots (project plus explicit folder)', () => {
    const { ctx } = winCtx()
    expect(resolveTerminalCwd('D:\\dev\\atlas\\src', ctx, ['D:\\dev\\atlas'])).toMatchObject({ ok: true })
    expect(resolveTerminalCwd('C:\\Users\\Ana', ctx, ['D:\\dev\\atlas'])).toMatchObject({ ok: false, code: 'cwd_outside' })
  })
})

describe('resolveTerminalCwd (POSIX strings, in-memory file system)', () => {
  it('accepts home, a project root and below', () => {
    const { ctx } = posixCtx()
    expect(resolveTerminalCwd('/home/ana/projects/atlas/src', ctx)).toMatchObject({ ok: true })
    expect(resolveTerminalCwd('/srv/data', ctx)).toMatchObject({ ok: true, root: '/srv/data' })
  })
  it('is case-sensitive', () => {
    const { ctx } = posixCtx()
    expect(resolveTerminalCwd('/HOME/ana', ctx)).toMatchObject({ ok: false, code: 'cwd_not_found' })
  })
  it('refuses outside, traversal, relative, UNC-looking and files', () => {
    const { ctx } = posixCtx()
    expect(resolveTerminalCwd('/etc', ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
    expect(resolveTerminalCwd('/home/ana/../../etc', ctx)).toMatchObject({ ok: false, code: 'cwd_traversal' })
    expect(resolveTerminalCwd('projects', ctx)).toMatchObject({ ok: false, code: 'cwd_not_absolute' })
    expect(resolveTerminalCwd('\\\\host\\share', ctx)).toMatchObject({ ok: false, code: 'cwd_unc' })
    expect(resolveTerminalCwd('/home/ana/file.txt', ctx)).toMatchObject({ ok: false, code: 'cwd_not_directory' })
  })
  it('refuses a symlink that escapes a root', () => {
    const { fs, ctx } = posixCtx()
    fs.addLink('/home/ana/projects/atlas/out', '/etc')
    expect(resolveTerminalCwd('/home/ana/projects/atlas/out', ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
  })
  it('works when the home folder itself is a symlink', () => {
    const fs = new MemoryFs('linux')
    fs.addDir('/data/users/ana/work')
    fs.addLink('/home/ana', '/data/users/ana')
    const ctx: CwdContext = { platform: 'linux', home: '/home/ana', projectRoots: [], fs }
    expect(resolveTerminalCwd('/home/ana/work', ctx)).toMatchObject({ ok: true, cwd: '/data/users/ana/work' })
  })
  it('never accepts "/" as a root', () => {
    const { ctx } = posixCtx()
    expect(resolveTerminalCwd('/etc', { ...ctx, projectRoots: ['/'] })).toMatchObject({ ok: false, code: 'cwd_outside' })
  })
})

describe('project and home starting folders', () => {
  it('uses a project root as is, refusing a missing one, a file and a filesystem root', () => {
    const { ctx } = winCtx()
    expect(resolveProjectCwd('D:\\dev\\atlas', ctx)).toMatchObject({ ok: true, cwd: 'D:\\dev\\atlas' })
    expect(resolveProjectCwd('D:\\dev\\gone', ctx)).toMatchObject({ ok: false, code: 'cwd_not_found' })
    expect(resolveProjectCwd('C:\\Users\\Ana\\notes.txt', ctx)).toMatchObject({ ok: false, code: 'cwd_not_directory' })
    expect(resolveProjectCwd('C:\\', ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
    expect(resolveProjectCwd('\\\\server\\share', ctx)).toMatchObject({ ok: false, code: 'cwd_unc' })
  })
  it('resolves the home folder as the default', () => {
    expect(resolveHomeCwd(winCtx().ctx)).toMatchObject({ ok: true, cwd: 'C:\\Users\\Ana' })
    expect(resolveHomeCwd(posixCtx().ctx)).toMatchObject({ ok: true, cwd: '/home/ana' })
    expect(resolveHomeCwd({ ...posixCtx().ctx, home: '/nope' })).toMatchObject({ ok: false, code: 'cwd_not_found' })
  })
})

describe('resolveTerminalCwd against the real file system', () => {
  const base = mkdtempSync(join(tmpdir(), 'term-cwd-'))
  const home = join(base, 'home')
  const project = join(base, 'proj')
  const outside = join(base, 'outside')
  for (const d of [join(home, 'a'), join(project, 'sub'), outside]) mkdirSync(d, { recursive: true })
  let linkOk = true
  try {
    symlinkSync(outside, join(home, 'escape'), 'dir')
    symlinkSync(join(home, 'a'), join(home, 'inner'), 'dir')
  } catch {
    linkOk = false
  }
  afterAll(() => rmSync(base, { recursive: true, force: true }))
  const ctx: CwdContext = { platform: process.platform, home: realpathSync(home), projectRoots: [project], fs: nodeCwdFs }

  it('accepts folders inside home and a project, refuses outside', () => {
    expect(resolveTerminalCwd(join(home, 'a'), ctx)).toMatchObject({ ok: true })
    expect(resolveTerminalCwd(join(project, 'sub'), ctx)).toMatchObject({ ok: true })
    expect(resolveTerminalCwd(outside, ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
  })
  it.skipIf(process.platform === 'win32')('refuses a real symlink that escapes and follows one that stays inside', () => {
    expect(linkOk).toBe(true)
    expect(resolveTerminalCwd(join(home, 'escape'), ctx)).toMatchObject({ ok: false, code: 'cwd_outside' })
    expect(resolveTerminalCwd(join(home, 'inner'), ctx)).toMatchObject({ ok: true, cwd: realpathSync(join(home, 'a')) })
  })
  it('reports missing folders and files', () => {
    expect(resolveTerminalCwd(join(home, 'missing'), ctx)).toMatchObject({ ok: false, code: 'cwd_not_found' })
  })
})
