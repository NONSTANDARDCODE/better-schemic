import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join, resolve } from "node:path"

import * as p from "@clack/prompts"

// The better-schemic version this scaffolder pins is its OWN version (the packages release lockstep), so a
// fresh project always gets a matching set. Inlined at build by the Bun bundler.
import { version as BETTER_SCHEMIC_VERSION } from "../package.json"

const RANGE = `^${BETTER_SCHEMIC_VERSION}`
/** Pretty-print indent for generated JSON files. */
const JSON_INDENT = 2
/** `process.argv` starts with the runtime and the script path. */
const ARGV_START = 2
/** Tail of the install log shown when installation fails. */
const INSTALL_ERROR_TAIL = 8
const bold = (s: string) => `\u001B[1m${s}\u001B[0m`
const dim = (s: string) => `\u001B[2m${s}\u001B[0m`

const PMS = ["bun", "npm", "pnpm", "yarn"] as const
type Pm = (typeof PMS)[number]

type Options = {
  dir?: string
  git: boolean
  install?: boolean // undefined = ask
  pm?: string
  yes: boolean
}

function parseArgs(argv: string[]): Options {
  const o: Options = { git: true, yes: false }
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-y" || a === "--yes") o.yes = true
    else if (a === "--no-install") o.install = false
    else if (a === "--no-git") o.git = false
    else if (a === "--pm") o.pm = argv[++i]
    else if (a === "-h" || a === "--help") {
      printHelp()
      // eslint-disable-next-line unicorn/no-process-exit -- CLI: `--help` encerra com código 0.
      process.exit(0)
    } else if (a.startsWith("-"))
      // An unknown OPTION is an error, never a directory name — a typo must not scaffold a folder
      // named after the flag's value.

      unknownOption(a)
    else if (o.dir === undefined) o.dir = a
  }
  return o
}

/** Refuse an unknown option with the usage (an exit, so the caller never continues). */
function unknownOption(option: string): never {
  console.error(`Unknown option: ${option}\n`)
  printHelp()
  // eslint-disable-next-line unicorn/no-process-exit -- CLI: opção inválida encerra com código 1.
  process.exit(1)
}

function printHelp(): void {
  console.log(`create-better-schemic — scaffold a new Better-schemic project

Usage: create-better-schemic [directory] [options]

Options:
  --pm <name>       ${PMS.join(" | ")} (the package manager to install with)
  --no-install      scaffold only; don't install or run \`better-schemic init\`
  --no-git          don't run \`git init\`
  -y, --yes         accept defaults, no prompts
  -h, --help        show this help`)
}

/** Which package manager invoked us (from npm_config_user_agent), for a sensible default. */
function detectPm(): Pm {
  const ua = process.env.npm_config_user_agent ?? ""
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const pm of PMS) if (ua.startsWith(pm)) return pm

  return "npm"
}

/** Abort cleanly on Ctrl-C / cancel from any prompt. */
function abortIfCancel<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.")
    // eslint-disable-next-line unicorn/no-process-exit -- CLI: cancelamento do prompt encerra com código 1.
    process.exit(1)
  }
  return value as Exclude<T, symbol>
}

// --- templates ---------------------------------------------------------------------------------

// One `db` script aliases the `better-schemic` CLI — `bun run db gen`, `bun run db migrate`, `bun run db seed`,
// etc. (bun/pnpm/yarn forward the subcommand directly; npm needs `npm run db -- gen`).
const SCRIPTS: Record<string, string> = {
  db: "better-schemic",
}

/**
 * The runtime deps a scaffolded project needs. `better-schemic` is ONE package: the authoring
 * surface, the engine and the CLI. Zod and the SurrealDB SDK ship INSIDE it (they are its
 * dependencies, not peers), so the project never installs them itself.
 */
function depMap(): Record<string, string> {
  return { "better-schemic": RANGE }
}

