import { mkdirSync } from 'node:fs'
import { createBudgetGuard, createFakeBackend, createMockToolBindings, createSdkBackend, createSecretaryLane } from '@ai-assistant/agent-core'
import { createDaemon } from './app'
import { formatBanner } from './banner'
import { ConfigError, describeConfig, loadConfig } from './config'
import { createLogger } from './log'

async function main(): Promise<void> {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`)
      process.exit(2)
    }
    throw err
  }
  mkdirSync(config.dataDir, { recursive: true })
  const log = createLogger({ level: config.logLevel, literals: () => (config.apiKey ? [config.apiKey] : []) })
  log.info('starting', describeConfig(config))

  const backend = config.backend === 'sdk' ? createSdkBackend() : createFakeBackend()
  const tools = createMockToolBindings()
  const { budgets } = config
  const budget = createBudgetGuard({
    lanes: [
      { lane: 'secretary', dailyBudgetUsd: budgets.secretaryDailyUsd },
      { lane: 'reader', dailyBudgetUsd: budgets.readerDailyUsd },
      { lane: 'voice', dailyBudgetUsd: budgets.voiceDailyUsd },
    ],
    globalDailyCapUsd: budgets.globalDailyUsd,
  })

  const daemon = createDaemon({
    config,
    budget,
    log,
    lane: (ctx) => createSecretaryLane({ ...ctx, backend, tools }),
  })

  const info = await daemon.start()
  for (const line of formatBanner({
    version: config.version,
    port: info.port,
    exchangeUrl: info.exchangeUrl,
    exchangeTtlMinutes: Math.round(config.exchangeCodeTtlMs / 60_000),
    dataDir: config.dataDir,
    backend: config.backend,
    authMode: config.authMode,
    apiKeyPresent: Boolean(config.apiKey),
    demo: config.demo,
    webBuilt: Boolean(config.webDist),
  })) {
    process.stdout.write(`${line}\n`)
  }

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.stderr.write('Forced exit.\n')
      process.exit(1)
    }
    shuttingDown = true
    log.info('shutting down', { signal })
    const watchdog = setTimeout(() => {
      process.stderr.write('Shutdown took too long, forcing exit.\n')
      process.exit(1)
    }, 10_000)
    watchdog.unref()
    daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        process.stderr.write(`Shutdown error: ${err instanceof Error ? err.message : 'unknown'}\n`)
        process.exit(1)
      },
    )
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'))
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) }))
}

main().catch((err: unknown) => {
  process.stderr.write(`The daemon could not start: ${err instanceof Error ? err.message : 'unknown error'}\n`)
  process.exit(1)
})
