import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { openBrowser } from '../src/openBrowser'

const LINK = 'http://127.0.0.1:7421/?code=abc-DEF_123#tp=xyz-789_ABC'

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = []
  const child = Object.assign(new EventEmitter(), { unref: () => undefined })
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options })
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { calls, child, spawn }
}

describe('openBrowser', () => {
  it('Windows: cmd /c start with an empty title, then the address', () => {
    const f = fakeSpawn()
    expect(openBrowser(LINK, { platform: 'win32', spawn: f.spawn })).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ command: 'cmd.exe', args: ['/d', '/c', 'start', '', LINK] })
    expect(f.calls[0]?.options).toMatchObject({ stdio: 'ignore', detached: true, windowsHide: true })
  })

  it('macOS uses open and everything else xdg-open', () => {
    const mac = fakeSpawn()
    openBrowser(LINK, { platform: 'darwin', spawn: mac.spawn })
    expect(mac.calls[0]).toMatchObject({ command: 'open', args: [LINK] })
    const linux = fakeSpawn()
    openBrowser(LINK, { platform: 'linux', spawn: linux.spawn })
    expect(linux.calls[0]).toMatchObject({ command: 'xdg-open', args: [LINK] })
  })

  it('opens nothing but the daemon\'s own loopback link', () => {
    for (const url of [
      'https://127.0.0.1:7421/',
      'http://localhost:7421/',
      'http://127.0.0.1.evil.example:7421/',
      'http://evil.example/',
      'http://127.0.0.1:7421/?code=a&b=c', // an ampersand would end the command on Windows
      'http://127.0.0.1:7421/?code=a%20b',
      'file:///C:/Windows/System32/calc.exe',
      'calc.exe',
      '',
      'http://127.0.0.1:7421/ & calc',
    ]) {
      const f = fakeSpawn()
      expect(openBrowser(url, { platform: 'win32', spawn: f.spawn }), url).toBe(false)
      expect(f.calls, url).toHaveLength(0)
    }
  })

  it('never throws: a missing opener (error event) or a throwing spawn is swallowed', () => {
    const f = fakeSpawn()
    expect(openBrowser(LINK, { platform: 'linux', spawn: f.spawn })).toBe(true)
    expect(() => f.child.emit('error', new Error('spawn xdg-open ENOENT'))).not.toThrow()
    const boom = (() => {
      throw new Error('EACCES')
    }) as unknown as typeof import('node:child_process').spawn
    expect(openBrowser(LINK, { platform: 'linux', spawn: boom })).toBe(false)
  })
})
