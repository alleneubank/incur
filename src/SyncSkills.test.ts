import { Cli, SyncSkills } from 'incur'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let savedXdg: string | undefined

beforeEach(() => {
  savedXdg = process.env.XDG_DATA_HOME
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = savedXdg
})

test('generates skill files and installs to canonical location', async () => {
  const tmp = join(tmpdir(), `clac-sync-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test', { description: 'A test CLI' })
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })
  cli.command('greet', { description: 'Say hello', run: () => ({ hi: true }) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('test', commands, {
    description: 'A test CLI',
    // Use a fake home dir so we don't pollute the real one
    global: false,
    cwd: installDir,
  })

  expect(result.skills.length).toBeGreaterThan(0)
  expect(result.skills.map((s) => s.name)).toContain('test-greet')
  expect(result.skills.map((s) => s.name)).toContain('test-ping')

  // Verify skills were installed to canonical location
  for (const p of result.paths) {
    expect(existsSync(join(p, 'SKILL.md'))).toBe(true)
  }

  rmSync(tmp, { recursive: true, force: true })
})

test('uses custom depth', async () => {
  const tmp = join(tmpdir(), `clac-depth-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })
  cli.command('pong', { description: 'Pong', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('test', commands, {
    depth: 0,
    global: false,
    cwd: installDir,
  })

  // depth 0 = single skill
  expect(result.skills).toHaveLength(1)

  rmSync(tmp, { recursive: true, force: true })
})

test('sync results are sorted alphabetically', async () => {
  const tmp = join(tmpdir(), `clac-sync-sort-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test')
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  mkdirSync(join(installDir, 'zeta'), { recursive: true })
  writeFileSync(
    join(installDir, 'zeta', 'SKILL.md'),
    ['---', 'name: zeta', 'description: Z skill.', '---', '', '# zeta'].join('\n'),
  )
  writeFileSync(
    join(installDir, 'SKILL.md'),
    ['---', 'name: test', 'description: Root skill.', '---', '', '# test'].join('\n'),
  )
  mkdirSync(join(installDir, 'alpha'), { recursive: true })
  writeFileSync(
    join(installDir, 'alpha', 'SKILL.md'),
    ['---', 'name: alpha', 'description: A skill.', '---', '', '# alpha'].join('\n'),
  )

  const result = await SyncSkills.sync('test', commands, {
    global: false,
    cwd: installDir,
    include: ['zeta', '_root', 'alpha'],
  })

  expect(result.skills.map((s) => s.name)).toEqual(['alpha', 'test', 'zeta'])

  rmSync(tmp, { recursive: true, force: true })
})

test('writes hash after successful sync', async () => {
  const tmp = join(tmpdir(), `clac-hash-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('hash-test')
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  await SyncSkills.sync('hash-test', commands, {
    global: false,
    cwd: installDir,
  })

  const stored = SyncSkills.readHash('hash-test')
  expect(stored).toMatch(/^[0-9a-f]{16}$/)

  rmSync(tmp, { recursive: true, force: true })
})

test('readHash returns undefined when no hash exists', () => {
  const tmp = join(tmpdir(), `clac-hash-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  expect(SyncSkills.readHash('nonexistent')).toBeUndefined()

  rmSync(tmp, { recursive: true, force: true })
})

test('installs inline skills passed via sync.skills', async () => {
  // Exercise the build-time escape hatch path — simulates a compiled binary
  // that baked SKILL.md content into a text import at build time and has
  // no source tree to glob at runtime.
  const tmp = join(tmpdir(), `clac-inline-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('inline-tool', { description: 'Inline test tool' })
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const inlineContent = `---
name: baked-skill
description: Skill whose body was baked into the binary at build time.
---

# Baked skill

Proof that the content was installed via sync.skills.
`

  const result = await SyncSkills.sync('inline-tool', commands, {
    global: false,
    cwd: installDir,
    skills: [{ name: 'baked-skill', content: inlineContent }],
  })

  // Metadata entry lands in result with external=true so consumers can
  // distinguish inline/glob skills from auto-generated command skills.
  const baked = result.skills.find((s) => s.name === 'baked-skill')
  expect(baked).toBeDefined()
  expect(baked?.external).toBe(true)
  expect(baked?.description).toBe('Skill whose body was baked into the binary at build time.')

  // Installed SKILL.md on disk matches the inline body verbatim.
  const bakedPath = result.paths.find((p) => p.endsWith('baked-skill'))
  expect(bakedPath).toBeDefined()
  expect(readFileSync(join(bakedPath!, 'SKILL.md'), 'utf8')).toBe(inlineContent)

  rmSync(tmp, { recursive: true, force: true })
})

test('sync.skills yields to include when both provide the same name', async () => {
  // Regression guard for the dev-mode edit path: when both sync.include and
  // sync.skills produce an entry with the same name, the glob match must
  // win because it's read from the live source tree, not whatever stale
  // string was baked in at last build.
  const tmp = join(tmpdir(), `clac-inline-override-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('override-tool', { description: 'Override test' })
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Stage a fresh SKILL.md in the source tree that `include` will find.
  const skillDir = join(installDir, 'skills', 'shared-skill')
  mkdirSync(skillDir, { recursive: true })
  const freshContent = `---
name: shared-skill
description: Live source content (fresher than baked).
---

# Live version
`
  writeFileSync(join(skillDir, 'SKILL.md'), freshContent)

  const staleContent = `---
name: shared-skill
description: Stale baked content.
---

# Baked (should lose)
`

  const result = await SyncSkills.sync('override-tool', commands, {
    global: false,
    cwd: installDir,
    include: ['skills/*'],
    skills: [{ name: 'shared-skill', content: staleContent }],
  })

  const shared = result.skills.find((s) => s.name === 'shared-skill')
  expect(shared).toBeDefined()
  // Description comes from the live glob match, not the baked string.
  expect(shared?.description).toBe('Live source content (fresher than baked).')

  const sharedPath = result.paths.find((p) => p.endsWith('shared-skill'))
  expect(sharedPath).toBeDefined()
  expect(readFileSync(join(sharedPath!, 'SKILL.md'), 'utf8')).toBe(freshContent)

  rmSync(tmp, { recursive: true, force: true })
})

test('sync.include overrides a command-generated skill with the same frontmatter name', async () => {
  // Regression for the devctl-auth display bug: when a subcommand group
  // (`auth login`, `auth status`) produces a command-generated skill
  // named `<cli>-auth`, and sync.include also finds a hand-authored
  // `skills/<cli>-auth/SKILL.md`, the include must fully replace the
  // command-generated entry — both on disk and in the returned skills
  // metadata. Before the fix, `Skill.split` wrote the command-generated
  // file to `tmpDir/auth/SKILL.md` (bucket key) while include wrote to
  // `tmpDir/<cli>-auth/SKILL.md` (frontmatter name), so `discoverSkills`
  // returned two entries with the same sanitized name and `Agents.install`
  // emitted a duplicate path. The tracking array also held stale
  // command-generated metadata because the include loop short-circuited
  // on `skills.some(...)`.
  const tmp = join(tmpdir(), `clac-include-override-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('devctl', { description: 'Test harness CLI' })
  cli.command('auth login', { description: 'Log in', run: () => ({}) })
  cli.command('auth logout', { description: 'Log out', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const skillDir = join(installDir, 'skills', 'devctl-auth')
  mkdirSync(skillDir, { recursive: true })
  const handAuthored = `---
name: devctl-auth
description: Hand-authored onboarding walkthrough — wins over command gen.
---

# Onboarding
`
  writeFileSync(join(skillDir, 'SKILL.md'), handAuthored)

  const result = await SyncSkills.sync('devctl', commands, {
    global: false,
    cwd: installDir,
    include: ['skills/*'],
  })

  const authEntries = result.skills.filter((s) => s.name === 'devctl-auth')
  expect(authEntries).toHaveLength(1)
  expect(authEntries[0]?.description).toBe(
    'Hand-authored onboarding walkthrough — wins over command gen.',
  )
  expect(authEntries[0]?.external).toBe(true)

  const authPaths = result.paths.filter((p) => p.endsWith('devctl-auth'))
  expect(authPaths).toHaveLength(1)
  expect(readFileSync(join(authPaths[0]!, 'SKILL.md'), 'utf8')).toBe(handAuthored)

  rmSync(tmp, { recursive: true, force: true })
})

test('sync.skills rejects path-traversal names instead of writing outside tmpDir', async () => {
  // The downstream `Agents.install()` discovery loop sanitizes skill names,
  // but only after files have already been written to disk. An unsanitized
  // `..` segment in `skill.name` would land a SKILL.md outside `tmpDir` —
  // outside the cleanup `finally`. Reject these inputs at the inline write
  // site, before any `fs.writeFile` runs.
  const tmp = join(tmpdir(), `clac-inline-traversal-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('traversal-tool')
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const body = `---
name: bad
description: never written
---
`
  const evilNames = ['../escape', 'foo/bar', 'foo\\bar', '..', '.', '']
  for (const name of evilNames) {
    await expect(
      SyncSkills.sync('traversal-tool', commands, {
        global: false,
        cwd: installDir,
        skills: [{ name, content: body }],
      }),
    ).rejects.toThrow(/sync\.skills: invalid skill name/)
  }

  // None of the rejected names landed a stray file in the install dir's parent
  // (a sibling of `.agents`), proving the early throw fired before any write.
  expect(existsSync(join(installDir, 'escape'))).toBe(false)

  rmSync(tmp, { recursive: true, force: true })
})

test('sync.skills rejects malicious frontmatter `name:` even when skill.name is safe', async () => {
  // The directory name is sanitized at the SyncSkills layer, but
  // `Agents.install()` re-reads the SKILL.md from disk and prefers the
  // frontmatter `name:` over the directory name. `sanitizeName()` collapses
  // `..` to `''`, and `path.join(canonicalBase, '')` equals `canonicalBase`
  // — so without this guard, the install loop's `rmForce(canonicalDir)`
  // would wipe the user's entire `.agents/skills` tree.
  const tmp = join(tmpdir(), `clac-inline-frontmatter-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('frontmatter-tool')
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Drop a marker skill into the canonical install dir to prove that a
  // successful exploit would have wiped it.
  const canary = join(installDir, '.agents', 'skills', 'canary', 'SKILL.md')
  mkdirSync(join(installDir, '.agents', 'skills', 'canary'), { recursive: true })
  writeFileSync(canary, '---\nname: canary\n---\nstill here\n')

  const evilFrontmatters = [
    '---\nname: ..\n---\nbody\n',
    '---\nname: .\n---\nbody\n',
    '---\nname: \n---\nbody\n',
    '---\nname: ../escape\n---\nbody\n',
    '---\nname: foo/bar\n---\nbody\n',
  ]
  for (const content of evilFrontmatters) {
    await expect(
      SyncSkills.sync('frontmatter-tool', commands, {
        global: false,
        cwd: installDir,
        skills: [{ name: 'safe-dir', content }],
      }),
    ).rejects.toThrow(/sync\.skills: invalid SKILL\.md frontmatter `name:`/)
  }

  // Canary survived — the throw fired before any rmForce could run.
  expect(existsSync(canary)).toBe(true)
  expect(readFileSync(canary, 'utf8')).toContain('still here')

  rmSync(tmp, { recursive: true, force: true })
})

test('sync.include _root rejects malicious frontmatter `name:`', async () => {
  // Issue 5 regression: the `_root` include path takes its skill name from
  // the root SKILL.md frontmatter and used to write directly to
  // `path.join(tmpDir, name, 'SKILL.md')` with no validation. The shipped
  // CLI defaults to `include: ['_root']`, so an attacker who can drop or
  // edit a root SKILL.md (e.g. via a compromised dependency or a worktree
  // checkout containing one) could otherwise write a SKILL.md outside
  // `tmpDir`. The cleanup `finally` only removes `tmpDir`, so the escaped
  // file would survive.
  const tmp = join(tmpdir(), `clac-include-root-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('root-tool')
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Drop a canary in a parent directory to detect any escape.
  const escapeTarget = join(installDir, '..', 'escape')
  if (existsSync(escapeTarget)) rmSync(escapeTarget, { recursive: true, force: true })

  // Place a malicious root SKILL.md in the include cwd.
  writeFileSync(
    join(installDir, 'SKILL.md'),
    `---
name: ../escape
description: Should be rejected before any write.
---
body
`,
  )

  await expect(
    SyncSkills.sync('root-tool', commands, {
      global: false,
      cwd: installDir,
      include: ['_root'],
    }),
  ).rejects.toThrow(/sync\.include _root: invalid SKILL\.md frontmatter `name:`/)

  // No SKILL.md landed at the escape path.
  expect(existsSync(join(escapeTarget, 'SKILL.md'))).toBe(false)

  rmSync(tmp, { recursive: true, force: true })
})

test('staleness hash ignores inline entries shadowed by include glob (Issue 6)', async () => {
  // Issue 6 regression: when an inline `sync.skills` entry has the same
  // name as a SKILL.md picked up by an `include` glob, the inline never
  // lands on disk (the glob match wins). Changing only the shadowed inline
  // body must NOT trip the staleness check, otherwise users get a false
  // "out of date" prompt for content that was never installed. The fix
  // requires the read site to walk include globs the same way as the write
  // site so both hashes filter the same shadow set.
  const tmp = join(tmpdir(), `clac-include-shadow-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('include-shadow-tool')
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Stage a glob-matched skill in the source tree.
  const skillDir = join(installDir, 'skills', 'shared')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: shared
description: live source
---
live body
`,
  )

  const v1 = `---
name: shared
description: shadowed v1
---
shadowed body v1
`
  await SyncSkills.sync('include-shadow-tool', commands, {
    global: false,
    cwd: installDir,
    include: ['skills/*'],
    skills: [{ name: 'shared', content: v1 }],
  })
  const hash1 = SyncSkills.readHash('include-shadow-tool')

  const v2 = `---
name: shared
description: shadowed v2 (different)
---
shadowed body v2 with way more content than v1
`
  await SyncSkills.sync('include-shadow-tool', commands, {
    global: false,
    cwd: installDir,
    include: ['skills/*'],
    skills: [{ name: 'shared', content: v2 }],
  })
  const hash2 = SyncSkills.readHash('include-shadow-tool')

  expect(hash1).toBeDefined()
  expect(hash2).toBeDefined()
  expect(hash1).toBe(hash2)

  rmSync(tmp, { recursive: true, force: true })
})

test('skills add --no-global persists includeCwd so staleness check walks the same tree', async () => {
  // Issue 7 regression: when a user runs `skills add --no-global` from
  // their project directory, the write site anchors include globs to
  // `process.cwd()` (via `global: false`) — but the read side in
  // `Cli.serve` has no hint about which mode was used and used to fall
  // back to `resolvePackageRoot()`, which can point at a completely
  // different tree. A user who synced locally and relied on
  // `sync.include` to shadow an inline skill would then see a false
  // "Skills are out of date" prompt on the next CLI invocation because
  // the read side walks the wrong directory.
  //
  // Fix: persist the effective cwd in metadata (`meta.includeCwd`) and
  // have the read site prefer it over any live resolver. This test
  // verifies both the persistence and that the persisted value matches
  // the cwd the write site actually used for the glob walk.
  const tmp = join(tmpdir(), `clac-no-global-cwd-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('localtool')
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Stage an include-shadowed skill only reachable via the project-local
  // tree — NOT the resolved package root.
  const skillDir = join(installDir, 'skills', 'shared')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: shared\ndescription: live\n---\nlive body\n',
  )

  await SyncSkills.sync('localtool', commands, {
    global: false,
    cwd: installDir,
    include: ['skills/*'],
    skills: [{ name: 'shared', content: '---\nname: shared\n---\nbaked v1\n' }],
  })

  // Metadata preserves the cwd the write site used for include expansion,
  // so the read site can walk the exact same tree regardless of where the
  // user invokes the CLI from.
  expect(SyncSkills.readIncludeCwd('localtool')).toBe(installDir)

  rmSync(tmp, { recursive: true, force: true })
})

test('sync writes CONTEXT.md to a per-CLI path, not the shared root file', async () => {
  // Issue 3 regression: `resolveContextPath` used to return the shared
  // `~/.agents/CONTEXT.md` (global mode) or `$cwd/CONTEXT.md` (local
  // mode). In local mode it clobbered any user-authored repo-root
  // CONTEXT.md; in global mode each CLI's sync wiped the previous CLI's
  // context. The fix scopes the file to a per-CLI location under the
  // `.agents/contexts/` subdirectory and leaves the legacy shared path
  // untouched.
  const tmp = join(tmpdir(), `clac-context-path-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('ctxtool-alpha', { description: 'Alpha' })
  cli.command('ping', { description: 'ping', run: () => ({}) })
  const cli2 = Cli.create('ctxtool-beta', { description: 'Beta' })
  cli2.command('pong', { description: 'pong', run: () => ({}) })

  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Pre-stage a user-authored repo-root CONTEXT.md that must survive.
  const userContext = join(installDir, 'CONTEXT.md')
  const userBody = '# My project\n\nImportant local context that must not be clobbered.\n'
  writeFileSync(userContext, userBody)

  // Run two syncs on different CLIs under the same install dir.
  await SyncSkills.sync('ctxtool-alpha', Cli.toCommands.get(cli)!, {
    global: false,
    cwd: installDir,
    description: 'Alpha',
  })
  await SyncSkills.sync('ctxtool-beta', Cli.toCommands.get(cli2)!, {
    global: false,
    cwd: installDir,
    description: 'Beta',
  })

  // 1. The user's repo-root CONTEXT.md is untouched.
  expect(readFileSync(userContext, 'utf8')).toBe(userBody)

  // 2. Each CLI got its own scoped context file under
  //    `.agents/contexts/<name>.md` — both coexist.
  const alphaPath = join(installDir, '.agents', 'contexts', 'ctxtool-alpha.md')
  const betaPath = join(installDir, '.agents', 'contexts', 'ctxtool-beta.md')
  expect(existsSync(alphaPath)).toBe(true)
  expect(existsSync(betaPath)).toBe(true)
  expect(readFileSync(alphaPath, 'utf8')).toContain('ctxtool-alpha')
  expect(readFileSync(betaPath, 'utf8')).toContain('ctxtool-beta')
  // No cross-clobbering: alpha's file does not mention beta and vice versa.
  expect(readFileSync(alphaPath, 'utf8')).not.toContain('ctxtool-beta')
  expect(readFileSync(betaPath, 'utf8')).not.toContain('ctxtool-alpha')

  rmSync(tmp, { recursive: true, force: true })
})

test('expandIncludeNames returns the same shadow set the install path uses', async () => {
  // Direct test of the helper used by both the write site and the
  // staleness check read site. If both sites compute the same set, their
  // hashes will agree.
  const tmp = join(tmpdir(), `clac-expand-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  // Two glob-matched skills via 'skills/*' + a root SKILL.md.
  mkdirSync(join(tmp, 'skills', 'alpha'), { recursive: true })
  writeFileSync(join(tmp, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n')
  mkdirSync(join(tmp, 'skills', 'beta'), { recursive: true })
  writeFileSync(join(tmp, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\n')
  writeFileSync(join(tmp, 'SKILL.md'), '---\nname: rooted\n---\n')

  const names = await SyncSkills.expandIncludeNames('cli', ['_root', 'skills/*'], tmp)
  expect(new Set(names)).toEqual(new Set(['rooted', 'alpha', 'beta']))

  // Empty / undefined include short-circuits to empty set without I/O.
  expect((await SyncSkills.expandIncludeNames('cli', undefined, tmp)).size).toBe(0)
  expect((await SyncSkills.expandIncludeNames('cli', [], tmp)).size).toBe(0)

  rmSync(tmp, { recursive: true, force: true })
})

test('staleness hash ignores inline entries shadowed by command-derived skills', async () => {
  // Issue 4 regression: when an inline `sync.skills` entry has the same
  // name as a command-derived skill, the inline never lands on disk (the
  // command wins). Changing only the shadowed inline body must NOT trip
  // the staleness check, otherwise users get a false "out of date" prompt
  // for content that was never installed.
  const tmp = join(tmpdir(), `clac-inline-shadow-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  // Single command 'ping' → command-derived skill name 'shadow-tool-ping'
  // (slug of `${cliName} ${firstSegment}`).
  const cli = Cli.create('shadow-tool')
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const v1 = `---
name: shadow-tool-ping
description: shadowed v1
---
body v1
`
  await SyncSkills.sync('shadow-tool', commands, {
    global: false,
    cwd: installDir,
    skills: [{ name: 'shadow-tool-ping', content: v1 }],
  })
  const hash1 = SyncSkills.readHash('shadow-tool')

  // Same shadowed name, completely different body. Hash MUST NOT change.
  const v2 = `---
name: shadow-tool-ping
description: shadowed v2 (totally different)
---
body v2 with much more content
`
  await SyncSkills.sync('shadow-tool', commands, {
    global: false,
    cwd: installDir,
    skills: [{ name: 'shadow-tool-ping', content: v2 }],
  })
  const hash2 = SyncSkills.readHash('shadow-tool')

  expect(hash1).toBeDefined()
  expect(hash2).toBeDefined()
  expect(hash1).toBe(hash2)

  rmSync(tmp, { recursive: true, force: true })
})

test('staleness hash changes when inline sync.skills content changes', async () => {
  // Regression: a compiled binary that re-bakes a SKILL.md body but leaves
  // commands untouched must still trip the out-of-date check, otherwise
  // users keep stale installed skills on disk forever after upgrading.
  const tmp = join(tmpdir(), `clac-inline-stale-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('stale-tool')
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const v1 = `---
name: baked
description: v1
---
v1 body
`
  await SyncSkills.sync('stale-tool', commands, {
    global: false,
    cwd: installDir,
    skills: [{ name: 'baked', content: v1 }],
  })
  const hash1 = SyncSkills.readHash('stale-tool')

  const v2 = `---
name: baked
description: v2
---
v2 body
`
  await SyncSkills.sync('stale-tool', commands, {
    global: false,
    cwd: installDir,
    skills: [{ name: 'baked', content: v2 }],
  })
  const hash2 = SyncSkills.readHash('stale-tool')

  expect(hash1).toBeDefined()
  expect(hash2).toBeDefined()
  expect(hash1).not.toBe(hash2)

  // And: a hash written WITHOUT inline skills must NOT collide with one
  // written with inline content, even when commands are identical. This
  // protects users who add/remove `sync.skills` between releases.
  await SyncSkills.sync('stale-tool', commands, {
    global: false,
    cwd: installDir,
  })
  const hashNoInline = SyncSkills.readHash('stale-tool')
  expect(hashNoInline).not.toBe(hash2)

  rmSync(tmp, { recursive: true, force: true })
})

test('installed SKILL.md contains frontmatter', async () => {
  const tmp = join(tmpdir(), `clac-content-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('my-tool', { description: 'A useful tool' })
  cli.command('run', { description: 'Run something', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('my-tool', commands, {
    global: false,
    cwd: installDir,
  })

  const skillPath = result.paths[0]!
  const content = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
  expect(content).toContain('name:')
  expect(content).toContain('description:')

  rmSync(tmp, { recursive: true, force: true })
})

test('sync returns unquoted descriptions from YAML frontmatter', async () => {
  const tmp = join(tmpdir(), `clac-quoted-description-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const search = Cli.create('search', { description: 'Search items. Use key: value for precision' })
  search.command('list', { description: 'List results', run: () => ({}) })

  const cli = Cli.create('app')
  cli.command('search', search)

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('app', commands, {
    global: false,
    cwd: installDir,
  })

  expect(result.skills).toMatchInlineSnapshot(`
    [
      {
        "description": "Search items. Use key: value for precision. Run \`app search --help\` for usage details.",
        "name": "app-search",
      },
    ]
  `)

  rmSync(tmp, { recursive: true, force: true })
})

test('list returns skills from command map', async () => {
  const cli = Cli.create('test', { description: 'A test CLI' })
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  cli.command('greet', { description: 'Say hello', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.list('test', commands)

  expect(result.length).toBeGreaterThan(0)
  const names = result.map((s) => s.name)
  expect(names).toContain('test-ping')
  expect(names).toContain('test-greet')
  for (const s of result) {
    expect(s.installed).toBe(false)
    expect(s.description).toBeDefined()
  }
})

test('list shows installed status after sync', async () => {
  const tmp = join(tmpdir(), `clac-list-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Sync first to install
  await SyncSkills.sync('test', commands, {
    global: false,
    cwd: installDir,
  })

  // Now list should show installed
  const result = await SyncSkills.list('test', commands)
  expect(result.length).toBeGreaterThan(0)
  for (const s of result) expect(s.installed).toBe(true)

  rmSync(tmp, { recursive: true, force: true })
})

test('list shows not installed when synced skills are removed', async () => {
  const tmp = join(tmpdir(), `clac-list-missing-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const sync = await SyncSkills.sync('test', commands, {
    global: false,
    cwd: installDir,
  })

  rmSync(sync.paths[0]!, { recursive: true, force: true })

  const result = await SyncSkills.list('test', commands)
  expect(result).toHaveLength(1)
  expect(result[0]!.installed).toBe(false)

  rmSync(tmp, { recursive: true, force: true })
})

test('list returns empty for CLI with no commands', async () => {
  const cli = Cli.create('empty')
  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.list('empty', commands)
  expect(result).toHaveLength(0)
})

test('list includes root command skill', async () => {
  const cli = Cli.create('test', {
    description: 'A test CLI',
    run: () => ({ ok: true }),
  })
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const rootCommand = Cli.toRootDefinition.get(cli as any)!
  const result = await SyncSkills.list('test', commands, {
    description: 'A test CLI',
    rootCommand,
  })

  const names = result.map((s) => s.name)
  expect(names).toContain('test')
  expect(names).toContain('test-ping')
})

test('list results are sorted alphabetically', async () => {
  const cli = Cli.create('test')
  cli.command('zebra', { description: 'Z command', run: () => ({}) })
  cli.command('alpha', { description: 'A command', run: () => ({}) })
  cli.command('middle', { description: 'M command', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.list('test', commands)
  const names = result.map((s) => s.name)
  expect(names).toEqual([...names].sort())
})
