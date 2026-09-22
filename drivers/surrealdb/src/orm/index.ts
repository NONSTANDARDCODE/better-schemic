/**
 * `@better-schemic/surrealdb/orm` — the repository-style ORM over SurrealDB.
 *
 * ```ts
 * import { Surreal } from "@better-schemic/surrealdb";        // the SDK is re-exported by authoring
 * import { betterSchemic } from "@better-schemic/surrealdb/orm";
 * import { schema } from "./schema";
 *
 * const db = new Surreal();
 * await db.connect("wss://localhost:8000/rpc");
 * await db.use({ namespace: "app", database: "main" });
 *
 * const client = betterSchemic(db, { schema });
 * // M1: await client.users.findMany({ where: { active: true } });
 * ```
 *
 * Authoring (`s.*`, `defineTable`, `defineRelation`, `defineFunction`, `surql`) stays in the root
 * entry — this subpath only consumes it. The typed query surface (reads/writes/relations/…)
 * lands milestone by milestone; see `PLANO-QUERYS-TIPADAS.md`.
 */
export {
  type BetterSchemicOptions,
  betterSchemic,
  type Client,
  ClientRuntime,
  type SchemaArg,
} from "./client";
export {
  type BetterSchemicAuth,
  type CreateBetterSchemicOptions,
  clientFromConfig,
  createBetterSchemic,
} from "./connect";
export {
  createDelegate,
  type Delegate,
  type DelegateContext,
  type ModelDelegate,
  type ModelInfo,
  type ModelKind,
  type RelationDelegate,
} from "./delegate";
export {
  BetterSchemicError,
  type BetterSchemicErrorCode,
  type BetterSchemicErrorOptions,
  isAssertionFailed,
  isBetterSchemicError,
  isNotFound,
  isPermissionDenied,
  isSerializationFailure,
  isTransactionRollback,
  isUniqueViolation,
  isUnsupportedCapability,
  isValidationError,
  isWriteConflict,
  normalizeError,
} from "./errors";
export {
  type ExecuteOptions,
  type ExecuteResult,
  execute,
  type Queryable,
  type Statement,
} from "./execute";
export type {
  ColumnMeta,
  EdgeRef,
  FieldFamily,
  FunctionMeta,
  LinkMeta,
  ModelMeta,
  RecordLinkMeta,
  RelationEndpoints,
  SchemaIndex,
  SchemalessMeta,
  TableMeta,
} from "./meta";
export type { RawOperations, RawQueryTag, RawTag } from "./raw";
export {
  attachThrow,
  type BatchResult,
  lazyResult,
  type NotFoundInfo,
  type StatementResult,
  statementResult,
  type ThrowingResult,
} from "./results";
export { buildSchemaIndex, defineSchema, isSchemaDef } from "./schema";
export type {
  AdminOperations,
  DbInfo,
  ExportOptions,
  NsInfo,
  RootInfo,
  ServerVersion,
  TableInfo,
} from "./types/admin";
export type {
  ApiBodyOptions,
  ApiOperations,
  ApiRequestOptions,
} from "./types/api";
export type { AuthOperations } from "./types/auth";
export type {
  ChangeAction,
  ChangeDefined,
  ChangeDeleted,
  ChangeEntry,
  ChangeRow,
  ChangeSet,
  ChangesArgs,
  ChangesSince,
  ChangeWritten,
} from "./types/changes";
export type {
  CallContext,
  ContextAuth,
  ContextScope,
  OperationContext,
  ResolvedContext,
} from "./types/context";
export type {
  FnArgs,
  FnCall,
  FnMethod,
  FnReturn,
  FnSurface,
} from "./types/fn";
export type {
  CountIncludeOptions,
  EdgeIncludeArg,
  EdgeIncludeOptions,
  IncludeArg,
  LinkIncludeArg,
  LinkIncludeOptions,
  WithIncludes,
} from "./types/include";
export type {
  LiveArgs,
  LiveChange,
  LiveDefaults,
  LiveFetchKeys,
  LiveHandler,
  LiveId,
  LiveNotification,
  LiveReconnected,
  LiveResult,
  LiveRow,
  LiveSubscription,
} from "./types/live";
export type {
  RawDefaults,
  RawMeta,
  RawOptions,
  RawSource,
  RawStatements,
} from "./types/raw";
export type {
  AdjacentEdgeAliases,
  EdgeAliases,
  EdgeAliasKeys,
  EdgeDefAt,
  EdgeTargetDefs,
  EdgeTargetNames,
  EndpointNames,
  LinkKeys,
  LinkTargetDefs,
  LinkTargetNames,
  ManyLinkKeys,
  SingleLinkKeys,
} from "./types/relations";
export type {
  AnyFunctionDef,
  AnyRelationDef,
  AnyTableDef,
  AppAt,
  DefAtName,
  DefName,
  DefsAtNames,
  DefsByName,
  ElementOf,
  FunctionAt,
  FunctionKeys,
  ModelKeys,
  RelationAt,
  RelationKeys,
  SchemaDef,
  SchemaEntry,
  SchemaInput,
  SchemalessKeys,
  SchemaOf,
  TableAt,
  TableKeys,
} from "./types/schema";
export type {
  AggField,
  AggregateArgs,
  AggregateEntry,
  AggregateSelect,
  AggregateShape,
  Aggregator,
  CountArgs,
  FindManyArgs,
  FindManyResult,
  FindOneArgs,
  FindOneResult,
  FindUniqueArgs,
  FindUniqueResult,
  FragmentResult,
  GroupByKey,
  OrderByArg,
  PathValue,
  RangeArg,
  ReadArgs,
  ResultOf,
  SelectArg,
  SelectEntry,
  SelectExpr,
  SelectedShape,
  SelectObject,
  Simplify,
  WithArg,
} from "./types/select";
export type {
  RetryOptions,
  RetryReason,
  TransactionClient,
  TransactionDefaults,
  TransactionOptions,
  UnsupportedPolicy,
} from "./types/transaction";
export type {
  AnyFilter,
  ArrayFilter,
  ComparisonFilter,
  EdgeDirection,
  FamilyOf,
  FieldFilter,
  FieldFilterObject,
  FilterInput,
  Fragment,
  FullTextFilter,
  GeometryFilter,
  OrderedFilter,
  PathFilter,
  RecordFilter,
  ScalarShorthand,
  StringFilter,
  UniversalFilter,
  ValueShorthand,
  Where,
  WhereInput,
  WherePaths,
} from "./types/where";
export type {
  BatchWriteResult,
  CreateArgs,
  CreateData,
  CreatedResult,
  CreateManyArgs,
  CreatePlainArgs,
  CreateRelateArg,
  CreateRelateArgs,
  DeleteArgs,
  DeletedResult,
  DeleteManyArgs,
  EndpointInput,
  InsertArgs,
  InsertManyArgs,
  OnDuplicate,
  PatchArgs,
  PatchOp,
  RelateArgs,
  RelateManyArgs,
  UnrelateArgs,
  UnrelateManyArgs,
  UpdateArgs,
  UpdateData,
  UpdatedResult,
  UpdateEachArgs,
  UpdateEachItem,
  UpdateManyArgs,
  UpdateMode,
  UpsertArgs,
  UpsertManyArgs,
  WriteData,
  WriteMeta,
  WriteReturn,
  WriteValue,
  WrittenResult,
} from "./types/write";