// Kept conservative so it works across TypeScript 5, 6, and 7: `module: "ESNext"` (5.0+) rather than
// "Preserve" (5.4+); `moduleResolution: "bundler"` (5.0+). Seeds load supporting files via `ctx.file()`
// (no import attributes), so nothing here is version-gated.
const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      lib: ["ESNext"],
      module: "ESNext",
      moduleDetection: "force",
      moduleResolution: "bundler",
      noEmit: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      target: "ESNext",
      types: ["node"],
    },
    exclude: ["node_modules"],
  },
  null,
  JSON_INDENT,
)}\n`

/** NEW project → write a fresh package.json. EXISTING → MERGE deps + scripts (never clobber). */
function applyPackageJson(target: string, name: string): string {
  const path = join(target, "package.json")
  const deps = depMap()
  if (!existsSync(path)) {
    const fresh = {
      dependencies: Object.fromEntries(Object.entries(deps).sort()),
      devDependencies: { "@types/node": "^20", typescript: "^5" },
      name,
      private: true,
      scripts: SCRIPTS,
      type: "module",
      version: "0.0.0",
    }
    writeFileSync(path, `${JSON.stringify(fresh, null, JSON_INDENT)}\n`)
    return "+ package.json"
  }
  const pkg = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, string>
    scripts?: Record<string, string>
  }
  pkg.dependencies ??= {}
  const added: string[] = []
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [k, v] of Object.entries(deps)) {
    if (!(k in pkg.dependencies)) {
      pkg.dependencies[k] = v
      added.push(k)
    }
  }
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort())
  pkg.scripts ??= {}
  // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
  for (const [k, v] of Object.entries(SCRIPTS)) if (!(k in pkg.scripts)) pkg.scripts[k] = v

  writeFileSync(path, `${JSON.stringify(pkg, null, JSON_INDENT)}\n`)
  return added.length > 0
    ? `~ package.json (added ${added.join(", ")})`
    : dim("· package.json (deps already present)")
}

/** NEW project → write a fresh tsconfig. EXISTING → keep theirs, with a compatibility note. */
function applyTsconfig(target: string): string {
  const path = join(target, "tsconfig.json")
  if (!existsSync(path)) {
    writeFileSync(path, TSCONFIG)
    return "+ tsconfig.json"
  }
  return dim(
    "· tsconfig.json (kept — needs module esnext/preserve/nodenext + resolveJsonModule for seed imports)",
  )
}

const GITIGNORE = `node_modules/
.env
*.log
.DS_Store
`

// --- write + run -------------------------------------------------------------------------------

function writeIfAbsent(dir: string, file: string, content: string): string {
  const path = join(dir, file)
  if (existsSync(path)) return dim(`· ${file} (exists, skipped)`)

  writeFileSync(path, content)
  return `+ ${file}`
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  capture = false,
): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  })
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- com `stdio: inherit`, spawnSync devolve stdout/stderr null em runtime.
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

/**
 * The CLI entry of the INSTALLED `better-schemic` package, resolved from its own manifest (the
 * `bin` field) — never a hardcoded path, so a change in the package layout can't break the
 * scaffolder.
 */
function resolveCliEntry(target: string): string {
  const require = createRequire(join(target, "package.json"))
  const manifestPath = require.resolve("better-schemic/package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: Record<string, string> | string
  }
  const bin = manifest.bin
  const rel = typeof bin === "string" ? bin : bin?.["better-schemic"]
  if (!rel) {
    throw new Error(
      "the installed `better-schemic` package exposes no `better-schemic` bin — reinstall it.",
    )
  }
  return join(dirname(manifestPath), rel)
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(ARGV_START))
  const tty = process.stdin.isTTY && !opts.yes

  p.intro(bold("create-better-schemic"))

  // 1. directory / name
  let dir = opts.dir
  if (!dir && tty) {
    dir = abortIfCancel(
      await p.text({
        defaultValue: "better-schemic-app",
        message: "Project directory",
        placeholder: "better-schemic-app",
      }),
    )
  }
  dir ||= "better-schemic-app"
  const target = resolve(process.cwd(), dir)
  const name = basename(target)
  mkdirSync(target, { recursive: true })
  const isExisting = existsSync(join(target, "package.json"))
  // Warn for a non-empty NON-project dir (random files); a package.json = a deliberate adapt.
  if (readdirSync(target).length > 0 && !isExisting && tty) {
    const ok = abortIfCancel(
      await p.confirm({
        initialValue: false,
        message: `${bold(dir)} is not empty — continue?`,
      }),
    )
    if (!ok) {
      p.cancel("Aborted.")
      // eslint-disable-next-line unicorn/no-process-exit -- CLI: recusa de sobrescrever diretório encerra com código 1.
      process.exit(1)
    }
  }

  // 2. install? + which package manager (ask, default = detected)
  const detected = detectPm()
  let install = opts.install
  if (install === undefined) {
    install = tty
      ? abortIfCancel(
          await p.confirm({
            initialValue: true,
            message: "Install dependencies now?",
          }),
        )
      : true
  }
  let pm: Pm = (opts.pm as Pm | undefined) ?? detected
  if (!PMS.includes(pm)) {
    p.cancel(`Unknown package manager "${pm}". Known: ${PMS.join(", ")}.`)
    // eslint-disable-next-line unicorn/no-process-exit -- CLI: gerenciador inválido encerra com código 1.
    process.exit(1)
  }
  if (install && !opts.pm && tty) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- estreita o resultado do prompt (string | symbol) para a união Pm.
    pm = abortIfCancel(
      await p.select({
        initialValue: detected,
        message: "Install with which package manager?",
        options: [detected, ...PMS.filter((x) => x !== detected)].map((m) => ({
          label: m === detected ? `${m} (detected)` : m,
          value: m,
        })),
      }),
    ) as Pm
  }

  // 3. write/merge the project envelope (fresh for a new project, merge into an existing one)
  const written = [
    applyPackageJson(target, name),
    applyTsconfig(target),
    writeIfAbsent(target, ".gitignore", GITIGNORE),
  ]
  const header = isExisting ? `Adding Better-schemic to ${name}` : name
  p.log.step(`${bold(header)} ${dim("(SurrealDB)")}\n${written.join("\n")}`)
  if (opts.git && !existsSync(join(target, ".git"))) run("git", ["init", "-q"], target)

  // 4. install + compose on `better-schemic init` (which scaffolds the config + database/)
  if (install) {
    const s = p.spinner()
    s.start(`Installing dependencies with ${pm}`)
    const r = run(pm, ["install"], target, true)
    if (!r.ok) {
      s.stop(`${pm} install failed`)
      p.log.error(r.out.trim().split("\n").slice(-INSTALL_ERROR_TAIL).join("\n"))
      p.outro(`Fix the install, then run ${bold("better-schemic init")}.`)
      // eslint-disable-next-line unicorn/no-process-exit -- CLI: falha na instalação encerra com código 1.
      process.exit(1)
    }
    s.stop("Dependencies installed")
    p.log.step("Scaffolding the schema")
    const runtime = pm === "bun" ? "bun" : "node"
    const cliJs = resolveCliEntry(target)
    run(runtime, [cliJs, "init"], target)
  }

  // 5. next steps
  const cd = dir === "." ? "" : `cd ${dir}\n`
  // npm needs `npm run db -- <sub>` to forward args; bun/pnpm/yarn forward `<pm> run db <sub>` directly.
  const dbCmd = (sub: string) => (pm === "npm" ? `npm run db -- ${sub}` : `${pm} run db ${sub}`)
  const steps = install
    ? `${cd}cp .env.example .env   ${dim("# set your connection")}\n${dbCmd("gen")}\n${dbCmd("migrate")}`
    : `${cd}${pm} install\n${pm} exec better-schemic init\ncp .env.example .env\n${dbCmd("gen")}`
  p.note(steps, "Next steps")
  p.outro(`${bold(name)} is ready.`)
}

try {
  await main()
} catch (error: unknown) {
  p.log.error(error instanceof Error ? error.message : String(error))
  // eslint-disable-next-line unicorn/no-process-exit -- CLI: erro não tratado encerra com código 1.
  process.exit(1)
}
