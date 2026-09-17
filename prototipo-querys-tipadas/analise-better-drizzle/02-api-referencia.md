# 02 — A API do better-drizzle

Referência da superfície pública de `better-drizzle@0.1.1` (e dos pacotes `@better-drizzle/*`), conforme
a documentação oficial em `apps/web/content/docs/`.

## Instalação

```bash
npm install better-drizzle drizzle-orm
```

Peer deps: `drizzle-orm ^0.30` e `typescript ^5`.

## `better(db, options)`

```ts
import { better } from 'better-drizzle';
const client = better(db, { schema });
```

Envolve um client Drizzle e devolve um client tipado. O dialeto (SQLite / PostgreSQL / MySQL) é detectado do client.

### Opções

| Opção | Tipo | Descrição |
| --- | --- | --- |
| `schema` | `Schema` | **obrigatório**. Objeto com tabelas e `relations` do Drizzle. |
| `plugins` | `Plugin[]` | Plugins, executados na ordem do array. |
| `hooks` | `BetterClientHooks` | Hooks de ciclo de vida (efeitos colaterais). |
| `relations` | `{ manyToMany?: [...], inferManyToMany?: boolean }` | Configuração de muitos-para-muitos explícita. |
| `raw` | `RawClientOptions` | `{ enabled, allowUnsafe, requireComment, timeoutMs, unsupportedOptions }` |
| `transaction` | `{ unsupportedOptions?: 'warn' \| 'throw' \| 'ignore' }` | Comportamento de opções não suportadas em transações. |
| `locks` | `{ transactionsOnly?: boolean }` | Força locks de leitura dentro de transação. |

### Métodos do client

| Método | Descrição |
| --- | --- |
| `client.<table>` | delegate de cada tabela (ver abaixo). |
| `client.repository(name)` | resolve delegate por **chave do schema TS** ou **nome da tabela no banco**. |
| `client.extends(objOrFactory)` | adiciona helpers/valores no client; a forma callback recebe o client bound; conflitos falham rápido; reaplicado em `$withContext`/transações. |
| `client.transaction(fn, options?)` | executa `fn(tx)` em transação com o client completo bound. |
| `client.$withContext(meta)` | clona o client com metadata default; `meta` per-call vence em conflito. |
| `client.$raw<T>(...)` | raw read seguro (tagged template ou objeto `sql`). |
| `client.$executeRaw(...)` | raw write seguro → `{ rowsAffected }`. |
| `client.$rawUnsafe<T>(sqlString, params?, options?)` | raw com string; **exige `raw.allowUnsafe`**. |
| `client.afterCommit(cb)` / `client.afterRollback(cb)` | registra callback do escopo de transação corrente (também existem em `tx`). |

## O delegate por tabela (`client.users`, `client.posts`, …)

### Reads

| Método | Assinatura | Retorno | Not-found |
| --- | --- | --- | --- |
| `findMany` | `(args?: QueryArgs)` | `Row[]` | array vazio |
| `findFirst` | `(args?: QueryArgs)` | `ThrowingResult<Row>` | `null` ou `.throw()` |
| `findOne` | `(args?: QueryArgs)` | `ThrowingResult<Row>` (alias de `findFirst`) | `null` ou `.throw()` |
| `findUnique` | `(args: QueryArgs)` | `ThrowingResult<Row>` | `null` ou `.throw()` |
| `count` | `(args?: { where, cursor, meta })` | `number` | `0` |
| `exists` | `(args?: { where, cursor, meta })` | `boolean` | `false` |
| `paginate` | `(args: PaginationArgs)` | `PaginationResult<Row>` | — |
| `cursor` | `(args: CursorArgs)` | `CursorResult<Row>` | — |

Todos os reads **suportam `.explain()`** (thenable preguiçoso). `findFirst`, `findOne`, `findUnique`, `update` e `delete` retornam `ThrowingResult<T>` = `Promise<T | null>` com `.throw([factory])`.

**`QueryArgs`** (reads): `where` · `select` · `include` · `orderBy` · `take` · `skip` · `cursor` · `lock` · `meta`.

### Writes

