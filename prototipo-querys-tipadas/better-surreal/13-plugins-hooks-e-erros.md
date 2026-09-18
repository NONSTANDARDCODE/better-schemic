# 13 — Plugins, hooks e erros

## Hooks — observar sem mutar

Registrados em `betterSurreal(db, { hooks })`; rodam em volta de cada operação e nunca alteram os
args (só observam/telemetram). São ideais para logging, tracing, métricas e auditoria leve.

```ts
const client = betterSurreal(db, {
	schema,
	hooks: {
		beforeQuery: ({ table, operation, surql, vars, meta }) => {
			logger.debug({ table, operation, surql }, 'surreal query');
		},
		afterQuery: ({ table, operation, durationMs, count, meta }) => {
			metrics.timing(`surreal.${table}.${operation}`, durationMs);
		},
		onError: ({ table, operation, error, surql, vars }) => {
			logger.error({ err: error, surql }, 'surreal error');
		},
	},
});
```

Lista completa:

| Hook | Quando | Payload principal |
| --- | --- | --- |
| `beforeQuery` / `afterQuery` | reads (find/count/exists/aggregate/paginate/cursor) | `{ table, operation, surql, vars, meta, durationMs, count }` |
| `beforeCreate` / `afterCreate` | `create`, `createMany`, `insert`, `insertMany` | `{ table, operation, data, result, meta }` |
| `beforeUpdate` / `afterUpdate` | `update`, `updateMany`, `updateEach`, `upsert`, `upsertMany` | `{ table, operation, where, data, result, meta }` |
| `beforeDelete` / `afterDelete` | `delete`, `deleteMany` | `{ table, operation, where, result, meta }` |
| `beforeRelate` / `afterRelate` | `relate`, `unrelate`, `relateMany` | `{ edge, from, to, data, result, meta }` |
| `beforeRaw` / `afterRaw` / `onRawError` | `$raw`, `$query`, `$unsafe` | `{ surql, vars, result, durationMs, meta }` |
| `beforeTransaction` / `afterTransactionCommit` / `afterTransactionRollback` / `onTransactionError` | transações | `{ id, context, durationMs, error }` |
| `onError` | qualquer operação com erro | `{ table?, operation, error, surql?, vars? }` |

- Hooks podem ser **async** (o pipeline aguarda).
- Erros lançados em hooks `before*` abortam a operação; em `after*`, são reportados via `onError`
  sem desfazer a operação.
- `meta` (por chamada) e `context` (via `$withContext`) chegam em todos os payloads.

## Plugins — mutar o comportamento

Plugins são a camada de mutação (como no better-drizzle): declararam args extras tipados,
transformam operações, adicionam métodos e hooks.

```ts
import { definePlugin, surql } from 'better-surreal';

export const timestamps = definePlugin({
	id: '@acme/timestamps',
	name: 'Timestamps',
	config: { createdAt: 'createdAt', updatedAt: 'updatedAt' },

	transform(op) {
		if (op.kind === 'create' || op.kind === 'insert') {
			op.data[this.config.createdAt] ??= surql`time::now()`;
		}
		if (op.kind === 'update' || op.kind === 'upsert') {
			op.data[this.config.updatedAt] = surql`time::now()`;
		}
	},
});
```

```ts
const client = betterSurreal(db, { schema, plugins: [timestamps] });
```

> `definePlugin` devolve o plugin pronto. Para plugins configuráveis, exporte uma fábrica:
> `export const timestamps = (config?: TimestampsConfig) => definePlugin({ config, ... })`.

### Contrato do plugin

```ts
type Plugin = {
	id: string;                       // obrigatório e único
	name?: string;
	version?: string;
	description?: string;
	config?: PluginConfig;            // dialetos/colunas exigidas (validado no setup)
	operationArgs?: OperationArgsMap; // args extras por operação (tipados)
	setup?(ctx: PluginSetupContext): void;   // roda 1x no bootstrap
	transform?(op: Operation): void | false; // muta args; false = pula a operação
	hooks?: PluginHooks;             // hooks próprios do plugin (por operação)
	extendClient?(ctx): object;      // métodos no client
	extendModel?(ctx): object;       // métodos no delegate ($model)
};
```

