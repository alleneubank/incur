import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { hardened } from './hardened.js'
import * as Parser from './Parser.js'

describe('hardened', () => {
  describe('text', () => {
    test('accepts normal text', () => {
      expect(hardened.text().parse('hello')).toBe('hello')
    })

    test('rejects control chars', () => {
      expect(() => hardened.text().parse('hello\u0000world')).toThrow(/control/i)
      expect(() => hardened.text().parse('hello\u007fworld')).toThrow(/control/i)
    })
  })

  describe('id', () => {
    test('accepts safe ids', () => {
      expect(hardened.id().parse('users/123')).toBe('users/123')
    })

    test('rejects url special chars and control chars', () => {
      expect(() => hardened.id().parse('users?foo=bar')).toThrow(/\?/i)
      expect(() => hardened.id().parse('users#frag')).toThrow(/#/i)
      expect(() => hardened.id().parse('users%2f123')).toThrow(/%/i)
      expect(() => hardened.id().parse('users\u0007')).toThrow(/control/i)
    })
  })

  describe('url', () => {
    test('accepts safe urls', () => {
      expect(hardened.url().parse('https://example.com/api/users')).toBe(
        'https://example.com/api/users',
      )
    })

    test('rejects control chars', () => {
      expect(() => hardened.url().parse('https://example.com/\u0000')).toThrow(/control/i)
    })

    test('rejects encoded traversal patterns', () => {
      expect(() => hardened.url().parse('https://example.com/%2e%2e/secrets')).toThrow(
        /encoded traversal/i,
      )
      expect(() => hardened.url().parse('https://example.com/%252e%252e/secrets')).toThrow(
        /encoded traversal/i,
      )
    })
  })

  describe('path', () => {
    const originalCwd = process.cwd()
    let cwd: string
    let outside: string

    beforeEach(() => {
      cwd = mkdtempSync(join(tmpdir(), 'incur-hardened-cwd-'))
      outside = mkdtempSync(join(tmpdir(), 'incur-hardened-outside-'))
      process.chdir(cwd)
    })

    afterEach(() => {
      process.chdir(originalCwd)
      rmSync(cwd, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    })

    test('accepts relative paths inside cwd', () => {
      mkdirSync(join(cwd, 'safe'), { recursive: true })
      expect(hardened.path().parse('safe')).toBe('safe')
      expect(hardened.path().parse('safe/file.txt')).toBe('safe/file.txt')
    })

    test('rejects absolute paths', () => {
      expect(() => hardened.path().parse('/tmp/secrets')).toThrow(/relative path/i)
    })

    test('rejects traversal', () => {
      expect(() => hardened.path().parse('../secrets')).toThrow(/traversal/i)
      expect(() => hardened.path().parse('safe/../../secrets')).toThrow(/traversal/i)
    })

    test('rejects control chars', () => {
      expect(() => hardened.path().parse('safe\u0000file')).toThrow(/control/i)
    })

    test('rejects symlink escapes outside cwd', () => {
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      symlinkSync(outside, join(cwd, 'escape'))
      expect(() => hardened.path().parse('escape')).toThrow(/outside the current directory/i)
      expect(() => hardened.path().parse('escape/secret.txt')).toThrow(
        /outside the current directory/i,
      )
    })
  })
})

describe('parser default string hardening', () => {
  test('rejects control chars for plain z.string args and options', () => {
    expect(() =>
      Parser.parse(['hello\u0000world', '--label', 'safe'], {
        args: z.object({ name: z.string() }),
        options: z.object({ label: z.string() }),
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ValidationError' }))
  })

  test('rejects control chars for env strings', () => {
    expect(() =>
      Parser.parseEnv(
        z.object({
          TOKEN: z.string(),
        }),
        { TOKEN: 'bad\u0000token' },
      ),
    ).toThrow(expect.objectContaining({ name: 'Incur.ValidationError' }))
  })

  test('allows control chars when explicitly opted out', () => {
    const result = Parser.parse(['hello\u0000world'], {
      args: z.object({
        text: z.string().meta({ allowControlChars: true }),
      }),
    })

    expect(result.args.text).toBe('hello\u0000world')
  })
})