| Método | Args | Retorno |
| --- | --- | --- |
| `create` | `{ data, skipDuplicates?, select?, include?, meta? }` | `Row \| null` (null se `skipDuplicates` pulou) |
| `createMany` | `{ data[], skipDuplicates?, select?, include?, meta? }` | `BatchResult<Row>` |
| `update` | `{ where, data, select?, include?, meta? }` | `ThrowingResult<Row>` |
| `updateMany` | `{ where?, data, meta? }` | `BatchResult<never>` |
| `updateEach` | `{ by, data[], update, where?, select?, onEmpty?, meta? }` | `BatchResult<T>` |
| `delete` | `{ where, select?, include?, meta? }` | `ThrowingResult<Row>` |
| `deleteMany` | `{ where?, meta? }` | `BatchResult<never>` |
| `upsert` | `{ where, create, update, select?, include?, meta? }` | `Row` |
| `upsertMany` | `{ data[], target, update, select?, batchSize?, where?, meta? }` | `BatchResult<Row>` |

`BatchResult<T>` = `{ count: number; data?: T[] }` (`data` presente quando o driver suporta `RETURNING`).

### `skipDuplicates`

`create` e `createMany`: `true` usa o manuseio default de conflito do dialeto; `['email']` mira colunas
únicas específicas (dialeto-dependente). `create` pulado → `null`; `createMany().count` reflete só o insertado.

### `updateEach`

Gera **um único** `UPDATE ... SET col = CASE WHEN by = ... THEN ... END ... WHERE by IN (...)`. Rejeita `by`
duplicados. `by` é a coluna Drizzle (ex.: `users.id`). `update` são callbacks `(row) => valor`. `onEmpty: 'return' | 'throw'`.

### `upsertMany` — update strategies

- `'all'` → atualiza toda coluna mutável no conflito;
- `['name', 'active']` → só as colunas listadas;
- `{ name: 'Alice', updatedAt: sql\`now()\` }` → objeto explícito;
- `(ctx) => ({ name: ctx.excluded.name, ... })` → callback com `{ excluded, sql, table }`.

Restrições: `target` obrigatório; `include` não suportado (só `select` escalar); `where` é **SQL-only**
(aplicado ao lado update do conflito); nativa-first e **falha rápido** em dialetos sem suporte.

### Helpers de plugin no delegate

| Membro | Descrição |
| --- | --- |
| `$model` | `{ name, dbName, hasColumn(column) }` |
| `$state` | estado plugin corrente |
| `$withState(state)` | clona o delegate com estado mergeado |
| `$withoutPlugins()` | clona o delegate ignorando todos os transform/hooks de plugin |

Plugins também podem **adicionar métodos** (ex.: soft-delete adiciona `restore()` / `restoreById()`) e **args tipados** (ex.: `findMany({ deleted })`, `delete({ mode })`).

## Filtros (`where`)

Valor puro = `equals`; múltiplas chaves = **AND**; `null` = `IS NULL`; aceita `SQL` do Drizzle diretamente.

