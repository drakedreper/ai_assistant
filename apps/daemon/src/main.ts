import { join } from 'node:path'
import { createBudgetGuard, createFakeBackend, createMockToolBindings, createSdkBackend, createSecretaryLane } from '@ai-assistant/agent-core'
import { createDaemon } from './app'
import { formatBanner } from './banner'
import { ConfigError, describeConfig, loadConfig } from './config'
import { createLogger } from './log'
import { ensurePrivateDir } from './security'

async function main(): Promise<void> {
  // When the console that started the daemon goes away (SIGHUP) its streams start failing with EIO or EPIPE: that must not
  // turn the graceful shutdown that follows into a crash.
  process.stdout.on('error', () => undefined)
  process.stderr.on('error', () => undefined)
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
  // The data folder is private (POSIX: 0700); the database and secrets files inside it are 0600.
  ensurePrivateDir(config.dataDir)
  // Only the first line is logged before the daemon exists; once it does, ITS logger is used (it masks every secret the
  // daemon holds: the hook and stage tokens, the sign-in code, session tokens, the API key), not this API-key-only one.
  createLogger({ level: config.logLevel, literals: () => (config.apiKey ? [config.apiKey] : []) }).info('starting', describeConfig(config))

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
    // The stage tools (outfit, scene, gesture, camera, memory, state) join the lane's tools; the lane filters by lane and tier.
    // Her persistent character memory goes into the persona prompt too, for the cloud audience only (never private or sensitive items).
    lane: (ctx, { stageTools, memoryDigest }) => createSecretaryLane({ ...ctx, backend, tools: [...tools, ...stageTools] }, { digest: memoryDigest, conversation: config.conversation }),
  })

  const log = daemon.ctx.log
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
  // SIGHUP is what a closed terminal window sends on POSIX, and what Node reports for a closed console on Windows: the same
  // graceful stop (it used to end the process on the spot, with the terminals' trees untouched by the daemon).
  process.on('SIGHUP', () => shutdown('SIGHUP'))
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'))
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) }))
}

main().catch((err: unknown) => {
  process.stderr.write(`The daemon could not start: ${err instanceof Error ? err.message : 'unknown error'}\n`)
  process.exit(1)
})
