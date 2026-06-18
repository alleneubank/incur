import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as yamlParse } from 'yaml'

import * as Cli from './Cli.js'
import { formatExamples } from './Cli.js'
import * as Agents from './internal/agents.js'
import * as Skill from './Skill.js'

/**
 * Returns the set of skill names that the configured `include` glob
 * patterns would resolve in `cwd`. Mirrors the naming logic in
 * `SyncSkills.sync()`'s include loop without writing or reading
 * descriptions: non-`_root` patterns use the directory basename (no I/O),
 * `_root` reads the SKILL.md frontmatter for its `name:` value.
 *
 * Used by both `SyncSkills.sync()` and `Cli.serve`'s staleness check to
 * filter inline `sync.skills` entries against the same shadow set the
 * install path uses, so a baked inline body whose name is also matched by
 * an `include` source doesn't produce a false "Skills are out of date"
 * prompt when its content is updated. Frontmatter that fails the safety
 * check is silently dropped from the shadow set; the throwing pre-check
 * lives in `SyncSkills.sync()`'s install path so a real attack still
 * surfaces a hard error there, but the read-time staleness check must not
 * crash the CLI for unrelated commands.
 */
export async function expandIncludeNames(
  cliName: string,
  include: ReadonlyArray<string> | undefined,
  cwd: string,
): Promise<Set<string>> {
  const out = new Set<string>()
  if (!include?.length) return out
  for (const pattern of include) {
    const globPattern = pattern === '_root' ? 'SKILL.md' : path.join(pattern, 'SKILL.md')
    for await (const match of fs.glob(globPattern, { cwd })) {
      if (pattern === '_root') {
        try {
          const content = await fs.readFile(path.resolve(cwd, match), 'utf8')
          const nameMatch = content.match(/^name:[^\S\n]*(.*)$/m)
          const skillName = nameMatch?.[1]?.trim() || cliName
          if (isSafeSkillName(skillName)) out.add(skillName)
        } catch {}
      } else {
        out.add(path.basename(path.dirname(match)))
      }
    }
  }
  return out
}

/** @internal Pure predicate version of `assertSafeSkillName`. */
function isSafeSkillName(name: string): boolean {
  return (
    !!name &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..'
  )
}

/**
 * Throws if a skill name (or SKILL.md frontmatter `name:` value) is shaped
 * such that it could escape `tmpDir` or — after passing through
 * `Agents.install()`'s `sanitizeName()` — collapse to an empty / `.` / `..`
 * value that would resolve `canonicalDir` to `canonicalBase` itself and let
 * the install loop's `rmForce` wipe every installed skill.
 */
function assertSafeSkillName(name: string, prefix: string): void {
  if (!isSafeSkillName(name)) throw new Error(`${prefix} ${JSON.stringify(name)}`)
}

