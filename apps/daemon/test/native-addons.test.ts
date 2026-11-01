import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Why this file exists. On a Windows PC without a C++ toolchain, `pnpm install` once died at
 * `better-sqlite3 install$ node-gyp rebuild`: pnpm-workspace.yaml allowed better-sqlite3 to build, and pnpm runs
 * node-gyp for any allowed package that has a binding.gyp. The build was never needed, because the package ships
 * prebuilt binaries in its npm tarball and loads them before it looks at build/. The tests below keep it that way:
 * the policy stays as it is, and a dependency bump that stops shipping the binaries fails here, not on the next install.
 */

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** The top-level string lists of pnpm-workspace.yaml, enough for the build-script settings without a YAML dependency. */
function topLevelLists(yaml: string): Record<string, string[]> {
  const lists: Record<string, string[]> = {}
  let key: string | null = null
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '')
    if (/^\s*(#.*)?$/.test(line)) continue
    const top = /^([A-Za-z][\w-]*):\s*$/.exec(line)
    if (top) {
      key = top[1] ?? null
      if (key) lists[key] = []
      continue
    }
    const item = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/.exec(line)
    if (item && key) {
      lists[key]?.push(item[1] ?? '')
      continue
    }
    key = null
  }
  return lists
}

function installPolicyProblems(yaml: string): string[] {
  const lists = topLevelLists(yaml)
  const allowed = lists.onlyBuiltDependencies ?? []
  const problems: string[] = []
  if (allowed.includes('better-sqlite3')) {
    problems.push(
      'better-sqlite3 is in onlyBuiltDependencies: pnpm would run `node-gyp rebuild` for it, which fails on a PC without a C++ toolchain, and the package ships prebuilt binaries anyway',
    )
  }
  if (!(lists.ignoredBuiltDependencies ?? []).includes('better-sqlite3')) {
    problems.push('better-sqlite3 should be in ignoredBuiltDependencies so pnpm skips it without an "ignored build scripts" notice')
  }
  if (!allowed.includes('node-pty')) {
    problems.push('node-pty must stay in onlyBuiltDependencies: Linux has no node-pty prebuilds (it compiles there) and macOS needs its post-install step')
  }
  return problems
}

function packageRoot(name: string): string {
  return path.resolve(path.dirname(require.resolve(name)), '..')
}

/** What kind of executable a file is, from its header: ELF, Mach-O, or a Windows PE with its machine type. */
function binaryKind(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(1024)
    const n = readSync(fd, head, 0, head.length, 0)
    if (n >= 4 && head[0] === 0x7f && head.toString('latin1', 1, 4) === 'ELF') return 'elf'
    if (n >= 4 && (head.readUInt32LE(0) === 0xfeedfacf || head.readUInt32BE(0) === 0xcafebabe)) return 'macho'
    if (n >= 64 && head[0] === 0x4d && head[1] === 0x5a) {
      const peOffset = head.readUInt32LE(0x3c)
      if (peOffset + 6 <= n && head.toString('latin1', peOffset, peOffset + 4) === 'PE\0\0') {
        const machine = head.readUInt16LE(peOffset + 4)
        return machine === 0x8664 ? 'pe-x64' : machine === 0xaa64 ? 'pe-arm64' : `pe-0x${machine.toString(16)}`
      }
    }
    return 'unknown'
  } finally {
    closeSync(fd)
  }
}

describe('install policy (pnpm-workspace.yaml)', () => {
  it('lets pnpm skip the better-sqlite3 build and keeps node-pty building', () => {
    const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
    expect(installPolicyProblems(yaml)).toEqual([])
  })

  it('the check itself flags the policy that broke Windows installs', () => {
    const old = 'onlyBuiltDependencies:\n  - esbuild\n  - better-sqlite3\n  - node-pty\n'
    const problems = installPolicyProblems(old)
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('better-sqlite3 is in onlyBuiltDependencies')
    expect(problems[1]).toContain('ignoredBuiltDependencies')
  })

  it('reads lists with comments and quotes the way the real file has them', () => {
    const yaml = 'packages:\n  - "apps/*"\n\nonlyBuiltDependencies:\n  - esbuild # a comment\n  - node-pty\n\n# note\nignoredBuiltDependencies:\n  - better-sqlite3\n'
    expect(topLevelLists(yaml)).toEqual({
      packages: ['apps/*'],
      onlyBuiltDependencies: ['esbuild', 'node-pty'],
      ignoredBuiltDependencies: ['better-sqlite3'],
    })
  })
})

describe('better-sqlite3 ships the binaries we no longer compile', () => {
  const dir = packageRoot('better-sqlite3')
  const expected: Record<string, string> = {
    'win32-x64': 'pe-x64',
    'win32-arm64': 'pe-arm64',
    'darwin-x64': 'macho',
    'darwin-arm64': 'macho',
    'linux-x64': 'elf',
    'linux-arm64': 'elf',
  }
  for (const [target, kind] of Object.entries(expected)) {
    it(`${target}: a ${kind} binary`, () => {
      const file = path.join(dir, 'prebuilds', `${target}.node`)
      const hint = `better-sqlite3 no longer ships prebuilds/${target}.node. Either pin the old version or allow it to build again (that needs a C++ toolchain on Windows) and say so in docs/PC-BRINGUP.md.`
      expect(existsSync(file), hint).toBe(true)
      expect(statSync(file).size, `${target}.node is suspiciously small`).toBeGreaterThan(100_000)
      expect(binaryKind(file), `${target}.node is not a ${kind} executable`).toBe(kind)
    })
  }
})

describe('node-pty ships what Windows and macOS need without a compiler', () => {
  const dir = packageRoot('node-pty')

  it('prebuild directories for win32 and darwin (its install script compiles only when one is missing)', () => {
    for (const target of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']) {
      expect(existsSync(path.join(dir, 'prebuilds', target)), `node-pty has no prebuilds/${target}`).toBe(true)
    }
  })

  it('win32-x64: the ConPTY addons are x64 Windows binaries and the console host files are present', () => {
    const win = path.join(dir, 'prebuilds', 'win32-x64')
    for (const name of ['pty.node', 'conpty.node', 'conpty_console_list.node']) {
      expect(binaryKind(path.join(win, name)), `${name} is not a Windows x64 binary`).toBe('pe-x64')
    }
    for (const name of ['winpty.dll', 'winpty-agent.exe', path.join('conpty', 'conpty.dll'), path.join('conpty', 'OpenConsole.exe')]) {
      expect(existsSync(path.join(win, name)), `prebuilds/win32-x64/${name} is missing`).toBe(true)
    }
  })

  it('its post-install step finds the conpty files it copies on Windows (without them `pnpm install` fails)', () => {
    const versions = readdirSync(path.join(dir, 'third_party', 'conpty'))
    expect(versions.length).toBeGreaterThan(0)
    for (const arch of ['win10-x64', 'win10-arm64']) {
      for (const name of ['conpty.dll', 'OpenConsole.exe']) {
        expect(existsSync(path.join(dir, 'third_party', 'conpty', versions[0] ?? '', arch, name)), `third_party/conpty/${versions[0]}/${arch}/${name} is missing`).toBe(true)
      }
    }
  })
})
