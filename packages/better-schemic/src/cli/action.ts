// Shared command-action runner: execute an action to completion, format any error the same way across
// EVERY command (built-ins, driver `sc <kind> <verb>`, and the inspect ls/info), and force `process.exit`
// once it settles so a lingering SDK connection handle can't keep the process alive.
// BETTER_SCHEMIC_DEBUG=1 (legacy: SCHEMIC_DEBUG=1) or --stack prints the full stack + the `.cause`
// chain; otherwise a one-line hint. Watch commands return a never-settling promise, so they keep
// running until SIGINT.
import { fail, style } from "../core"

// Legacy `SCHEMIC_DEBUG` still works; the `BETTER_SCHEMIC_` spelling wins when both sets them.
const debugEnabled = (): boolean =>
  !!process.env.BETTER_SCHEMIC_DEBUG || !!process.env.SCHEMIC_DEBUG

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : safeText(err))

// JSON.stringify declares `string` but yields undefined for functions/symbols at runtime.
const stringify = (value: unknown): string | undefined => JSON.stringify(value)

/** Stringify an unknown thrown value without relying on Object's default `[object Object]`. */
function safeText(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v)
  return stringify(v) ?? ""
}

/** Guard against a cyclic `.cause` chain when printing an error's ancestry. */
const MAX_CAUSE_DEPTH = 8

/** The CLI's single exit seam — a forced exit so lingering SDK handles can't hold the process open. */
const exitProcess = process.exit.bind(process)
const exit: (code?: null | number | string) => never = (code) =>
  Reflect.apply(exitProcess, undefined, [code])

/** Run `action`, then exit (0 on success / the set exitCode; 1 on a thrown error, printed cleanly). */
export function runAction(action: () => Promise<void>): void {
  action().then(
    () => exit(process.exitCode ?? 0),
    (error: unknown) => {
      console.error(`\n${fail(errMsg(error))}`)
      if (debugEnabled() || process.argv.includes("--stack")) {
        const printCause = (e: unknown, depth: number): void => {
          if (!e || depth >= MAX_CAUSE_DEPTH) return
          console.error(style.dim(e instanceof Error ? (e.stack ?? safeText(e)) : safeText(e)))
          const cause = e instanceof Error ? e.cause : undefined
          if (cause) console.error(style.dim("caused by:"))
          printCause(cause, depth + 1)
        }
        printCause(error, 0)
      } else {
        console.error(
          style.dim("(re-run with BETTER_SCHEMIC_DEBUG=1 or --stack for the stack trace)"),
        )
      }
      exit(1)
    },
  )
}
