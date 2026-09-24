/**
 * SurrealDB `EXPLAIN` plan rendering — turns the plan the server returns into a coloured operator
 * tree with metrics and a scan badge.
 *
 * Three live-probed shapes are accepted (see `docs/orm-syntax-map.md` §9):
 *  - structured object — `EXPLAIN FORMAT JSON` / `SELECT … EXPLAIN [FULL]`
 *    (`{ operator, context, attributes, children[], metrics?, total_rows? }`);
 *  - indented string — `EXPLAIN <stmt>` (what `.explain()` emits);
 *  - legacy array — `SELECT … EXPLAIN` on older servers (`[{ operation, detail }]`).
 *
 * The shape is informational and may change between SurrealDB versions, so the renderer degrades to
 * a stringified fallback rather than throwing.
 */
import type { Palette } from "./colors";

/** One rendered operator node. */
export interface PlanNode {
  readonly label: string;
  readonly attrs?: string;
  readonly metrics?: string;
  readonly badge?: string;
  children: PlanNode[];
}

/** A scan badge for the operators worth flagging (full scans vs index use). */
function operatorBadge(operator: string): string | undefined {
  if (/TableScan/.test(operator)) return "⚠ full scan";
  if (/Index(Count)?Scan|KnnScan|FullTextScan|IterateIndex/.test(operator))
    return "✓ index";
  return undefined;
}

/** Humanize a nanosecond duration (`9787` → `9.79µs`). */
export function humanizeNs(ns: number): string {
  if (!Number.isFinite(ns)) return String(ns);
  if (ns < 1000) return `${Math.round(ns * 100) / 100}ns`;
  if (ns < 1e6) return `${Math.round((ns / 1e3) * 100) / 100}µs`;
  if (ns < 1e9) return `${Math.round((ns / 1e6) * 100) / 100}ms`;
  return `${Math.round((ns / 1e9) * 100) / 100}s`;
}

const scalar = (value: unknown): string =>
  typeof value === "string" ? value : String(value);