/** Generates skill files from a command map and installs them natively. */
export async function sync(
  name: string,
  commands: Map<string, any>,
  options: sync.Options = {},
): Promise<sync.Result> {
  const { contextRules = [], depth = 1, description, global = true } = options
  const cwd = resolveIncludeCwd({ cwd: options.cwd, global })
  const contextPath = resolveContextPath({ cwd, global, name })

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectEntries(commands, [], groups, options.rootCommand)
  const files = Skill.split(name, entries, depth, groups)

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `incur-skills-${name}-`))
  try {
    const skills: sync.Skill[] = []
    for (const file of files) {
      const nameMatch = file.content.match(/^name:\s*(.+)$/m)
      // Stage under the frontmatter name, not `file.dir`, so a later
      // `include` or `skills` entry with the same skill name overwrites
      // this file in place. `Skill.split` emits `dir = bucket key` (e.g.
      // `auth`) while the frontmatter slug is `<cli>-<bucket>` (e.g.
      // `devctl-auth`), so without this normalization the two sources
      // land at `tmpDir/auth/SKILL.md` and `tmpDir/devctl-auth/SKILL.md`
      // respectively, and `Agents.install()`'s `discoverSkills` walk
      // picks up both as duplicate entries with the same frontmatter
      // name — producing a double path in the install result and a
      // mismatched description in the progress display.
      const skillName = nameMatch?.[1]?.trim() || file.dir || name
      const filePath = file.dir
        ? path.join(tmpDir, skillName, 'SKILL.md')
        : path.join(tmpDir, 'SKILL.md')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, `${file.content}\n`)
      const meta = parseFrontmatter(file.content)
      skills.push({ name: skillName, description: meta.description })
    }

    const context = Skill.generateContext(name, entries, contextRules)
    await fs.mkdir(path.dirname(contextPath), { recursive: true })
    await fs.writeFile(contextPath, `${context}\n`)

    // Include additional SKILL.md files matched by glob patterns
    const tmpDirResolved = path.resolve(tmpDir)
    if (options.include) {
      for (const pattern of options.include) {
        const globPattern = pattern === '_root' ? 'SKILL.md' : path.join(pattern, 'SKILL.md')
        for await (const match of fs.glob(globPattern, { cwd })) {
          let content: string
          try {
            content = await fs.readFile(path.resolve(cwd, match), 'utf8')
          } catch {
            continue
          }
          // `\s*` would match newlines and slide the `(.+)` capture into the
          // next line — for an empty `name:` line, the YAML delimiter `---`
          // on the following line would be picked up as the name. Use
          // `[^\S\n]*` so the match stays anchored to the `name:` line.
          const nameMatch = content.match(/^name:[^\S\n]*(.*)$/m)
          const skillName =
            pattern === '_root'
              ? nameMatch?.[1]?.trim() || name
              : path.basename(path.dirname(match))
          // For non-`_root` patterns the directory basename is structurally
          // safe (no separators by construction). The `_root` case takes
          // its name from the root SKILL.md frontmatter, which is read off
          // disk and could be `..`/`/etc/passwd`/etc — validate it the
          // same way `sync.skills` validates inline names. This vector is
          // reachable in normal use because the shipped CLI defaults to
          // `include: ['_root']` (`src/bin.ts`), so an attacker who can
          // control the root SKILL.md (e.g. via a compromised dependency)
          // would otherwise drop a SKILL.md outside `tmpDir` and the
          // `finally` cleanup wouldn't reach it.
          if (pattern === '_root' && nameMatch?.[1] != null)
            assertSafeSkillName(
              skillName,
              'sync.include _root: invalid SKILL.md frontmatter `name:`',
            )
          const dest = path.join(tmpDir, skillName, 'SKILL.md')
          // Defense in depth: refuse any write whose resolved path is not
          // strictly inside `tmpDir`, so a future regression in the name
          // validator above can never silently land a file outside the
          // cleanup boundary.
          const destResolved = path.resolve(dest)
          if (!destResolved.startsWith(tmpDirResolved + path.sep))
            throw new Error(`sync.include: skill name ${JSON.stringify(skillName)} escapes tmp dir`)
          try {
            await fs.mkdir(path.dirname(dest), { recursive: true })
            await fs.writeFile(dest, content)
            // Include is an *override*, not a fallback: when it finds a
            // skill name already tracked (from the command generator),
            // replace the tracking entry in place so the returned
            // `skills` metadata — and therefore the `skills add` progress
            // display — reflects the hand-authored description, not the
            // command-generated one that would otherwise linger. Read via
            // `parseFrontmatter` so YAML-quoted descriptions (written by
            // `Skill` via `yamlStringify`) round-trip without stray quotes.
            const meta = parseFrontmatter(content)
            const entry: sync.Skill = {
              name: skillName,
              description: meta.description,
              external: true,
            }
            const existingIdx = skills.findIndex((s) => s.name === skillName)
            if (existingIdx >= 0) skills[existingIdx] = entry
            else skills.push(entry)
          } catch {}
        }
      }
    }

    // Include additional SKILL.md files from inline content.
    //
    // Build-time escape hatch for CLIs compiled into single-file executables
    // (e.g. `bun build --compile`): the source tree that `include` globs
    // against no longer exists at runtime, so the caller bakes SKILL.md
    // bodies into the binary via a text import
    // (`import skill from './SKILL.md' with { type: 'text' }`) and passes
    // the strings here. Installed via the same tmpDir pipeline as
    // glob-loaded skills so the downstream install flow is identical.
    //
    // Inline is a *fallback*, not an override: if `include` (or the
    // command generator) already produced a skill with the same name, skip
    // the inline entry entirely. Rationale: in dev mode, `include` reads
    // the live source file, which may be fresher than whatever was baked
    // into the binary at last build; in compiled-binary mode, `include`
    // finds nothing and inline takes over. Using "skip-if-exists" instead
    // of "overwrite" keeps dev-mode edits authoritative.
    if (options.skills) {
      for (const skill of options.skills) {
        // Reject names that could escape `tmpDir` via path traversal *before*
        // touching the filesystem. The downstream `Agents.install()` discovery
        // pass also runs `sanitizeName()`, but only after these writes have
        // already landed — by then a malicious `../foo` payload would have
        // dropped a SKILL.md outside the temp tree, and the `finally` cleanup
        // (which only `rm`s `tmpDir`) would not remove it. Fail loud here
        // instead of silently rewriting, since a path-shaped `name` always
        // indicates a caller bug, not a legitimate use case.
        assertSafeSkillName(skill.name, 'sync.skills: invalid skill name')
        // The frontmatter `name:` is also a vector. `Agents.install()`
        // re-reads SKILL.md from disk and **prefers the frontmatter name
        // over the directory name**, then sanitizes via `sanitizeName()`
        // which collapses `..` to `''`. An empty name then resolves
        // `canonicalDir` to `canonicalBase` itself and `rmForce` would wipe
        // every installed skill. The Agents-layer containment check is the
        // backstop, but we also fail loud here so a buggy caller sees the
        // problem at the source rather than getting a generic install error.
        // `\s*` would match newlines and slide the capture into the next
        // line — for `name: \n---\n` the greedy `(.+)` would then capture
        // the YAML delimiter `---`, smuggling an empty/`...`-shaped name
        // past the validator. Use `[^\S\n]*` (whitespace except newline) so
        // the match stays anchored to the `name:` line.
        const inlineNameMatch = skill.content.match(/^name:[^\S\n]*(.*)$/m)
        if (inlineNameMatch)
          assertSafeSkillName(
            inlineNameMatch[1]?.trim() ?? '',
            'sync.skills: invalid SKILL.md frontmatter `name:`',
          )
        if (skills.some((s) => s.name === skill.name)) continue
        const dest = path.join(tmpDir, skill.name, 'SKILL.md')
        // Defense in depth: even if the regex above misses some platform
        // quirk, refuse to write if the resolved destination is not strictly
        // inside `tmpDir`.
        const destResolved = path.resolve(dest)
        if (!destResolved.startsWith(tmpDirResolved + path.sep))
          throw new Error(`sync.skills: skill name ${JSON.stringify(skill.name)} escapes tmp dir`)
        await fs.mkdir(path.dirname(dest), { recursive: true })
        await fs.writeFile(dest, skill.content)
        const descMatch = skill.content.match(/^description:\s*(.+)$/m)
        skills.push({ name: skill.name, description: descMatch?.[1], external: true })
      }
    }

    const { paths, agents } = Agents.install(tmpDir, { global, cwd })

    // Remove stale skills from previous installs
    const currentNames = new Set(paths.map((p) => path.basename(p)))
    const prev = readMeta(name)
    if (prev?.skills) {
      for (const old of prev.skills) {
        if (currentNames.has(old)) continue
        Agents.remove(old, { global, cwd })
      }
    }

    // Write skills hash + names for staleness detection. Inline entries are
    // filtered against the union of (command-derived skill names ∪ include
    // glob skill names) before hashing, so changing a baked inline body
    // whose name is shadowed by either source doesn't produce a false
    // "Skills are out of date" prompt — that body would never be installed
    // anyway. The staleness check in `Cli.serve` re-runs the same filter
    // (including the include glob walk via `expandIncludeNames`) so both
    // hashes always agree. `rootCommand` is threaded so the root command's
    // own skill participates in the hash (upstream #103).
    const hashEntries = collectEntries(commands, [], undefined, options.rootCommand)
    const generatedNames = Skill.generatedNames(name, hashEntries, depth)
    const includeShadowed = await expandIncludeNames(name, options.include, cwd)
    const shadowed = new Set<string>([...generatedNames, ...includeShadowed])
    const inlineForHash = options.skills?.filter((s) => !shadowed.has(s.name)) ?? undefined
    writeMeta(
      name,
      Skill.hash(hashEntries, inlineForHash),
      [...currentNames],
      [...paths, ...agents.map((agent) => agent.path)],
      cwd,
    )

    return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), paths, agents }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

