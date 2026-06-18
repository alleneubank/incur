import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function exec(
  cmd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000, ...opts }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || stdout?.trim() || error.message))
      else resolve({ stdout, stderr })
    })
  })
}

let dir: string
let bin: string

describe('bun build --compile', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'incur-bun-'))
    bin = join(dir, 'test-cli')
    const src = join(dir, 'cli.ts')

    await writeFile(
      src,
      `
import { Cli, z } from '${join(import.meta.dirname, 'index.ts')}'

const cli = Cli.create('test-cli', {
  version: '1.0.0',
  description: 'Bun compile test fixture.',
  sync: {
    skills: [
      {
        name: 'baked-skill',
        content: \`---
name: baked-skill
description: Inline skill baked into the compiled binary at build time.
---

# Baked skill

Proof that sync.skills survives bun build --compile.
\`,
      },
    ],
  },
})

cli.command('ping', {
  description: 'Health check',
  run() {
    return { pong: true }
  },
})

cli.command('echo', {
  description: 'Echo a message',
  args: z.object({ message: z.string().describe('Message') }),
  options: z.object({ upper: z.boolean().default(false).describe('Uppercase') }),
  alias: { upper: 'u' },
  run(c) {
    const msg = c.options.upper ? c.args.message.toUpperCase() : c.args.message
    return { result: msg }
  },
})

cli.serve()
`,
    )

    await exec('bun', ['build', src, '--compile', '--outfile', bin])
  }, 60_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('runs ping command', async () => {
    const { stdout } = await exec(bin, ['ping'])
    expect(stdout).toContain('pong: true')
  })

  test('runs command with args and options', async () => {
    const { stdout } = await exec(bin, ['echo', 'hello', '--upper'])
    expect(stdout).toContain('result: HELLO')
  })

  test('shows help', async () => {
    const { stdout } = await exec(bin, ['--help'])
    expect(stdout).toContain('test-cli')
    expect(stdout).toContain('ping')
    expect(stdout).toContain('echo')
  })

  test('shows version', async () => {
    const { stdout } = await exec(bin, ['--version'])
    expect(stdout.trim()).toBe('1.0.0')
  })

  test('skills add installs baked inline skills from the compiled binary', async () => {
    // End-to-end regression guard for #18: running `skills add` from a
    // Bun SFE binary used to crash with `ENOENT /$bunfs/root/<bin>` in
    // `resolvePackageRoot` (Layer 1). That's fixed, so now it should
    // succeed and install the inline skill baked via sync.skills
    // (Layer 2). XDG_DATA_HOME is redirected into the temp dir to keep
    // hash metadata out of the developer's real ~/.local/share.
    const installDir = join(dir, 'install')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

    // Run the compiled binary with cwd set to installDir so the
    // global=false branch of Agents.install writes there. Redirect
    // XDG_DATA_HOME so the staleness-detection hash lands in the tmp
    // dir instead of the developer's real ~/.local/share.
    await exec(bin, ['skills', 'add', '--no-global'], {
      cwd: installDir,
      env: { ...process.env, XDG_DATA_HOME: dir },
    })

    const installed = join(installDir, '.agents', 'skills', 'baked-skill', 'SKILL.md')
    expect(existsSync(installed)).toBe(true)
    const body = readFileSync(installed, 'utf8')
    expect(body).toContain('name: baked-skill')
    expect(body).toContain(
      'description: Inline skill baked into the compiled binary at build time.',
    )
  }, 30_000)
})
