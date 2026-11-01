import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StageStore, openStore } from '../src/store'
import { makeTmp } from './helpers'

const MARKER = 'zx-forget-marker-7f3a91c2d4e8b605'

describe('forgetting is real in the database file (docs/PRIVACY.md section 10)', () => {
  it('openStore turns secure_delete on', () => {
    const s = openStore({ file: ':memory:' })
    try {
      expect(s.db.pragma('secure_delete', { simple: true })).toBe(1)
    } finally {
      s.close()
    }
  })

  it('a forgotten memory is overwritten in the file, not just unlinked; the control shows the text would otherwise linger', () => {
    const tmp = makeTmp('forget-')
    try {
      const scenario = (name: string, secure: boolean): Buffer => {
        const file = join(tmp.dir, name)
        const store = openStore({ file })
        if (!secure) store.db.pragma('secure_delete = OFF') // the control: SQLite's own default
        const repo = new StageStore(store).memoryRepo()
        repo.insert({ id: 'mem.x', kind: 'episode', text: `${MARKER} with some words around it`, importance: 3, sensitivity: 'normal', tags: [], createdAt: 1, updatedAt: 1, recallCount: 0 })
        expect(repo.get('mem.x')?.text).toContain(MARKER)
        expect(repo.delete('mem.x')).toBe(true)
        expect(repo.get('mem.x')).toBeUndefined()
        store.close() // the last connection closing checkpoints the write-ahead log into the main file
        return readFileSync(file)
      }
      const on = scenario('on.db', true)
      const off = scenario('off.db', false)
      expect(
        off.includes(MARKER),
        'control: with secure_delete OFF the deleted text should still sit in the file. If this fails on some platform, that SQLite build zeroes deleted rows by default and the assertion below proves nothing there.',
      ).toBe(true)
      expect(on.includes(MARKER), 'the deleted text is still in the database file').toBe(false)
    } finally {
      tmp.cleanup()
    }
  })

  it('a running daemon: the write-ahead log still holds the old page until scrub() truncates it (control, then the fix)', () => {
    const tmp = makeTmp('forget-wal-')
    try {
      const scenario = (name: string, scrub: boolean): { main: Buffer; wal: Buffer } => {
        const file = join(tmp.dir, name)
        const store = openStore({ file })
        try {
          const stage = new StageStore(store)
          const repo = stage.memoryRepo()
          repo.insert({ id: 'mem.x', kind: 'episode', text: `${MARKER} with some words around it`, importance: 3, sensitivity: 'normal', tags: [], createdAt: 1, updatedAt: 1, recallCount: 0 })
          expect(repo.delete('mem.x')).toBe(true)
          if (scrub) stage.scrub()
          // read while the connection is still open: this is what a running daemon looks like
          return { main: readFileSync(file), wal: existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`) : Buffer.alloc(0) }
        } finally {
          store.close()
        }
      }
      const kept = scenario('kept.db', false)
      const scrubbed = scenario('scrubbed.db', true)
      expect(
        kept.wal.includes(MARKER) || kept.main.includes(MARKER),
        'control: without scrub() the older page image with the text should still sit in the write-ahead log',
      ).toBe(true)
      expect(scrubbed.main.includes(MARKER), 'the deleted text is still in the database file').toBe(false)
      expect(scrubbed.wal.includes(MARKER), 'the deleted text is still in the write-ahead log').toBe(false)
    } finally {
      tmp.cleanup()
    }
  })

  it('scrub() is harmless on an in-memory database', () => {
    const s = openStore({ file: ':memory:' })
    try {
      expect(() => new StageStore(s).scrub()).not.toThrow()
    } finally {
      s.close()
    }
  })
})