export declare namespace sync {
  /** Options for syncing skills. */
  type Options = {
    /** Working directory for resolving `include` globs. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Rules to include in generated `CONTEXT.md`. */
    contextRules?: string[] | undefined
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Install globally (`~/.config/agents/skills/`) instead of project-local. Defaults to `true`. */
    global?: boolean | undefined
    /** Glob patterns for directories containing SKILL.md files to include (e.g. `"skills/*"`, `"my-skill"`). Skill name is the parent directory name. */
    include?: string[] | undefined
    /** Root command definition (when the CLI itself has a `run` handler). */
    rootCommand?:
      | {
          description?: string | undefined
          args?: any
          env?: any
          hint?: string | undefined
          options?: any
          output?: any
          examples?: any[] | undefined
        }
      | undefined
    /**
     * Inline SKILL.md entries to install alongside the generated and
     * glob-included ones. Intended for CLIs compiled into single-file
     * executables where `include` globs cannot reach the original source
     * tree at runtime — bake the body in via a text import at build time
     * (e.g. Bun's `import skill from './SKILL.md' with { type: 'text' }`)
     * and pass it through here. Inline entries act as a fallback: if a
     * skill with the same `name` was already produced by the command
     * generator or by `include`, the inline entry is skipped so dev-mode
     * filesystem edits stay authoritative.
     */
    skills?: Array<{ name: string; content: string }> | undefined
  }
  /** Result of a sync operation. */
  type Result = {
    /** Per-agent install details (non-universal agents only). */
    agents: import('./internal/agents.js').install.AgentInstall[]
    /** Canonical install paths. */
    paths: string[]
    /** Synced skills with metadata. */
    skills: Skill[]
  }
  /** A synced skill entry. */
  type Skill = {
    /** Description extracted from the skill frontmatter. */
    description?: string | undefined
    /** Whether this skill was included from a local file (not generated from commands). */
    external?: boolean | undefined
    /** Skill directory name. */
    name: string
  }
}

