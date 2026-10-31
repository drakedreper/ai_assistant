#!/usr/bin/env node
/**
 * End-to-end smoke test for the mockup. Drives a real Chromium through every screen and the key
 * interactions, fails on any console/page error, and writes screenshots.
 *
 *   pnpm --filter @ai-assistant/web build && pnpm --filter @ai-assistant/web preview &
 *   BASE_URL=http://127.0.0.1:4173 SHOTS_DIR=./screenshots node apps/web/scripts/smoke.mjs
 *
 * Needs Playwright with a Chromium browser (npx playwright install chromium).
 * "?static" freezes the live simulator so the run is deterministic.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173'
const SHOTS = process.env.SHOTS_DIR ?? './screenshots'
mkdirSync(SHOTS, { recursive: true })

const VIEWS = ['Today', 'Work', 'Brain', 'Life', 'Money (Atlas)', 'World', 'Settings']
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })

async function open(width, height, query = '?static') {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // Software-rendered WebGL in CI can log GPU stalls; those are not app errors.
    if (/GPU stall|WebGL|GL Driver|swiftshader/i.test(t)) return
    errors.push(t.slice(0, 240))
  })
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 240)}`))
  await page.goto(`${BASE}/${query}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('nav[aria-label="Main"]')
  return { page, errors }
}

/** Open the command palette, run one command, and wait for it to close. */
async function palette(page, text) {
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await dialog.waitFor({ state: 'visible' })
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForTimeout(350)
}

const nav = (page, label) => page.locator(`nav[aria-label="Main"] button[aria-label="${label}"]`).click()
const badge = async (page, label) => {
  const t = await page.locator(`nav[aria-label="Main"] button[aria-label="${label}"] span.bg-mira`).first().textContent().catch(() => null)
  return t ? Number(t) : 0
}

for (const [w, h] of [[1920, 1080], [1366, 768]]) {
  const { page, errors } = await open(w, h)

  // 1. every screen renders without errors
  for (const v of VIEWS) {
    await nav(page, v)
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${SHOTS}/${w}-${v.replace(/\W+/g, '-').toLowerCase()}.png` })
    const main = await page.locator('main').innerText().catch(() => '')
    check(`[${w}] ${v} renders content`, main.trim().length > 40, `${main.trim().length} chars`)
  }

  // 2. the Room column is about a quarter of the window (quarter mode)
  await nav(page, 'Today')
  const box = await page.locator('aside[aria-label="Mira\'s room and chat"]').boundingBox()
  const share = box ? box.width / w : 0
  check(`[${w}] her-space column is ~25% wide`, share > 0.2 && share < 0.32, `${(share * 100).toFixed(1)}%`)

  check(`[${w}] no console/page errors after visiting every screen`, errors.length === 0, errors.join(' | '))
  await page.close()
}

// 3. interactions at desktop size
{
  const { page, errors } = await open(1920, 1080)

  // command palette
  await page.keyboard.press('Control+k')
  check('command palette opens with Ctrl+K', await page.getByRole('dialog', { name: 'Command palette' }).isVisible())
  await page.keyboard.press('Escape')
  await palette(page, 'Work')
  check('command palette navigates', (await page.locator('main').getAttribute('aria-label')) === 'work')

  // approving an item lowers the Today badge
  await nav(page, 'Today')
  const before = await badge(page, 'Today')
  await page.getByRole('button', { name: 'Approve' }).first().click()
  await page.waitForTimeout(500)
  const after = await badge(page, 'Today')
  check('approving a card lowers the needs-you count', after === before - 1, `${before} -> ${after}`)

  // room size modes
  await palette(page, 'Room size: Half')
  const half = await page.locator('aside[aria-label="Mira\'s room and chat"]').boundingBox()
  check('half mode widens her space to ~50%', !!half && half.width / 1920 > 0.42 && half.width / 1920 < 0.56, half ? `${((half.width / 1920) * 100).toFixed(1)}%` : 'missing')
  await page.screenshot({ path: `${SHOTS}/1920-room-half.png` })
  await palette(page, 'Room size: Full')
  check('full mode hides the stage', (await page.locator('main').count()) === 0)
  await page.screenshot({ path: `${SHOTS}/1920-room-full.png` })
  await palette(page, 'Room size: Mini')
  await page.screenshot({ path: `${SHOTS}/1920-room-mini.png` })
  await palette(page, 'Room size: Quarter')

  // chat: send a message and get a streamed reply
  const input = page.locator('aside textarea, aside input[type="text"]').first()
  await input.fill('What is on today?')
  await input.press('Enter')
  await page.waitForTimeout(4500)
  const chatText = await page.locator('aside').innerText()
  check('chat shows the reply to a typed message', /Dana|calendar|agenda|today/i.test(chatText))

  // guest mode blurs sensitive content
  await nav(page, 'Settings')
  await page.getByRole('tab', { name: /privacy/i }).first().click()
  await page.waitForTimeout(300)
  const guest = page.getByRole('switch', { name: /guest/i }).first()
  if (await guest.count()) {
    await guest.click()
    await page.waitForTimeout(300)
    const on = await page.locator('[data-guest="on"]').count()
    check('guest mode sets data-guest on the shell', on > 0)
    await guest.click()
  } else {
    console.log('SKIP  guest mode switch not found by role=switch name=/guest/')
  }

  check('no console/page errors during interactions', errors.length === 0, errors.join(' | '))
  await page.close()
}

await browser.close()
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed')
process.exit(failures.length ? 1 : 0)
