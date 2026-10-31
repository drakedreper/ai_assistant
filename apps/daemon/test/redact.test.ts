import { describe, expect, it } from 'vitest'
import { isSensitiveKey, maskSecrets, PAYLOAD_CAP, redactHookPayload, redactText, redactValue, summarizeBody } from '../src/store/redact'
import { createLogger } from '../src/log'

describe('maskSecrets', () => {
  it.each([
    ['anthropic key', 'key is sk-ant-api03-abcdefghijklmnop done', 'api03-abcdefghijklmnop'],
    ['generic sk key', 'token sk-abcdefghijklmnopqrstuvwxyz0123', 'sk-abcdefghijkl'],
    ['github pat', 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefgh'],
    ['fine grained pat', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github_pat_11ABC'],
    ['aws key', 'AKIAABCDEFGHIJKLMNOP is mine', 'AKIAABCDEFGHIJKLMNOP'],
    ['slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'eyJhbGciOiJ'],
    ['bearer', 'Authorization: Bearer abcdef0123456789abcdef', 'abcdef0123456789'],
    ['basic', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNz'],
  ])('masks a %s', (_name, input, leaked) => {
    const out = maskSecrets(input)
    expect(out).not.toContain(leaked)
    expect(out).toMatch(/\*\*\*|\[JWT\]/)
  })

  it('masks a private key block, including an unterminated one', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabcdef\n-----END RSA PRIVATE KEY-----'
    expect(maskSecrets(`x ${pem} y`)).toBe('x [REDACTED PRIVATE KEY] y')
    expect(maskSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg')).toBe('[REDACTED PRIVATE KEY]')
  })

  it('masks key=value, key: value and JSON forms for secret-looking keys', () => {
    expect(maskSecrets('API_KEY=hunter2hunter2')).toBe('API_KEY=***')
    expect(maskSecrets('password: "correct horse"')).toBe('password: ***')
    expect(maskSecrets('{"access_token": "abc123xyz789"}')).toBe('{"access_token": ***}')
    expect(maskSecrets("client_secret='s3cr3t-value'")).toBe('client_secret=***')
    expect(maskSecrets('curl -H "X-Auth-Token: abcdefghij" https://x')).not.toContain('abcdefghij')
    expect(maskSecrets('DB_PASSWORD=p@ss&more=1')).toBe('DB_PASSWORD=***&more=1')
  })

  it('leaves ordinary text and short numeric values alone', () => {
    expect(maskSecrets('Ran pnpm test (18 passed)')).toBe('Ran pnpm test (18 passed)')
    expect(maskSecrets('max_tokens: 1024')).toBe('max_tokens: 1024')
    expect(maskSecrets('C:\\dev\\atlas\\src\\index.ts')).toBe('C:\\dev\\atlas\\src\\index.ts')
  })

  it('masks exact literals the daemon itself holds (hook token, API key)', () => {
    const literal = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA'
    expect(maskSecrets(`the token ${literal} leaked`, [literal])).toBe('the token *** leaked')
    expect(maskSecrets('short', ['abc'])).toBe('short') // too short to be a secret
  })
})

describe('redactText', () => {
  it('masks before truncating, so a secret straddling the cut cannot leak a prefix', () => {
    const text = `${'a'.repeat(95)} sk-ant-api03-SECRETSECRETSECRET tail`
    const out = redactText(text, 100)
    expect(out).not.toContain('SECRET')
    expect(out).not.toContain('sk-ant-api03')
  })

  it('truncates and reports how much was cut', () => {
    const out = redactText('x'.repeat(1000), 100)
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('+900 chars')
  })
})

describe('redactValue', () => {
  it('redacts values of sensitive keys, keeps numbers, bounds depth, items and string size', () => {
    const out = redactValue({
      command: 'ls',
      env: { ANTHROPIC_API_KEY: 'sk-ant-xyz-123456', PATH: '/usr/bin' },
      password: 'hunter2',
      max_tokens: 100,
      nested: { a: { b: { c: { d: { e: 'deep' } } } } },
      list: Array.from({ length: 50 }, (_, i) => i),
      long: 'z'.repeat(2000),
    }) as Record<string, unknown>
    expect((out.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBe('[redacted]')
    expect((out.env as Record<string, unknown>).PATH).toBe('/usr/bin')
    expect(out.password).toBe('[redacted]')
    expect(out.max_tokens).toBe(100)
    expect(JSON.stringify(out.nested)).toContain('too deep')
    expect((out.list as unknown[]).length).toBe(21)
    expect(String(out.long).length).toBeLessThan(600)
  })

  it('survives circular-free garbage: functions, symbols, bigint, NaN', () => {
    const out = redactValue({ f: () => 1, s: Symbol('x'), b: BigInt(5), n: Number.NaN, u: undefined }) as Record<string, unknown>
    expect(out).toEqual({ f: null, s: null, b: '5', n: null, u: null })
  })

  it('classifies sensitive keys without flagging token counters', () => {
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('Authorization')).toBe(true)
    expect(isSensitiveKey('x-auth-token')).toBe(true)
    expect(isSensitiveKey('input_tokens')).toBe(false)
    expect(isSensitiveKey('session_id')).toBe(false)
    expect(isSensitiveKey('cwd')).toBe(false)
  })
})

describe('summarizeBody and redactHookPayload', () => {
  it('turns a tool_response into a short masked preview plus its size', () => {
    const body = `${'line of file contents\n'.repeat(500)}API_KEY=supersecretvalue1234`
    const s = summarizeBody(body)
    expect(s.chars).toBe(body.length)
    expect(s.preview.length).toBeLessThan(400)
  })

  it('stores a hook payload truncated and masked, keeping routing fields intact', () => {
    const { payload, json } = redactHookPayload({
      session_id: 'abc',
      hook_event_name: 'PostToolUse',
      cwd: 'C:\\dev\\atlas',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.example.com', description: 'd'.repeat(5000) },
      tool_response: { stdout: 'x'.repeat(100_000), api_key: 'sk-ant-leaky-0000000000' },
      prompt: `${'p'.repeat(1000)} sk-ant-leaky-0000000000`,
      transcript_path: 'C:\\Users\\you\\.claude\\projects\\x\\abc.jsonl',
    })
    expect(payload.session_id).toBe('abc')
    expect(payload.tool_use_id).toBe('toolu_1')
    expect(json.length).toBeLessThan(PAYLOAD_CAP)
    expect(json).not.toContain('abcdefghijklmnop')
    expect(json).not.toContain('leaky')
    expect((payload.tool_response as { chars: number }).chars).toBeGreaterThan(100_000)
    expect(String(payload.prompt).length).toBeLessThan(260)
  })

  it('caps the whole payload', () => {
    const wide: Record<string, unknown> = { session_id: 's', hook_event_name: 'X' }
    for (let i = 0; i < 59; i++) wide[`field${i}`] = 'v'.repeat(480)
    const { payload, json } = redactHookPayload(wide)
    expect(json.length).toBeLessThanOrEqual(PAYLOAD_CAP)
    expect(payload.session_id).toBe('s')
  })

  it('accepts non-object input without throwing', () => {
    expect(() => redactHookPayload('just a string')).not.toThrow()
    expect(() => redactHookPayload(null)).not.toThrow()
    expect(() => redactHookPayload([1, 2, 3])).not.toThrow()
  })
})

describe('logger', () => {
  it('masks secrets and exact literals in every line and drops non-primitive meta', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l), literals: () => ['literal-secret-value-123'] })
    log.info('token literal-secret-value-123 and sk-ant-api03-abcdefghijkl', { nested: { x: 1 }, count: 3, name: 'ok' })
    const line = lines.join('\n')
    expect(line).not.toContain('literal-secret-value-123')
    expect(line).not.toContain('sk-ant-api03')
    expect(line).toContain('count=3')
    expect(line).not.toContain('nested')
  })

  it('respects the level', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) })
    log.info('quiet')
    log.warn('loud')
    expect(lines).toHaveLength(1)
  })
})