| Tipo de coluna | Operadores |
| --- | --- |
| String | `equals`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`, `mode` ('default'\|'insensitive'), `not` |
| Number / bigint / Date | `equals`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `not` |
| Boolean | `equals`, `not` |
| Lógico | `AND`, `OR`, `NOT` (aninha arbitrariamente) |
| Relação to-one | `is`, `isNot` |
| Relação to-many | `some`, `every`, `none` |
| JSONB (PG) | `where: { metadata: { json: { 'profile.age': { gte: 18 } } } }` |

```ts
await client.posts.findMany({
	where: {
		AND: [
			{ published: true },
			{ author: { is: { email: { endsWith: '@company.com' } } } },
		],
	},
});
```

## Projeção & relações

- `where` filtra **quais linhas**; `select` controla **quais campos**; `include` mantém a linha inteira + relações.
- `select` e `include` são exclusivos no mesmo nível; uma relação pode receber `{ where, select, orderBy, take, cursor, include }`.
- Colunas de ligação internas saem do payload.
- `include: { _count: { select: { posts: { where: { published: true } }, profile: true } } }` → contagens como subqueries correlacionadas.
- Muitos-para-muitos inferido de junction com 2 FKs obrigatórias; ambiguidade → `options.relations.manyToMany` ou erro no uso.

```ts
const users = await client.users.findMany({
	include: {
		_count: { select: { posts: true } },
		posts: { where: { published: true }, orderBy: { score: 'desc' }, take: 3 },
	},
});
```

## Paginação

### `paginate()` — offset

```ts
const page = await client.users.paginate({ limit: 20, skip: 40, orderBy: [{ id: 'asc' }], where: {...} });
// page.data → Row[]
// page.pagination { type: "offset", page, perPage, total, pageCount, hasNext, hasPrevious }
```

### `cursor()` — cursor

```ts
const next = await client.users.cursor({ limit: 20, orderBy: [{ id: 'asc' }], after: prev.pagination.nextCursor });
// page.pagination { type: "cursor", hasNext, hasPrevious, nextCursor, previousCursor }
```

`after`/`before` nunca juntos; exige `orderBy` estável (idealmente com PK). `count()` e `exists()` honram o filtro `cursor`.

## Escritas relacionais

`create` e o branch create de `upsert` aceitam `connect`; `update` e o branch update de `upsert` aceitam `connect`, `disconnect` e `set` (exclusivo por relação). `set: null` desconecta relação opcional. Seletores devem bater com exatamente 1 linha; rodam em transação implícita quando fora de `client.transaction()`.

```ts
await client.users.update({
	where: { id: 1 },
	data: {
		posts: { connect: [{ id: 2 }], disconnect: { id: 9 } },
		groups: { set: [{ id: 4 }, { id: 5 }] },
	},
});
```

## Locks (`lock`) — PG e MySQL

`findMany/findFirst/findOne/findUnique/paginate/cursor` aceitam `lock`:

```ts
await client.transaction(async (tx) => {
	return tx.posts.findMany({ where: { id: { gt: 0 } }, lock: { mode: 'update', skipLocked: true } });
});
```

- Modi: `'update'` (FOR UPDATE) e `'share'` (FOR SHARE) em PG+MySQL; `'noKeyUpdate'`/`'keyShare'` e `tables` só no PG.
- `skipLocked` e `noWait` são mutuamente exclusivos.
- `count`, `exists` e writes **não** aceitam `lock`.
- `locks: { transactionsOnly: true }` no client força leitura lockada dentro de transação (`LOCK_REQUIRES_TRANSACTION`).
- `include`/`select` de relação com `lock` é rejeitado (a não ser uma relação `One` no fast path) — policy: não dropar lock silenciosamente.

## Transações

```ts
const user = await client.transaction(
	async (tx) => {
		const created = await tx.users.create({ data: {...} });
		tx.afterCommit(() => sendWelcomeEmail(created.email));
		return created;
	},
	{ retries: { attempts: 3, on: ['deadlock', 'serializationFailure'], delayMs: (a) => a * 25 } },
);
```

- `tx.transaction()` aninhada = **savepoint**; `tx.rollback(reason)` aborta; `tx.afterCommit` / `tx.afterRollback`.
- Opções: `isolationLevel`, `readOnly`, `retries`, `timeoutMs`, `signal`, `context`, `name`, `comment`.

## `.throw()` — not-found

```ts
const user = await client.users.findUnique({ where: { email } }).throw(() => new Error('User not found'));
```

## `.explain()`

```ts
const plan = await client.users.findMany({ where: { active: true } }).explain({ analyze: true });
// plan = { driver: 'pg', operation: 'findMany', statements: [{ key, sql, params, appliedOptions, ignoredOptions, raw }] }
```

`paginate` → `["data", "total"]`; `cursor` → `["data", "probe:hasNext", "probe:hasPrevious"]`. PL Transform do plugin refletido; hooks de query não rodam.

## Raw SQL

```ts
const rows = await client.$raw<{ id: number }>`select id from users where active = ${true}`;
const res  = await client.$executeRaw`update users set active = ${false} where id = ${1}`; // { rowsAffected }
const rows = await client.$rawUnsafe<{ id: number }>('select id from users where email = ?', ['x@y.com']);
```

Opções por call: `name`, `comment`, `timeoutMs`, `signal`, `map`.

## Hooks do client

CRUD/query: `beforeCreate/afterCreate`, `beforeUpdate/afterUpdate`, `beforeDelete/afterDelete`, `beforeQuery/afterQuery`.
Transação: `beforeTransaction`, `afterTransactionCommit`, `afterTransactionRollback`, `onTransactionError`.
Raw: `beforeRaw/afterRaw/onRawError`. Geral: `onError`. Todos recebem `meta` (merged).

## Erros & helpers exportados

```ts
import {
	better, definePlugin, OrderType, version,
	isDatabaseError, getDatabaseErrorInfo,
	isUniqueViolation, isForeignKeyViolation, isNotNullViolation, isCheckViolation,
	BetterDrizzleTransactionRollbackError,
	BetterDrizzleError, BetterDrizzleErrorCode,
} from 'better-drizzle';
```

- `OrderType` = `'asc' | 'desc'` (enum Asc/Desc).
- `BetterDrizzleError` carrega `code`/`status`/`driver`/`table`/`column`/`constraint`/`operation` etc.
- Predicados de constraint aceitam constraint/coluna opcional e normalizam PG (SQLSTATE), SQLite (`SQLITE_*`) e MySQL (`ER_*`/errno).

## Plugins oficiais (`@better-drizzle/*`)

| Pacote | O que faz |
| --- | --- |
| `rules` | guardrails de runtime (raw SQL, destructive writes sem `where`, `findMany` sem limite, lock, requireOrderByForCursor, maxLimit, noRawUnsafe…). Níveis: `true`/`false`/`'warn'|'error'|'off'`/objeto. Presets `safe()`, `recommended()`, `strict()`. |
| `eslint` | espelha o subconjunto estaticamente checável do `rules` para IDE/CI (flat config `betterDrizzle.configs.recommended`). |
| `timestamps` | gerencia `createdAt`/`updatedAt` em create/createMany/update/upsert; `mode: 'app' \| 'database'`. |
| `soft-delete` | `delete()` vira estado (a menos de `mode: 'hard'`), filtra deletados por default (`deleted: 'with'|'without'|'only'`), adiciona `restore()`/`restoreById()`, `deletedBy`. |
| `zod` | gera schemas Zod por tabela (expostos em `$zod`), valida create/update/upsert/result, coerce/unknownKeys, overrides por tabela. |

### `definePlugin(...)` — plugins custom

```ts
definePlugin({
	id: '@example/trace-and-visibility',
	name: 'Trace And Visibility',
	version: '1.0.0',
	config: { dialects: ['pg', 'sqlite'], requires: { columns: [{ column: 'deletedAt' }] } },
	operationArgs: { findMany: { traceId: undefined as string | undefined }, delete: { mode: 'soft' as 'soft' | 'hard' } },
	extendModel({ client, model }) { /* novas helpers por delegate */ },
	extendClient(ctx) { /* novos métodos no client */ },
	hooks: { beforeQuery(ctx) { /* observação */ } },
	transform(operation) { /* mutação do where/data antes de executar; undefined para pular */ },
	setup(ctx) { /* roda 1x no bootstrap */ },
});
```

Plugins podem ler `operation.kind/where/data/state/model`, chamar `$withState()`/`$withoutPlugins()`.

## Matriz de suporte (resumo)

| Recurso | SQLite | PostgreSQL | MySQL |
| --- | --- | --- | --- |
| Delegates, hooks, plugins, raw safe | ✅ | ✅ | ✅ |
| Locks (`lock`) | ❌ (erro) | ✅ (+ noKeyUpdate/keyShare/tables) | ✅ (update/share) |
| JSONB filters | ❌ | ✅ | ❌ |
| `skipDuplicates: true` | ✅ | ✅ | dialect-dependent |
| `skipDuplicates: ['col']` | ✅ | ✅ | ❌ |
| `upsertMany` (nativo) | ✅ | ✅ | ❌ (falha rápido) |
| `isolationLevel`/`readOnly` tx | no-op | ✅ | driver-dependent |
| `comment` raw | ❌ | ✅ | ❌ |
| `explain().analyze` | ignored | ✅ | ✅ |

Política geral: recurso não suportado no dialeto **falha rápido com erro estruturado**, nunca degrada silenciosamente.