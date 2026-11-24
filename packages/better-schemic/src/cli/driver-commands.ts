// Dispatch for DRIVER-CONTRIBUTED CLI commands — `sc <kind> <verb> [args]` (e.g. surreal
// `sc access rotate <name>`). Core owns this mechanism:
// it discovers `driver.commands`, registers each under its kind, parses argv, resolves the connection,
// and dispatches to `command.run` with a CommandContext. The driver owns each kind/verb's meaning.
//
// Driver commands discover them : the driver loads it from the project's config, so this
// registration runs (async) before `program.parse()`. With no config (e.g. `sc init`), it no-ops.

import { createInterface } from "node:readline/promises"

import type { Command } from "commander"

import {
  type CommandContext,
  type CommandIo,
  type DriverCommand,
  envSecretProvider,
  fail,
  getDriver,
  loadProject,
  ok,
  type ParsedCommandArgs,
  style,
} from "../core"

import { runAction } from "./action"
import { registerInspectVerbs } from "./inspect"
import { assertDriverAvailable, resolveOne, type ResolveOpts } from "./resolve"

/** `process.argv` starts with the runtime and the script path. */
const ARGV_START = 2

/** Stdio + prompt helpers handed to a command, so a driver never touches stdio directly. */
const io: CommandIo = {
  fail: (m) => {
    console.error(fail(m))
  },
  info: (m) => {
    console.log(m)
  },
  ok: (m) => {
    console.log(ok(m))
  },
  async prompt(question, opts) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `"${question}" needs an interactive terminal (no value was provided non-interactively)`,
      )
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    try {
      // `hidden` masks typed input (e.g. a password) so it never echoes to the screen.
      if (opts?.hidden) {
        const out = process.stdout
        const onData = (): boolean => out.write("[2K\r")
        process.stdin.on("data", onData)
        try {
          const answer = await rl.question(`${question} `)
          return answer.trim()
        } finally {
          process.stdin.off("data", onData)
        }
      }
      const answer = await rl.question(`${question} `)
      return answer.trim()
    } finally {
      rl.close()
    }
  },
}

/** Pre-scan argv for `-c`/`--config <path>` so registration loads the right project's driver. */
function configFromArgv(argv: string[]): string | undefined {
  const at = argv.findIndex((a) => a === "-c" || a === "--config" || a.startsWith("--config="))
  if (at === -1) return undefined
  return argv[at].startsWith("--config=") ? argv[at].slice("--config=".length) : argv[at + 1]
}

/**
 * Parse a command's raw positionals + commander option bag into {@link ParsedCommandArgs}, per the
 * command's declared `args`. Core collects ALL positionals (the driver validates arity); flags become
 * a string (value-flag) or boolean. Throws if a `required` flag is missing. Pure — unit-testable.
 */
export function toParsedArgs(
  cmd: DriverCommand,
  positionals: string[],
  opts: Record<string, unknown>,
): ParsedCommandArgs {
  const flags: ParsedCommandArgs["flags"] = {}
  ;(cmd.args?.flags ?? []).forEach((f) => {
    const v = opts[f.name]
    flags[f.name] = f.value ? (v as string | undefined) : Boolean(v)
    if (f.required && (v === undefined || v === false))
      throw new Error(`\`sc ${cmd.kind} ${cmd.verb}\` requires --${f.name}`)
  })
  return { flags, positionals }
}

/** Register one driver command as `sc <kind> <verb>` under its (shared) kind group. */
function addCommand(kindGroup: Command, cmd: DriverCommand, resolveOpts: () => ResolveOpts): void {
  // Positionals are always collected raw (variadic) and the DRIVER validates arity; the declared
  // `args.positionals` shape feeds the usage line + help.
  const usage = (cmd.args?.positionals ?? [])
    .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
    .join(" ")
  const verb = kindGroup
    .command(`${cmd.verb} [args...]`)
    .summary(cmd.summary)
    .description(usage ? `${cmd.summary}\n\nArguments: ${usage}` : cmd.summary)

  ;(cmd.args?.flags ?? []).forEach((f) => {
    const flag = f.value ? `--${f.name} <value>` : `--${f.name}`
    verb.option(flag, f.help ?? "")
  })

  verb.action((args: string[], opts: Record<string, unknown>) => {
    runAction(async () => {
      const parsed = toParsedArgs(cmd, args, opts)

      const config = await resolveOne(resolveOpts())
      const driver = getDriver(config.driver)
      const conn = await driver.connect(config)
      const ctx: CommandContext = {
        config,
        conn,
        io,
        secrets: envSecretProvider,
      }
      try {
        await cmd.run(ctx, parsed)
      } finally {
        await driver.close(conn)
      }
    })
  })
}

/**
 * Register every `sc <kind> <verb>` command from the active driver's project: the CORE-provided
 * `ls`/`info` for each registered kind (+ the top-level `sc ls` overview) and the driver's own
 * contributed `commands` on top, grouped per kind. Runs before `program.parse()`; no-ops entirely when
 * there's no project config (the driver is unknown, e.g. `sc init`). `resolveOpts` reads the global
 * addressing flags (`--connection`/`--config`) off the invoked command at action time.
 */
export async function registerDriverCommands(program: Command): Promise<void> {
  let driverName: string
  const configPath = configFromArgv(process.argv.slice(ARGV_START))
  try {
    const { config } = await loadProject({ config: configPath })
    // Each connection entry carries its driver name directly (no resolve/connect needed): read it off
    // any entry. A project's connections share one driver, so the first is enough.
    const entry = Object.values(config.connections)[0] as undefined | { driver?: string }
    if (!entry?.driver) return

    driverName = entry.driver
  } catch {
    return // no/invalid config (e.g. `sc init`) — driver commands aren't available
  }

  try {
    assertDriverAvailable(driverName)
  } catch {
    return
  }
  const driver = getDriver(driverName)

  // Group verbs under a shared kind command, so the universal `sc <kind> ls`/`info` and any driver
  // verbs (`sc access rotate`, `sc access check`) co-exist under one `sc <kind>` group.
  const groups = new Map<string, Command>()
  const groupFor = (kind: string): Command => {
    let g = groups.get(kind)
    if (!g) {
      g = program
        .command(kind)
        .summary(`inspect + manage ${style.bold(kind)} resources`)
        .description(
          `\`${kind}\` commands: the universal \`ls\`/\`info\` (any kind) plus any driver verbs from @better-schemic/${driverName}.`,
        )
      groups.set(kind, g)
    }
    return g
  }

  // The invoked verb command carries the global addressing flags; read them at action time.
  const resolveOpts = (): ResolveOpts => {
    const opts = program.opts<{ config?: string; connection?: string }>()
    return { config: opts.config ?? configPath, connection: opts.connection }
  }

  // Core-provided READ inspection for EVERY registered kind (`sc <kind> ls`/`info` + top-level `sc ls`).
  registerInspectVerbs(program, driver, groupFor, resolveOpts)

  // The driver's own verbs (e.g. `access rotate`) on top of the universal ls/info.
  ;(driver.commands ?? []).forEach((cmd) => {
    addCommand(groupFor(cmd.kind), cmd, resolveOpts)
  })
}
