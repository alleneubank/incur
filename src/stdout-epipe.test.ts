import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let src: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'incur-epipe-'))
  src = join(dir, 'cli.mts')
  // Output far larger than a pipe buffer, so writes are still pending when the reader leaves.
  await writeFile(
    src,
    `
const { Cli } = await import('${join(import.meta.dirname, 'index.ts')}')

Cli.create('big', { version: '1.0.0' })
  .command('dump', { description: 'Print a lot', run: () => ({ text: 'x'.repeat(4_000_000) }) })
  .serve(process.argv.slice(2))
`,
  )
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

// `cli … | head -1` closes stdout before the CLI finishes writing. That is the reader's choice, not a
// failure of the CLI, so it exits quietly instead of crashing on the unhandled EPIPE.
test('exits 0 without a stack trace when stdout closes early', async () => {
  // `--no-deprecation` hides tsx's own loader warning, so stderr holds only what the CLI writes.
  const child = spawn(
    process.execPath,
    ['--no-deprecation', '--import', 'tsx', src, 'dump', '--json'],
    {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  )
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  await new Promise((resolve) => child.stdout.once('data', resolve))
  child.stdout.destroy()
  const exited = await new Promise((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  )
  expect({ exited, stderr }).toEqual({ exited: { code: 0, signal: null }, stderr: '' })
})
