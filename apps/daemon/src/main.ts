import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
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
    // The stage tools (outfit, scene, gesture, camera, memory, state) join the lane's tools; the lane filters by lane and tier.
    // Her persistent character memory goes into the persona prompt too, for the cloud audience only (never private or sensitive items).
    lane: (ctx, { stageTools, memoryDigest }) => createSecretaryLane({ ...ctx, backend, tools: [...tools, ...stageTools] }, { digest: memoryDigest }),
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

  // The stage socket: where it is and where the token lives. The token itself is NEVER printed.
  process.stdout.write(
    `${[
      daemon.stage.hub.enabled()
        ? `  Stage       ws://127.0.0.1:${info.port}/ws/stage  (for an engine or the simulator)`
        : '  Stage       off (Settings, Stage)',
      `              the stage token is in ${join(config.dataDir, 'secrets.json')} ("stageToken"), or run: pnpm --filter @ai-assistant/daemon exec tsx src/stage/cli.ts token`,
      '',
    ].join('\n')}\n`,
  )

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
