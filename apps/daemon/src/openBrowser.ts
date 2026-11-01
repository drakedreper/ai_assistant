import { spawn as nodeSpawn } from 'node:child_process'

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform
  spawn?: typeof nodeSpawn
}

/** Only the daemon's own sign-in link: a plain http URL on 127.0.0.1 with a path, query and fragment of harmless characters. */
const OWN_LINK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\w?=#.\-/]*$/

/**
 * Open the sign-in link in the user's default browser, best effort (the link is always printed as well). Only a link of the
 * daemon's own shape is ever opened, so this can never be used to start anything else. The link holds a one-time code and the
 * terminal pairing, so it is passed as an argument and never logged.
 */
export function openBrowser(url: string, deps: OpenBrowserDeps = {}): boolean {
  if (!OWN_LINK.test(url)) return false
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? nodeSpawn
  // Windows: `start` takes the window title first, an empty string (Node passes it as ""), then the address.
  const [command, args]: [string, string[]] = platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => undefined) // no browser, no opener: the printed link is still there
    child.unref()
    return true
  } catch {
    return false
  }
}
