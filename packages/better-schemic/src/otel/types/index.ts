/** OTEL types — full richness (like pg/drizzle). */

export interface OtelPluginConfig {
  readonly serviceName: string;
  readonly enabled?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
  readonly sampleRate?: number;
  readonly propagation?: "traceparent" | "w3c" | "none";
  readonly debugExport?: boolean;
  // Riqueza total — como pg/drizzle
  readonly dbSystem?: string;         // "surrealdb"
  readonly dbName?: string;
  readonly dbNamespace?: string;         // "main"
  readonly peerName?: string;
  readonly peerPort?: number;
  readonly captureQueryText?: boolean; // default true
  readonly maxQueryTextLength?: number; // default 1000
  readonly enhancedDatabaseReporting?: boolean;
  readonly requestHook?: (info: RequestHookInfo) => void;
  readonly responseHook?: (info: ResponseHookInfo) => void;
  readonly ignoreConnectSpans?: boolean;
  readonly requireParentSpan?: boolean;
}

export interface RequestHookInfo {
  readonly operation: string;
  readonly table?: string;
  readonly sql?: string;
  readonly vars?: Record<string, unknown>;
}

export interface ResponseHookInfo {
  readonly operation: string;
  readonly table?: string;
  readonly sql?: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly rows?: number;
  readonly error?: Error;
}

export interface OtelOperationSpan {
  readonly operation: string;
  readonly table?: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly error?: unknown;
  readonly sql?: string;
  readonly dbStatement?: string;
  readonly dbOperation?: string;
}

export interface OtelSpanConfig {
  readonly serviceName: string;
  readonly sampleRate?: number;
  readonly attributes?: Record<string, unknown>;
}

export const OTEL_BRAND = Symbol.for("better-schemic/otel");
