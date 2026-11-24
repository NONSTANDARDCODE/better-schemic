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

const errMsg = (err: unknown) => (err instanceof Error ? err.message : safeText(err))

/** Stringify an unknown thrown value without relying on Object's default `[object Object]`. */
function safeText(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `JSON.stringify` devolve undefined em runtime para funções/símbolos.
  return JSON.stringify(v) ?? ""
}

/** Guard against a cyclic `.cause` chain when printing an error's ancestry. */
const MAX_CAUSE_DEPTH = 8

/** Run `action`, then exit (0 on success / the set exitCode; 1 on a thrown error, printed cleanly). */
export function runAction(action: () => Promise<void>): void {
  action().then(
    // eslint-disable-next-line unicorn/no-process-exit -- CLI deve devolver o exitCode ao shell; throw não preserva o código.
    () => process.exit(process.exitCode ?? 0),
    (error: unknown) => {
      console.error(`\n${fail(errMsg(error))}`)
      if (debugEnabled() || process.argv.includes("--stack")) {
        // eslint-disable-next-line functional/no-loop-statements -- loop com break/await/estado mutável; conversão para map/reduce mudaria a semântica
        for (let e: unknown = error, depth = 0; e && depth < MAX_CAUSE_DEPTH; depth++) {
          console.error(style.dim(e instanceof Error ? (e.stack ?? safeText(e)) : safeText(e)))
          e = e instanceof Error ? e.cause : undefined
          if (e) console.error(style.dim("caused by:"))
        }
      } else {
        console.error(
          style.dim("(re-run with BETTER_SCHEMIC_DEBUG=1 or --stack for the stack trace)"),
        )
      }
      // eslint-disable-next-line unicorn/no-process-exit -- CLI deve devolver o código de falha ao shell.
      process.exit(1)
    },
  )
}