Exemplo com args extras e método novo (soft-delete):

```ts
export const softDelete = definePlugin({
	id: '@acme/soft-delete',
	config: { column: 'deletedAt' },

	operationArgs: {
		findMany:  { deleted: 'without' as 'with' | 'without' | 'only' },
		findFirst: { deleted: 'without' as 'with' | 'without' | 'only' },
		delete:    { mode: 'soft' as 'soft' | 'hard' },
	},

	transform(op) {
		const col = this.config.column;
		if (op.kind.startsWith('find') && op.args.deleted !== 'only') {
			op.where[col] ??= { isNone: true };
		}
		if (op.kind === 'delete' && op.args.mode !== 'hard') {
			op.kind = 'update';
			op.data[col] = surql`time::now()`;
		}
	},

	extendModel({ model }) {
		return {
			restore: (args: { where: Filter<typeof model> }) =>
				model.update({
					where: { ...args.where, [this.config.column]: { isNotNone: true } },
					mode: 'set',
					data: { [this.config.column]: null },
				}),
		};
	},
});
```

```ts
await client.users.findMany({ where });                    // ignora deletados
await client.users.findMany({ where, deleted: 'with' });   // inclui deletados
await client.users.delete({ where });                      // soft delete
await client.users.delete({ where, mode: 'hard' });        // delete real
await client.users.restore({ where: { id: 'users:aeon' } });// método do plugin
```

### Estado por delegate

| Membro | Descrição |
| --- | --- |
| `client.users.$model` | `{ name, dbName, hasField(field), relations }` |
| `client.users.$state` | estado do plugin para aquele delegate |
| `client.users.$withState({...})` | clona o delegate com estado mergeado |
| `client.users.$withoutPlugins()` | clona o delegate ignorando todos os plugins |

## Plugins oficiais

| Pacote | O que faz |
| --- | --- |
| `@better-surreal/timestamps` | preenche `createdAt`/`updatedAt` (modo `'app'` com `time::now()` ou `'database'` se o schema usa `VALUE time::now()`). |
| `@better-surreal/soft-delete` | transforma `delete` em soft delete, filtra deletados, adiciona `restore()`/`restoreById()`, campo `deletedBy`. |
| `@better-surreal/zod` | valida `create`/`insert`/`update`/`upsert` com schemas Zod por tabela; erros viram `ValidationError` com path. |
| `@better-surreal/rules` | guardrails: `noRawUnsafe`, `destructiveWriteWithoutWhere`, `requireLimit` para `findMany`, `requireOrderByFor cursor`, `maxLimit`, `noFullTableScan`. Presets `safe()`, `recommended()`, `strict()`. |
| `@better-surreal/audit` | grava mutações em tabela de auditoria (ou usa changefeed) com `meta.actor`. |
| `@better-surreal/record-id` | gera ids determinísticos/slug (`users:aeon`, `posts:meu-titulo`), evita colisão com sufixo. |
| `@better-surreal/search` | helpers de full-text: score/highlight/offsets tipados e ordenação por relevância. |
| `@better-surreal/vector` | helpers de KNN: `similarity`, `near`, ordenação por distância, checagem de índice HNSW/MTree. |

```ts
import { rules, recommended } from '@better-surreal/rules';
import { zod } from '@better-surreal/zod';

const client = betterSurreal(db, {
	schema,
	plugins: [
		rules(recommended({ maxLimit: 100, noRawUnsafe: true })),
		zod({ validate: { create: true, update: true } }),
	],
});
```

## Erros

