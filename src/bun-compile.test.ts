import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

type JsonRpcMessage = {
  jsonrpc: string
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: unknown
}

/** Spawns the compiled binary with `--mcp`, sends JSON-RPC messages, and returns parsed responses. */
function mcpSession(
  bin: string,
  messages: { method: string; params?: unknown; id?: number }[],
): Promise<{ responses: JsonRpcMessage[]; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: string[] = []
    const stderr: string[] = []
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('MCP session timed out'))
    }, 30_000)

    child.stdout.on('data', (chunk) => stdout.push(chunk.toString()))
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      const output = stdout.join('')
      const err = stderr.join('')
      const responses = output
        .split('\n')
        .filter((line) => line.trim())
        .map((line): JsonRpcMessage => JSON.parse(line))
      resolve({ responses, stderr: err, exitCode })
    })

    for (const message of messages)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    child.stdin.end()
  })
}

let dir: string
let bin: string
let marker: string

describe('bun build --compile', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'incur-bun-'))
    bin = join(dir, 'test-cli')
    marker = join(dir, 'updated')
    const src = join(dir, 'cli.ts')

    await writeFile(
      src,
      `
import { Cli, z } from '${join(import.meta.dirname, 'index.ts')}'
import { writeFile } from 'node:fs/promises'

const cli = Cli.create('test-cli', {
  description: 'Bun compile test fixture.',
  update: {
    check: () => '2.0.0',
    install: () => writeFile(${JSON.stringify(marker)}, 'updated'),
  },
  version: '1.0.0',
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

  test('runs command with --format yaml (lazy yaml import)', async () => {
    const { stdout } = await exec(bin, ['ping', '--format', 'yaml'])
    expect(stdout).toContain('pong: true')
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

  test('updates through a custom binary provider', async () => {
    const { stdout } = await exec(bin, ['--update'])
    expect(stdout).toContain('name: test-cli')
    await expect(readFile(marker, 'utf8')).resolves.toBe('updated')
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

  test('serves MCP stdio over --mcp', async () => {
    // Guards the literal specifier in Mcp.importStdioModule. A dynamic
    // specifier is invisible to bun build --compile, so the binary fails at
    // runtime with "Cannot find module '@modelcontextprotocol/server/stdio'".
    const initId = 1
    const listId = 2
    const { responses, stderr, exitCode } = await mcpSession(bin, [
      {
        id: initId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
      { method: 'notifications/initialized' },
      { id: listId, method: 'tools/list' },
    ])

    expect(stderr).not.toContain('Cannot find module')
    expect(exitCode).toBe(0)

    const initResponse = responses.find((response) => response.id === initId)
    expect(initResponse).toBeDefined()
    const initResult = initResponse!.result as { serverInfo?: unknown; protocolVersion?: string }
    expect(initResult.serverInfo).toBeDefined()
    expect(initResult.protocolVersion).toBe('2024-11-05')

    const listResponse = responses.find((response) => response.id === listId)
    expect(listResponse).toBeDefined()
    const listResult = listResponse!.result as { tools?: unknown[] }
    expect(Array.isArray(listResult.tools)).toBe(true)
  }, 60_000)
})
