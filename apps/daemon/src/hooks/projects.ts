import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import * as nodePath from 'node:path'
import type { Project } from '@ai-assistant/shared'

/** Colours for project chips, picked deterministically from the project id. */
export const PROJECT_PALETTE = ['#fbbf24', '#f472b6', '#60a5fa', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#f87171', '#a3e635', '#e879f9']

export const UNASSIGNED_PROJECT: Project = {
  id: 'unassigned',
  name: 'Unassigned sessions',
  rootPath: '',
  status: 'active',
  tags: ['hooks'],
  color: '#94a3b8',
}

/** Windows drive paths and UNC paths use win32 rules even when the daemon itself runs elsewhere (tests, WSL). */
const WIN_STYLE = /^(?:[A-Za-z]:[\\/]|\\\\)/

export function pathApiFor(p: string): typeof nodePath.win32 {
  return WIN_STYLE.test(p) ? nodePath.win32 : nodePath.posix
}

/** Case, separator and trailing-slash insensitive key for a path (Windows paths are case-insensitive). */
export function normalizePathKey(p: string): string {
  if (WIN_STYLE.test(p)) {
    const n = nodePath.win32.normalize(p).replace(/[\\/]+$/, '')
    return n.toLowerCase()
  }
  const n = nodePath.posix.normalize(p)
  return n.length > 1 ? n.replace(/\/+$/, '') : n
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'project'

export interface FsLike {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  isDirectory(path: string): boolean
}

export const realFs: FsLike = {
  existsSync,
  readFileSync: (p, e) => readFileSync(p, e),
  isDirectory(p) {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  },
}

export interface ResolvedProject {
  project: Project
  /** Folder the session runs in as reported by Claude Code. */
  cwd: string
}

export interface ProjectResolver {
  resolve(cwd: string | undefined): ResolvedProject
  /** Current git branch of `cwd`, read from .git/HEAD. Undefined when not a repo or detached. */
  branch(cwd: string | undefined): string | undefined
}

/**
 * Maps a session's cwd to a project: the git root when one can be found on disk, otherwise the folder itself.
 * The id is stable (folder name plus a short hash of the normalised path), the colour comes from a fixed palette.
 */
export function createProjectResolver(fs: FsLike = realFs): ProjectResolver {
  const gitRootCache = new Map<string, string | null>()

  function findGitRoot(cwd: string): string | null {
    const cached = gitRootCache.get(cwd)
    if (cached !== undefined) return cached
    const api = pathApiFor(cwd)
    let dir = api.normalize(cwd)
    let found: string | null = null
    for (let i = 0; i < 40; i++) {
      try {
        if (fs.existsSync(api.join(dir, '.git'))) {
          found = dir
          break
        }
      } catch {
        break
      }
      const parent = api.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    if (gitRootCache.size > 500) gitRootCache.clear()
    gitRootCache.set(cwd, found)
    return found
  }

  function makeProject(root: string): Project {
    const api = pathApiFor(root)
    const name = api.basename(root.replace(/[\\/]+$/, '')) || root
    const hash = createHash('sha1').update(normalizePathKey(root)).digest('hex')
    const id = `p-${slug(name)}-${hash.slice(0, 6)}`
    const color = PROJECT_PALETTE[parseInt(hash.slice(6, 10), 16) % PROJECT_PALETTE.length] ?? PROJECT_PALETTE[0]!
    return { id, name, rootPath: root, status: 'active', tags: ['hooks'], color }
  }

  return {
    resolve(cwd) {
      if (!cwd || !cwd.trim()) return { project: UNASSIGNED_PROJECT, cwd: '' }
      const root = findGitRoot(cwd) ?? cwd.replace(/[\\/]+$/, '')
      return { project: makeProject(root.length > 0 ? root : cwd), cwd }
    },
    branch(cwd) {
      if (!cwd) return undefined
      const root = findGitRoot(cwd)
      if (!root) return undefined
      const api = pathApiFor(root)
      try {
        const dotGit = api.join(root, '.git')
        let gitDir = dotGit
        if (!fs.isDirectory(dotGit)) {
          // A worktree or submodule: `.git` is a file containing "gitdir: <path>".
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))
          if (!m?.[1]) return undefined
          gitDir = api.resolve(root, m[1].trim())
        }
        const head = fs.readFileSync(api.join(gitDir, 'HEAD'), 'utf8')
        const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)
        return ref?.[1]?.trim() || undefined
      } catch {
        return undefined
      }
    },
  }
}