/** Lists skills derived from a CLI's command map with install status. */
export async function list(
  name: string,
  commands: Map<string, any>,
  options: list.Options = {},
): Promise<list.Skill[]> {
  const { depth = 1, description } = options
  const cwd = options.cwd ?? process.cwd()

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectEntries(commands, [], groups, options.rootCommand)
  const files = Skill.split(name, entries, depth, groups)

  const skills: list.Skill[] = []
  const installed = readInstalledSkills(name, { cwd })

  for (const file of files) {
    const meta = parseFrontmatter(file.content)
    const skillName = meta.name ?? (file.dir || name)
    skills.push({
      name: skillName,
      description: meta.description,
      installed: installed.has(skillName),
    })
  }

  // Include additional SKILL.md files matched by glob patterns
  if (options.include) {
    for (const pattern of options.include) {
      const globPattern = pattern === '_root' ? 'SKILL.md' : path.join(pattern, 'SKILL.md')
      for await (const match of fs.glob(globPattern, { cwd })) {
        try {
          const content = await fs.readFile(path.resolve(cwd, match), 'utf8')
          const meta = parseFrontmatter(content)
          const skillName =
            pattern === '_root' ? (meta.name ?? name) : path.basename(path.dirname(match))
          if (!skills.some((s) => s.name === skillName)) {
            skills.push({
              name: skillName,
              description: meta.description,
              installed: installed.has(skillName),
            })
          }
        } catch {}
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Returns whether any previously synced skills are still installed on disk. */
export function hasInstalledSkills(
  name: string,
  options: { cwd?: string | undefined } = {},
): boolean {
  return readInstalledSkills(name, options).size > 0
}

export declare namespace list {
  /** Options for listing skills. */
  type Options = {
    /** Working directory for resolving `include` globs. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Glob patterns for directories containing SKILL.md files to include. */
    include?: string[] | undefined
    /** Root command definition (when the CLI itself is a command). */
    rootCommand?:
      | {
          description?: string | undefined
          args?: any
          env?: any
          hint?: string | undefined
          options?: any
          output?: any
          examples?: any[] | undefined
        }
      | undefined
  }
  /** A skill entry with install status. */
  type Skill = {
    /** Description extracted from the skill frontmatter. */
    description?: string | undefined
    /** Whether this skill is currently installed. */
    installed: boolean
    /** Skill name. */
    name: string
  }
}

/** Recursively collects leaf commands as `Skill.CommandInfo`. */
function collectEntries(
  commands: Map<string, any>,
  prefix: string[],
  groups: Map<string, string> = new Map(),
  rootCommand?:
    | {
        description?: string | undefined
        args?: any
        env?: any
        hint?: string | undefined
        options?: any
        output?: any
        examples?: any[] | undefined
      }
    | undefined,
): Skill.CommandInfo[] {
  const result: Skill.CommandInfo[] = []
  if (rootCommand) {
    const cmd: Skill.CommandInfo = {}
    if (rootCommand.description) cmd.description = rootCommand.description
    if (rootCommand.args) cmd.args = rootCommand.args
    if (rootCommand.env) cmd.env = rootCommand.env
    if (rootCommand.hint) cmd.hint = rootCommand.hint
    if (rootCommand.options) cmd.options = rootCommand.options
    if (rootCommand.output) cmd.output = rootCommand.output
    const examples = formatExamples(rootCommand.examples)
    if (examples) cmd.examples = examples
    result.push(cmd)
  }
  for (const [name, entry] of commands) {
    const entryPath = [...prefix, name]
    if ('_group' in entry && entry._group) {
      if (entry.description) groups.set(entryPath.join(' '), entry.description)
      result.push(...collectEntries(entry.commands, entryPath, groups))
    } else {
      const cmd: Skill.CommandInfo = { name: entryPath.join(' ') }
      if (entry.description) cmd.description = entry.description
      if (entry.args) cmd.args = entry.args
      if (entry.env) cmd.env = entry.env
      if (entry.hint) cmd.hint = entry.hint
      const options = Cli.getCommandOptionsSchema(entry)
      if (options) cmd.options = options
      if (entry.output) cmd.output = entry.output
      if (entry.mutates)
        cmd.hint = [cmd.hint, 'Use `--dry-run` before executing this mutating command.']
          .filter(Boolean)
          .join(' ')
      if (entry.destructive)
        cmd.hint = [cmd.hint, 'Confirm with the user before executing this destructive command.']
          .filter(Boolean)
          .join(' ')
      const examples = formatExamples(entry.examples)
      if (examples) {
        const cmdName = entryPath.join(' ')
        cmd.examples = examples.map((e) => ({
          ...e,
          command: e.command ? `${cmdName} ${e.command}` : cmdName,
        }))
      }
      result.push(cmd)
    }
  }
  return result.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

function parseFrontmatter(content: string): {
  description?: string | undefined
  name?: string | undefined
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const meta = yamlParse(match[1]!)
  if (!meta || typeof meta !== 'object') return {}
  return meta as { description?: string | undefined; name?: string | undefined }
}

/**
 * Resolves the include-glob root the same way `SyncSkills.sync()` does at
 * write time. Used by the staleness check in `Cli.serve` so the read side
 * walks the same directory as the install side.
 */
export function resolveIncludeCwd(
  options: { cwd?: string | undefined; global?: boolean | undefined } = {},
): string {
  const global = options.global !== false
  return options.cwd ?? (global ? resolvePackageRoot() : process.cwd())
}

/** Resolves the package root from the executing bin script (`process.argv[1]`). Walks up from the bin's directory looking for `package.json`. Falls back to `process.cwd()`. */
function resolvePackageRoot(): string {
  const bin = process.argv[1]
  if (!bin) return process.cwd()
  let dir = path.dirname(
    (() => {
      try {
        // resolve symlinks for normal bin scripts
        return fsSync.realpathSync(bin)
      } catch {
        // Bun compiled binaries use a virtual `/$bunfs/` path for argv[1]
        return process.execPath
      }
    })(),
  )
  const root = path.parse(dir).root
  while (dir !== root) {
    try {
      fsSync.accessSync(path.join(dir, 'package.json'))
      return dir
    } catch {}
    dir = path.dirname(dir)
  }
  return process.cwd()
}

/** Returns the hash file path for a CLI. */
function hashPath(name: string): string {
  const dir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(dir, 'incur', `${name}.json`)
}

/** @internal Writes the skills metadata for staleness detection and cleanup. */
function writeMeta(
  name: string,
  hash: string,
  skills: string[],
  paths: string[],
  includeCwd: string,
) {
  const file = hashPath(name)
  const dir = path.dirname(file)
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(
    file,
    JSON.stringify({ hash, skills, paths, includeCwd, at: new Date().toISOString() }) + '\n',
  )
}

/** @internal Reads the stored metadata for a CLI. */
function readMeta(name: string):
  | {
      hash: string
      paths?: string[] | undefined
      skills?: string[] | undefined
      includeCwd?: string | undefined
    }
  | undefined {
  try {
    return JSON.parse(fsSync.readFileSync(hashPath(name), 'utf-8'))
  } catch {
    return undefined
  }
}

/** Reads the names of previously synced skills that are still installed on disk. */
function readInstalledSkills(
  name: string,
  options: { cwd?: string | undefined } = {},
): Set<string> {
  const meta = readMeta(name)
  if (!meta?.skills?.length) return new Set()

  if (meta.paths?.length) {
    const installed = meta.paths
      .filter((skillPath) => isInstalledSkillPath(skillPath))
      .map((skillPath) => path.basename(skillPath))
    return new Set(installed)
  }

  const cwd = options.cwd ?? process.cwd()
  const bases = [path.join(os.homedir(), '.agents', 'skills'), path.join(cwd, '.agents', 'skills')]
  const installed = meta.skills.filter((skill) =>
    bases.some((base) => isInstalledSkillPath(path.join(base, skill))),
  )
  return new Set(installed)
}

/** Returns whether a skill directory currently contains a skill file. */
function isInstalledSkillPath(skillPath: string): boolean {
  return fsSync.existsSync(path.join(skillPath, 'SKILL.md'))
}

/** Reads the stored skills hash for a CLI. Returns `undefined` if no hash exists. */
export function readHash(name: string): string | undefined {
  return readMeta(name)?.hash
}

/**
 * Reads the cwd that was used to expand `include` globs at the last sync.
 * The staleness check uses this so it walks the same directory as the
 * install path did — a `skills add --no-global` sync anchors to
 * `process.cwd()` at sync time, while the default global sync anchors to
 * `resolvePackageRoot()`, and the read site cannot tell which mode the
 * user picked without this hint. Returns `undefined` if no metadata
 * exists; callers should fall back to `resolveIncludeCwd()` in that case.
 */
export function readIncludeCwd(name: string): string | undefined {
  return readMeta(name)?.includeCwd
}

/**
 * Per-CLI context file path.
 *
 * Historically this returned the shared `CONTEXT.md` at the repo root
 * (project-local mode) or `~/.agents/CONTEXT.md` (global mode), which
 * caused two problems flagged in review:
 *
 * 1. In project-local mode the repo-root `CONTEXT.md` is commonly a
 *    user-authored file (loaded by LLM wrappers, checked into git). Every
 *    `skills add --no-global` run clobbered it.
 * 2. In global mode `~/.agents/CONTEXT.md` is shared across every CLI on
 *    the system. Running `skills add` on any single CLI wiped whatever
 *    the previous one wrote — two CLIs with `incur` context files could
 *    not coexist.
 *
 * The new layout is per-CLI and isolated from user-owned files:
 *
 * - global:        `~/.agents/contexts/<name>.md`
 * - project-local: `<cwd>/.agents/contexts/<name>.md`
 *
 * No migration is done for old files at the legacy path — they are left
 * in place so a user who had content there doesn't silently lose it.
 */
function resolveContextPath(options: { cwd: string; global: boolean; name: string }): string {
  const base = options.global
    ? path.join(os.homedir(), '.agents')
    : path.join(options.cwd, '.agents')
  return path.join(base, 'contexts', `${options.name}.md`)
}
