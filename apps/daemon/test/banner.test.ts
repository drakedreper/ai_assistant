import { describe, expect, it } from 'vitest'
import { formatBanner, type BannerInfo } from '../src/banner'

const base: BannerInfo = {
  version: '1.2.3',
  port: 7421,
  exchangeUrl: 'http://127.0.0.1:7421/?code=abc',
  exchangeTtlMinutes: 15,
  dataDir: 'C:\\Users\\you\\AppData\\Roaming\\ai-assistant',
  backend: 'fake',
  authMode: 'api-key',
  apiKeyPresent: false,
  demo: false,
  webBuilt: true,
}

describe('startup banner', () => {
  it('prints the one-time sign-in link, the data dir and a loud FAKE warning for the fake backend', () => {
    const text = formatBanner(base).join('\n')
    expect(text).toContain('Mira daemon 1.2.3')
    expect(text).toContain('http://127.0.0.1:7421/?code=abc')
    expect(text).toContain('only one time')
    expect(text).toContain('C:\\Users\\you\\AppData\\Roaming\\ai-assistant')
    expect(text).toContain('FAKE')
    expect(text).toContain('zero tokens')
    expect(text).not.toContain('Web UI      not built')
  })

  it('names the sdk backend and warns when the API key is missing, without ever printing a key', () => {
    const missing = formatBanner({ ...base, backend: 'sdk' }).join('\n')
    expect(missing).not.toContain('FAKE')
    expect(missing).toContain('API key NOT SET')
    expect(missing).toContain('WARNING')
    const set = formatBanner({ ...base, backend: 'sdk', apiKeyPresent: true }).join('\n')
    expect(set).toContain('API key set')
    expect(set).not.toContain('WARNING')
    const local = formatBanner({ ...base, backend: 'sdk', authMode: 'local-login' }).join('\n')
    expect(local).toContain('local-login')
    expect(local).not.toContain('API key')
  })

  it('mentions demo mode and a missing web build', () => {
    const text = formatBanner({ ...base, demo: true, webBuilt: false }).join('\n')
    expect(text).toContain('Demo mode')
    expect(text).toContain('not built')
  })
})
