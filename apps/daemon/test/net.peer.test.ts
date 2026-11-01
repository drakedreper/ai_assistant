import { describe, expect, it } from 'vitest'
import { classifyPeer, looksLikeContainer, peerAllowed, type PeerClass } from '../src/net/peer'

describe('classifyPeer', () => {
  const table: Array<[string | undefined, PeerClass]> = [
    // loopback, in every spelling Node reports
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::FFFF:127.0.0.1', 'loopback'],
    // what Docker, Docker Desktop and WSL hand a container: bridge gateways and VM addresses
    ['172.17.0.1', 'private'],
    ['172.18.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.65.1', 'private'],
    ['192.168.0.10', 'private'],
    ['10.0.0.5', 'private'],
    ['::ffff:172.17.0.1', 'private'],
    ['fe80::1', 'private'],
    ['fe80::1%eth0', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['169.254.1.1', 'private'],
    // everything that is somebody else's
    ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['192.169.0.1', 'public'],
    ['100.64.0.1', 'public'], // carrier-grade NAT, Tailscale: not ours
    ['8.8.8.8', 'public'],
    ['192.0.2.2', 'public'], // a documentation range, not a private one
    ['2001:4860:4860::8888', 'public'],
    ['::ffff:8.8.8.8', 'public'],
    // nonsense is never trusted
    [undefined, 'invalid'],
    ['', 'invalid'],
    ['localhost', 'invalid'],
    ['999.1.1.1', 'invalid'],
    ['0.0.0.0', 'invalid'],
    ['::', 'invalid'],
    ['224.0.0.1', 'invalid'],
    ['255.255.255.255', 'invalid'],
    ['127.0.0.1.evil.example', 'invalid'],
    ['fe80::1; drop table', 'invalid'],
  ]
  it.each(table)('%s is %s', (address, expected) => {
    expect(classifyPeer(address)).toBe(expected)
  })
})

describe('peerAllowed', () => {
  it('outside container mode only loopback gets in (private addresses do not)', () => {
    expect(peerAllowed('127.0.0.1', false)).toBe(true)
    expect(peerAllowed('::1', false)).toBe(true)
    expect(peerAllowed('172.17.0.1', false)).toBe(false)
    expect(peerAllowed('192.168.1.5', false)).toBe(false)
    expect(peerAllowed('8.8.8.8', false)).toBe(false)
    expect(peerAllowed(undefined, false)).toBe(false)
  })

  it('in container mode loopback and private addresses get in, public and malformed ones never', () => {
    expect(peerAllowed('127.0.0.1', true)).toBe(true)
    expect(peerAllowed('172.17.0.1', true)).toBe(true)
    expect(peerAllowed('192.168.65.1', true)).toBe(true)
    expect(peerAllowed('fd00::5', true)).toBe(true)
    expect(peerAllowed('8.8.8.8', true)).toBe(false)
    expect(peerAllowed('100.64.0.1', true)).toBe(false)
    expect(peerAllowed('2001:db8::1', true)).toBe(false)
    expect(peerAllowed('', true)).toBe(false)
    expect(peerAllowed(undefined, true)).toBe(false)
    expect(peerAllowed('localhost', true)).toBe(false)
  })
})

describe('looksLikeContainer', () => {
  it('is true for the files Docker and Podman create, false without them', () => {
    expect(looksLikeContainer((p) => p === '/.dockerenv')).toBe(true)
    expect(looksLikeContainer((p) => p === '/run/.containerenv')).toBe(true)
    expect(looksLikeContainer(() => false)).toBe(false)
  })
})