```ts
import {
	BetterSurrealError,
	BetterSurrealErrorCode,
	isUniqueViolation,
	isAssertionFailed,
	isPermissionDenied,
	isWriteConflict,
	isTransactionRollback,
	isNotFound,
} from 'better-surreal';
```

```ts
class BetterSurrealError extends Error {
	code: BetterSurrealErrorCode;
	status: number;                 // HTTP-like quando disponível
	table?: string;
	field?: string;
	operation?: string;
	statementIndex?: number;
	surql?: string;
	vars?: Record<string, unknown>;
	details?: unknown;              // payload cru do servidor/SDK
	cause?: unknown;
}
```

### Códigos

| Código | Quando |
| --- | --- |
| `ResultNotFound` | `.throw()` sem resultado / `onEmpty: 'throw'` |
| `DatabaseError` | erro genérico do servidor |
| `ParseError` | SurrealQL inválido (bug de compilação ou `$unsafe`) |
| `AssertionFailed` | `ASSERT`/`TYPE` do schema violado |
| `RecordAlreadyExists` | id duplicado em `CREATE`/`INSERT` |
| `RecordNotFound` | operação sobre registro inexistente |
| `WriteConflict` | conflito otimista de transação |
| `SerializationFailure` | conflito reportado como serialização |
| `PermissionDenied` | permissões/record access negaram |
| `NotAuthenticated` | sem sessão/token |
| `ValidationError` | plugin zod/paths inválidos |
| `UnsafeDisabled` | `$unsafe` sem habilitação |
| `UnsupportedCapability` | recurso desabilitado no servidor (funções, live, etc.) |
| `LiveQueryUnsupported` | live em HTTP ou feature ausente |
| `ClauseNotSupportedInLive` | cláusula inválida em `live()` |
| `TransactionAlreadyActive` | abrir transação dentro de transação |
| `TransactionRollback` | `tx.rollback(reason)` |
| `CursorDirectionConflict` | `after` + `before` juntos |
| `CursorTiebreakerRequired` | `cursor()` sem campo único no fim do `orderBy` |
| `UniqueTargetRequired` | `findUnique`/`upsert` sem id/campo único |
| `ReturnNotSupported` | `return: 'after'` em `delete` |
| `HavingUnsupported` | `having` em `aggregate` |
| `RepositoryNotFound` | `client.repository('...')` desconhecido |
| `UnknownField` | `strict: true` + campo fora do schema |
| `PluginError` | falha no setup/transform de plugin |

### Predicados e `.throw()`

```ts
try {
	await client.users.create({ data: { id: 'users:aeon', name: 'Aeon' } });
} catch (err) {
	if (isUniqueViolation(err)) { /* já existe */ }
}

const user = await client.users.findUnique({ where: { id } })
	.throw();                                  // lança BetterSurrealError('ResultNotFound')

const user2 = await client.users.findFirst({ where }).throw(({ table, where, surql }) =>
	new HttpError(404, `${table} não encontrado`));
```

- Os erros do SurrealDB/SDK (`parseRpcError`, códigos `ERR_*`, mensagens de assert) são normalizados
  para os códigos acima.
- `statementIndex` aponta exatamente qual statement do lote falhou; `surql`/`vars` vêm censurados
  (`vars` opcional via `debug: true` no client).

## Segurança por padrão (recapitulando)

| Padrão | Efeito |
| --- | --- |
| Tudo parametrizado | sem injeção por valores; identificadores validados contra o schema |
| `$unsafe` off | string crua exige opt-in duplo (`raw.unsafe` + rules) |
| `delete`/`update` sem `where` | bloqueados no preset `recommended` do `rules` |
| Permissões/record access | aplicados pelo servidor; erros tipados |
| Capabilities | se o servidor restringe funções (`http::`, `fn::`...), o erro é `UnsupportedCapability` |
| `strict: true` | campos/tabelas desconhecidos falham **antes** de enviar ao banco |
