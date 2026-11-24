import { execFileSync, spawn } from "node:child_process"

/** Read a single git config value (global/system included), or undefined. */
function gitConfig(key: string): string | undefined {
  try {
    const v = execFileSync("git", ["config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return v || undefined
  } catch {
    return undefined
  }
}

/**
 * The diff pager, resolved the way git does: `pager.diff` → `core.pager` → `$GIT_PAGER` →
 * `$PAGER`. A user with `core.pager = delta` gets delta for free, with their own config.
 */
export function resolvePager(): string | undefined {
  // git-like resolution: the FIRST NON-EMPTY value wins — `||` semantics, evaluated on demand so a
  // higher-priority pager avoids the next `git config` subprocess.
  let resolved: string | undefined
  ;[
    (): string | undefined => gitConfig("pager.diff"),
    (): string | undefined => gitConfig("core.pager"),
    (): string | undefined => process.env.GIT_PAGER,
    (): string | undefined => process.env.PAGER,
  ].some((read) => {
    const value = read()
    if (!value) return false
    resolved = value
    return true
  })
  return resolved
}

/** Steps over an escape sequence (the backslash plus its escaped character). */
const ESCAPE_STEP = 2

/** Shells that must never uss it as a pager: the diff text would become their script. */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "ash",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
])

/**
 * Split a pager command line into argv — quote/backslash aware, NO shell expansion. This is what
 * keeps a repo-controlled `.env` (`PAGER=…`) or git config from executing arbitrary shell: the
 * value becomes a program + literal args, never a `sh -c` script. Returns `[]` when empty.
 */
export function parsePagerCommand(pager: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  let has = false
  const push = (): void => {
    if (has) out.push(current)

    current = ""
    has = false
  }
  const scan = (index: number): void => {
    if (index >= pager.length) return
    const ch = pager[index]
    if (quote) {
      if (ch === quote) {
        quote = undefined
        scan(index + 1)
      } else if (ch === "\\" && quote === '"' && index + 1 < pager.length) {
        current += pager[index + 1]
        has = true
        scan(index + ESCAPE_STEP)
      } else {
        current += ch
        has = true
        scan(index + 1)
      }
      return
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      scan(index + 1)
      return
    }
    if (ch === "\\" && index + 1 < pager.length) {
      current += pager[index + 1]
      has = true
      scan(index + ESCAPE_STEP)
      return
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      push()
      scan(index + 1)
      return
    }
    current += ch
    has = true
    scan(index + 1)
  }
  scan(0)
  push()
  return out
}

/** Pipe `text` through `pager` (a program + args, NEVER a shell); resolve when it exits. */
export function pipeThroughPager(pager: string, text: string): Promise<void> {
  const argv = parsePagerCommand(pager)
  if (argv.length === 0) return Promise.resolve()

  const exe = argv[0].split(/[\\/]/u).pop()?.toLowerCase() ?? ""
  if (SHELLS.has(exe)) {
    return Promise.reject(
      new Error(
        `better-schemic: refusing to run "${pager}" as the pager — a shell would execute the diff text. Use a pager program (e.g. less -R or delta).`,
      ),
    )
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      stdio: ["pipe", "inherit", "inherit"],
    })
    child.once("error", reject)
    child.once("close", () => {
      resolve()
    })
    // The pager may quit before reading all input (e.g. `less` on a short diff) — ignore EPIPE.
    child.stdin.on("error", () => void 0)
    child.stdin.end(text)
  })
}