/** The `rows · batches · elapsed` suffix of an operator's `metrics`. */
function metricsText(metrics: unknown): string | undefined {
  if (!metrics || typeof metrics !== "object") return undefined;
  const m = metrics as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.output_rows === "number") parts.push(`rows ${m.output_rows}`);
  if (typeof m.output_batches === "number")
    parts.push(`batches ${m.output_batches}`);
  if (typeof m.elapsed_ns === "number")
    parts.push(`elapsed ${humanizeNs(m.elapsed_ns)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** The `ctx: … , attr: …` suffix an operator carries. */
function attrsText(attributes: unknown, context: unknown): string | undefined {
  const parts: string[] = [];
  if (typeof context === "string" && context.length > 0)
    parts.push(`ctx: ${context}`);
  if (attributes && typeof attributes === "object")
    for (const [key, value] of Object.entries(attributes))
      parts.push(`${key}: ${scalar(value)}`);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/** Build a node from a structured plan object; `undefined` when it is not one. */
function objectNode(plan: unknown): PlanNode | undefined {
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    return undefined;
  const record = plan as Record<string, unknown>;
  const operator = record.operator;
  if (typeof operator !== "string") return undefined;
  const children = Array.isArray(record.children)
    ? record.children
        .map(objectNode)
        .filter((n): n is PlanNode => n !== undefined)
    : [];
  const metrics = metricsText(record.metrics);
  const total =
    typeof record.total_rows === "number"
      ? `total rows ${record.total_rows}`
      : undefined;
  const badge = operatorBadge(operator);
  const attrs = attrsText(record.attributes, record.context);
  const metricParts = [metrics, total].filter(Boolean).join(" · ");
  return {
    label: operator,
    ...(attrs !== undefined ? { attrs } : {}),
    ...(metricParts ? { metrics: metricParts } : {}),
    ...(badge ? { badge } : {}),
    children,
  };
}

/** Parse the indented string plan into a node tree. */
function stringNodes(text: string): PlanNode[] {
  const roots: PlanNode[] = [];
  const stack: { indent: number; node: PlanNode }[] = [];
  let trailing: string | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (line.trim() === "") continue;
    const total = /^Total rows:\s*(.+)$/i.exec(line.trim());
    if (total) {
      trailing = `total rows ${total[1]}`;
      continue;
    }
    const indent = line.length - line.replace(/^\s+/, "").length;
    const { operator, attrs, metrics } = parseOperatorLine(line.trim());
    const badge = operatorBadge(operator);
    const node: PlanNode = {
      label: operator,
      ...(attrs ? { attrs } : {}),
      ...(metrics ? { metrics } : {}),
      ...(badge ? { badge } : {}),
      children: [],
    };
    while (
      stack.length > 0 &&
      (stack[stack.length - 1] as { indent: number }).indent >= indent
    )
      stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  if (trailing && roots[0]) {
    const first = roots[0];
    roots[0] = {
      ...first,
      metrics: first.metrics ? `${first.metrics} · ${trailing}` : trailing,
    };
  }
  return roots;
}

/** Split `SelectProject [ctx: Db] [projections: *] {rows: 1, …}` into its operator/attrs/metrics. */
function parseOperatorLine(line: string): {
  operator: string;
  attrs?: string;
  metrics?: string;
} {
  const opMatch = /^([^\s[{]+)/.exec(line);
  const operator = opMatch?.[1] ?? line;
  const attrs = [...line.matchAll(/\[([^\]]*)\]/g)]
    .map((m) => m[1] as string)
    .join(", ");
  const metricMatch = /\{([^}]*)\}/.exec(line);
  const metrics = metricMatch?.[1]?.trim();
  return {
    operator,
    ...(attrs ? { attrs } : {}),
    ...(metrics ? { metrics } : {}),
  };
}

/** Normalize any supported plan shape into a node tree (legacy arrays included). */
export function planToNodes(plan: unknown): PlanNode[] {
  if (plan === undefined || plan === null) return [];
  if (typeof plan === "string") {
    const nodes = stringNodes(plan);
    return nodes.length > 0 ? nodes : [{ label: plan.trim(), children: [] }];
  }
  const single = objectNode(plan);
  if (single) return [single];
  if (Array.isArray(plan)) {
    const nodes: PlanNode[] = [];
    for (const entry of plan) {
      if (entry && typeof entry === "object" && "operation" in entry) {
        const record = entry as Record<string, unknown>;
        const detail = record.detail;
        nodes.push({
          label: scalar(record.operation),
          ...(detail && typeof detail === "object"
            ? { attrs: attrsText(detail, undefined) }
            : {}),
          children: [],
        });
      } else {
        const node = objectNode(entry);
        if (node) nodes.push(node);
      }
    }
    if (nodes.length > 0) return nodes;
  }
  return [{ label: safeStringify(plan), children: [] }];
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** Paint one operator node's label + attrs + metrics + badge. */
function labelLine(node: PlanNode, palette: Palette): string {
  let line = palette.paint("\x1b[1;36m", node.label);
  if (node.attrs) line += ` ${palette.paint("\x1b[90m", `[${node.attrs}]`)}`;
  if (node.metrics)
    line += ` ${palette.paint("\x1b[2;37m", `{${node.metrics}}`)}`;
  if (node.badge)
    line += ` ${palette.paint(node.badge.startsWith("⚠") ? "\x1b[33m" : "\x1b[32m", node.badge)}`;
  return line;
}

/** Render a plan into display lines (operator tree with box connectors). */
export function renderPlan(plan: unknown, palette: Palette): string[] {
  const nodes = planToNodes(plan);
  if (nodes.length === 0) return [palette.paint("\x1b[90m", "(no plan)")];
  const out: string[] = [];
  nodes.forEach((node, index) => {
    renderNode(node, "", index === nodes.length - 1, out, palette, true);
  });
  return out;
}

function renderNode(
  node: PlanNode,
  prefix: string,
  isLast: boolean,
  out: string[],
  palette: Palette,
  root: boolean,
): void {
  const connector = root ? "" : isLast ? "└─ " : "├─ ";
  out.push(prefix + connector + labelLine(node, palette));
  const childPrefix = root ? "" : prefix + (isLast ? "   " : "│  ");
  node.children.forEach((child, index) => {
    renderNode(
      child,
      childPrefix,
      index === node.children.length - 1,
      out,
      palette,
      false,
    );
  });
}
