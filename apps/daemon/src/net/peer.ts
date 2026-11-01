import { isIP } from 'node:net'

/**
 * Who is on the other end of a socket, judged by the address the daemon sees.
 *
 * The daemon normally listens on 127.0.0.1 only, so every peer is loopback. In the Docker image (container mode,
 * MIRA_CONTAINER=1) the process listens on the container's own interface and a published port reaches it: Docker (and
 * Docker Desktop on Windows) hands every connection to the container from the bridge's gateway address, a PRIVATE
 * address, never from 127.0.0.1. So in container mode a private peer is accepted as well, and a public one never is.
 * This is a lock for the stage socket (an engine process), a second lock behind the Host, Origin and token checks, not
 * the thing that keeps the daemon private: that is publishing the port on 127.0.0.1 only (docker-compose.yml does).
 */

export type PeerClass = 'loopback' | 'private' | 'public' | 'invalid'

function ipv4Class(a: string): PeerClass {
  const o = a.split('.').map(Number)
  const [o1 = -1, o2 = -1] = o
  if (o1 === 127) return 'loopback'
  if (o1 === 10) return 'private'
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return 'private'
  if (o1 === 192 && o2 === 168) return 'private'
  if (o1 === 169 && o2 === 254) return 'private' // link-local
  if (o1 === 0 || o1 >= 224) return 'invalid' // "this network", multicast, reserved, broadcast
  return 'public'
}

export function classifyPeer(address: string | undefined): PeerClass {
  if (!address) return 'invalid'
  let a = address.trim().toLowerCase()
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a)
  if (mapped?.[1]) a = mapped[1]
  const kind = isIP(a)
  if (kind === 4) return ipv4Class(a)
  if (kind === 6) {
    if (a === '::1') return 'loopback'
    if (a === '::') return 'invalid'
    const first = parseInt(a.split(':')[0] || '0', 16)
    if ((first & 0xffc0) === 0xfe80) return 'private' // fe80::/10 link-local
    if ((first & 0xfe00) === 0xfc00) return 'private' // fc00::/7 unique local
    return 'public'
  }
  return 'invalid'
}

/** Loopback always; a private address only in container mode; a public or malformed one never. */
export function peerAllowed(address: string | undefined, containerMode: boolean): boolean {
  const c = classifyPeer(address)
  return c === 'loopback' || (containerMode && c === 'private')
}

/** The container files Docker and Podman create. A hint for a warning, never a security decision. */
export function looksLikeContainer(exists: (path: string) => boolean): boolean {
  return exists('/.dockerenv') || exists('/run/.containerenv')
}
