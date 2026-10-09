import { execFileSync, spawn } from "node:child_process";

/** Read a single git config value (global/system included), or undefined. */
function gitConfig(key: string): string | undefined {
  try {
    const v = execFileSync("git", ["config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The diff pager, resolved the way git does: `pager.diff` → `core.pager` → `$GIT_PAGER` →
 * `$PAGER`. So a user with `core.pager = delta` gets delta for free, with their own config.
 */
export function resolvePager(): string | undefined {
  return (
    gitConfig("pager.diff") ||
    gitConfig("core.pager") ||
    process.env.GIT_PAGER ||
    process.env.PAGER ||
    undefined
  );
}

/** Shells that must never be used as a pager: the diff text would become their script. */
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
]);

/**
 * Split a pager command line into argv — quote/backslash aware, NO shell expansion. This is what
 * keeps a repo-controlled `.env` (`PAGER=…`) or git config from executing arbitrary shell: the
 * value becomes a program + literal args, never a `sh -c` script. Returns `[]` when empty.
 */
export function parsePagerCommand(pager: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let has = false;
  const push = () => {
    if (has) out.push(current);
    current = "";
    has = false;
  };
  for (let i = 0; i < pager.length; i++) {
    const ch = pager[i] as string;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < pager.length) {
        current += pager[++i];
        has = true;
      } else {
        current += ch;
        has = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < pager.length) {
      current += pager[++i];
      has = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      push();
      continue;
    }
    current += ch;
    has = true;
  }
  push();
  return out;
}

/** Pipe `text` through `pager` (a program + args, NEVER a shell); resolve when it exits. */
export function pipeThroughPager(pager: string, text: string): Promise<void> {
  const argv = parsePagerCommand(pager);
  if (argv.length === 0) return Promise.resolve();
  const exe = (argv[0] as string).split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (SHELLS.has(exe))
    return Promise.reject(
      new Error(
        `better-schemic: refusing to run "${pager}" as the pager — a shell would execute the diff text. Use a pager program (e.g. less -R or delta).`,
      ),
    );
  return new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0] as string, argv.slice(1), {
      stdio: ["pipe", "inherit", "inherit"],
      shell: false,
    });
    child.once("error", reject);
    child.once("close", () => resolve());
    // The pager may quit before reading all input (e.g. `less` on a short diff) — ignore EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}
