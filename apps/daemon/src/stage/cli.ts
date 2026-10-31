import { readSecretsFile, rotateSecretsStageToken } from '../security'
import { loadConfig, ConfigError } from '../config'

/**
 * `tsx src/stage/cli.ts token [--rotate]`: print (or replace) the stage token, for an engine's configuration.
 *
 * It reads DATA_DIR/secrets.json (the same folder as the daemon, same environment). The token is a secret: this command
 * is the one place it is printed on purpose, to a terminal you are looking at. Do not paste it into chat or a URL.
 * A running daemon notices a rotated token on disk by itself; a stage that is already connected keeps its socket.
 */
function main(argv: string[]): number {
  const [cmd, ...flags] = argv
  if (cmd !== 'token') {
    process.stderr.write('usage: stage token [--rotate]\n')
    return 2
  }
  let dataDir: string
  try {
    dataDir = loadConfig().dataDir
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : 'bad configuration'}\n`)
    return 2
  }
  const token = flags.includes('--rotate') ? rotateSecretsStageToken(dataDir) : readSecretsFile(dataDir)?.stageToken
  if (!token) {
    process.stderr.write(`No stage token in ${dataDir}. Start the daemon once (it creates secrets.json), then try again.\n`)
    return 1
  }
  process.stdout.write(`${token}\n`)
  return 0
}

process.exit(main(process.argv.slice(2)))
