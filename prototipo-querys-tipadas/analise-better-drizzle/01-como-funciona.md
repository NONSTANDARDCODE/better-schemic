# 01 — Como o better-drizzle funciona

## Afinal, o que é

> "Drizzle ORM, but better. Minimal, type-safe repository helpers for Drizzle ORM."

O better-drizzle não é um ORM novo e não esconde o Drizzle:

- você **continua definindo as tabelas e as `relations` no Drizzle** (schema é a fonte de verdade);
- você **continua escolhendo o driver** (SQLite / PostgreSQL / MySQL — o dialeto é detectado);
- o `better(db, { schema })` envolve o client Drizzle **uma vez** e gera, para cada tabela, um *delegate* tipado com uma API de repositório consistente;
- você pode **descer para SQL cru** (`$raw`, `$executeRaw`) ou usar o Drizzle diretamente a qualquer momento — inclusive dentro da mesma transação.

Tudo isso remove a "cola" que todo serviço reescreve: point lookups, relação aninhada, payload de paginação, `exists`, `count`, formas de CRUD, filtros aninhados.

## O modelo em camadas

```
Seu schema Drizzle (tabelas + relations)
          │
          ▼
Drizzle client  (drizzle(driver, { schema }))   ← você têm o driver e o db
          │
          ▼
better(db, { schema })                            ← wrapper "uma vez"
          │
          ▼
Better client com um delegate por tabela         ← API de repositório tipada
          │
          ├─ hooks  : efeitos colaterais (auditoria, tracing, métricas)
          ├─ plugins: mutação de operações (soft-delete, timestamps, zod, rules…)
          ├─ transactions, raw SQL, $withContext, extends
          └─ dive até Drizzle puro / $raw quando precisar
```

## Bootstrap (`better(...)`)

Ponto de entrada: `packages/core/src/index.ts` → exporta `better`, `definePlugin`, tipos, erros e `version`.

Em `packages/core/src/shared/client/factory.ts`, `better()` faz três coisas:

```ts
const context = createRuntimeContext(drizzle, options); // 1. contexto uma vez
initializePlugins(context);                             // 2. pluglins uma vez
return createBoundClient(context);                      // 3. client "bound"
```

1. **`createRuntimeContext`** (`shared/client/context.ts`) constrói o contexto runtime: detecta o **dialeto** (pg/sqlite/mysql), indexa as **tabelas** do schema, pré-computa **metadados de tabela** (colunas, relações, dbName) e guarda as opções (plugins, hooks, raw, transaction, locks, relations).
2. **`initializePlugins`** roda o `setup()` de cada plugin **uma vez**, na ordem do array, e falha rápido em config incompatível (`config.requires.columns`).
3. **`createBoundClient`** monta o client:

```ts
const client = Object.create(null);            // sem prototype
for (const [tableName, table] of Object.entries(context.fullSchema)) {
	if (!isTable(table)) continue;
	const delegate = createModelDelegate(context, tableName);
	client[tableName] = delegate;
	context.repositories[tableName] = delegate;
	context.repositories[dbName] = delegate;  // também por nome de tabela no banco
}
```

Ou seja: o mesmo delegate é registrado **duas vezes** no mapa de repositórios — pela chave TypeScript (`'users'`) e pelo nome físico (`'app_users'`) — o que faz `client.repository(name)` aceitar os dois.

O mesmo `createBoundClient` é chamado de novo para **transações** e para clones de **`$withContext`**, re-gerando delegates com o mesmo runtime (os plugins **não** são re-inicializados).

## O delegate por tabela

`packages/core/src/shared/client/delegate.ts` — `createModelDelegate(context, tableName)` retorna um objeto com:

- helpers de plugin: `$model`, `$state`, `$withState(state)` (clona o delegate mergeando estado) e `$withoutPlugins()` (clona sem plugins);
- todos os métodos: `count`, `exists`, `createMany`, `findMany`, `findFirst`, `findOne`, `findUnique`, `create`, `paginate`, `cursor`, `update`, `updateMany`, `updateEach`, `delete`, `deleteMany`, `upsert`, `upsertMany`.

### O `runOperation` — pipeline central

Cada método, na prática, passa por esse esqueleto (`delegate.ts`):

```
checkTransactionNotAborted()
└─ se não há plugins com trabalho para este kind →
     executeOperation(args)            ← fast path, sem pipeline
└─ senão →
     runPluginPipeline(kind, args, state)   ← plugins transformam os args
     executeOperation(args transformados)   ← hooks before*/after* + operação real
     runPluginAfterHooks(...)               ← hooks pós-operação dos plugins
     checkTransactionNotAborted()
```

Nos operadores com resultado nullable (`findFirst`, `findOne`, `findUnique`, `update`, `delete`), o resultado passa por **`attachThrow`** — devolve um `Promise<T | null>` que também tem `.throw([factory])`. Nos reads, por **`attachExplain`** — devolve um thenable preguiçoso com `.explain({...})` que **não executa a query** (ver *Explain* abaixo).

Fast paths: se não há plugins com trabalho relevante, o código **não monta o pipeline** — vai direto a `executeOperation` (operações de configuração simples), que é o que mantém o overhead baixo nos benchmarks.

## Como o `where` tipado vira SQL

`packages/core/src/shared/query/compiler.ts` compila o `where` estruturado em expressões Drizzle (`eq`, `and`, `or`, `inArray`, `like`, `ilike`, `isNull`, `exists`, …).

- `compileSimpleWhere` é o **fast path**: quando o objeto tem só colunas escalares diretas (sem operadores aninhados, sem relações, sem `undefined`), gera um único `and(...)` com `eq`/`isNull`.
- `compileScalarFilter` trata os operadores por tipo: `equals / in / notIn / lt / lte / gt / gte / contains / startsWith / endsWith / mode / not`.
- Valor "puro" significa `equals`; `null` vira `isNull`. `mode: 'insensitive'` troca `like` por `ilike`.
- Operadores lógicos `AND` / `OR` / `NOT` aninham arbitrariamente.
- Filtros de relação (`some` / `every` / `none` / `is` / `isNot`) compilam para subqueries `EXISTS` / `NOT EXISTS` sobre a tabela relacionada.
- `where` também aceita **qualquer `SQL` / `SQLWrapper` do Drizzle** (ex.: `eq(users.id, 1)`), então nada da expressividade do Drizzle se perde.
- `orderBy` aceita `{ col: 'asc' | 'desc' }` ou array; `take` negativo reverte a ordem e lê do fim.

## Relações: loader próprio, não `db.query`

Ao contrário do modo relacional do Drizzle (`db.query.*`), as relações do better-drizzle usam um **batch loader próprio**:

- **1 query raiz + 1 query por nó de relação** (nunca 1 query por linha pai).
- Colunas de ligação internas são selecionadas e **removidas** do payload público.
- Paginação por-pai (`take`/`skip`/`cursor` dentro de uma relação) usa **`row_number()` window queries**.
- `select` e `include` são **mutuamente exclusivos** no mesmo nível.
- `include._count.select` projeta totais como **subqueries correlacionadas** no SQL do nível atual — não adiciona round-trips de count.
- **Muitos-para-muitos**: uma tabela junction com exatamente duas FKs obrigatórias (e sem colunas obrigatórias extras) é **inferida** automaticamente como relação direta; caminhos ambíguos falham na hora do uso e podem ser configurados com `options.relations.manyToMany`.

## Escritas

- **`create`/`update`/`upsert` com relação** (`connect` / `disconnect` / `set`): rodam em uma **transação implícita** quando não há transação ativa; erros de FK/selector não-único fazem rollback da operação inteira.
- **`updateEach`** (`shared/client/operations.ts`): gera **um único** `UPDATE ... SET col = CASE WHEN id = ... THEN ... END ... WHERE id IN (...)`, rejeita `by` duplicados, suporta `select` escalar e `onEmpty`.
- **`upsertMany`**: usa conflito nativo (`ON CONFLICT ... DO UPDATE`), nativa-first — falha rápido em dialetos sem suporte em vez de dar loop por `upsert()`.
- Batch (`createMany`, `updateMany`, `deleteMany`) retorna `{ count, data? }` (data quando o driver tem `RETURNING`). Writes com relação e `select`/`include` ficam só nos single-row.

## Hooks (observam) × plugins (mutam)

- **Hooks do client** (`shared/client/hooks.ts`): efeitos colaterais opcionais — `beforeCreate/afterCreate`, `beforeUpdate/afterUpdate`, `beforeDelete/afterDelete`, `beforeQuery/afterQuery`, `beforeTransaction/afterTransactionCommit/afterTransactionRollback/onTransactionError`, `beforeRaw/afterRaw/onRawError`, `onError`. Recebem um payload rico (ação, tabela, args, resultado, `meta`).
- **Plugins** (`shared/client/plugins.ts` + `definePlugin`): camada de **mutação**. Podem declarar `operationArgs` tipados (ex.: soft-delete adiciona `deleted: 'with'|'without'|'only'` no `findMany` e `mode: 'soft'|'hard'` no `delete`), `transform(op)`, `hooks`, `extendClient(ctx)` e `extendModel(ctx)` (ex.: `restore()`), estado por chamada (`$withState`) e config com requisitos que falham rápido no bootstrap.
- Tanto hooks quanto plugins leem `meta` (per-call) e metadata escopada via `$withContext(...)` — merge: contexto depois per-call vence.

## Transações

`client.transaction(fn, options?)` vive no **client**, não no modelo. O callback recebe um **client Better completo bound à transação** (delegates, plugins, hooks, raw e `transaction` aninhada funcionam).

- **Aninhadas** → savepoints (no SQLite o próprio Drizzle faz callback síncrono, então o better-drizzle usa `BEGIN` / `SAVEPOINT` explícito via `db.run`).
- `tx.rollback(reason)` lança um sinal interno que se transforma em `BetterDrizzleTransactionRollbackError` com `.reason`.
- `tx.afterCommit(cb)` / `tx.afterRollback(cb)` registram efeitos colaterais pós-settle (filas são mergeadas dos savepoints para o pai e executadas no commit raiz).
- **Retries** opt-in: `attempts`, `on: ['deadlock'|'serializationFailure'|'connectionError']`, `delayMs` fixo ou função.
- Opções: `isolationLevel`, `readOnly`, `timeoutMs`, `signal` (AbortSignal), `context`, `name`, `comment`. Em SQLite, `isolationLevel`/`readOnly`/`comment` são no-ops (comportamento configurável: `warn`/`throw`/`ignore`).

## Raw SQL

- `$raw` (tagged template ou objeto `sql` do Drizzle) → parâmetros vinculados, retorna linhas; suporta `map`, `name`, `comment`, `timeoutMs`, `signal`.
- `$executeRaw` → `{ rowsAffected }`.
- `$rawUnsafe(string, params?)` → **desligado por default** (`raw.allowUnsafe`); só aceita `?` placeholders.
- `raw.requireComment` / `raw.timeoutMs` / `raw.unsupportedOptions` configuram defaults globalmente.
- Raw **bypassa** transforms de modelo e hooks CRUD, mas tem hooks próprios (`beforeRaw/afterRaw/onRawError`), e dentro de `client.transaction` roda no client da transação.

## `.explain()` — thenable preguiçoso

Reads retornam um **deferred promise** com `.explain(options?)`:

- chamar `.explain()` roda o `EXPLAIN` (dialeto-específico: `EXPLAIN (OPTIONS)` no PG, `EXPLAIN QUERY PLAN` no SQLite, `EXPLAIN [ANALYZE]` no MySQL) **sem executar a query real**;
- o resultado tem forma `{ driver, operation, statements }`; `statements[].key` = `"data" | "total" | "count" | "exists" | "probe:hasNext" | "probe:hasPrevious"`; `paginate` produz `data`+`total`, `cursor` produz `data`+probes;
- relações aparecem em `deferredRelations`; opções não suportadas ficam em `ignoredOptions`;
- plugins transformam os args vistos pelo EXPLAIN, mas **hooks de query não rodam** no explain.

## Erros

`packages/core/src/shared/errors.ts` define:

- `BetterDrizzleError` com `code`, `status` (HTTP-like), `driver`, `dialect`, `table`, `column`, `constraint`, `operation`, `sqlState`, `details`.
- Normalização de erros do banco via `BetterDrizzleError.from(...)` / `fromDatabaseError(getDatabaseErrorInfo(...))` — detecta driver por padrão (SQLSTATE 5 dígitos = pg; `ER_*`/errno = mysql; `SQLITE_*`/mensagens = sqlite).
- Helpers `isDatabaseError`, `isUniqueViolation`, `isForeignKeyViolation`, `isNotNullViolation`, `isCheckViolation` (cross-dialeto: 23505 / SQLITE_CONSTRAINT_UNIQUE / 1062 etc.).
- Código é política: recurso não suportado no dialeto **falha rápido com erro estruturado** (`LOCK_NOT_SUPPORTED`, `JSONB_QUERY_UNSUPPORTED`, `RAW_UNSAFE_DISABLED`, `REPOSITORY_NOT_FOUND`, …) em vez de degradar silenciosamente.

## Onde fica cada peça no repositório

```
packages/core/src/index.ts                 → exports: better, definePlugin, types, errors, version
packages/core/src/shared/client/factory.ts → bootstrap + client bound + transações + raw
packages/core/src/shared/client/context.ts → runtime context, metadados de tabela
packages/core/src/shared/client/delegate.ts→ createModelDelegate (a API de repositório)
packages/core/src/shared/client/operations.ts → execução real das queries/escritas (hot path)
packages/core/src/shared/client/plugins.ts → initializePlugins, pipeline, estado
packages/core/src/shared/client/hooks.ts   → hooks do client
packages/core/src/shared/client/relations.ts → writes relacionais (connect/disconnect/set)
packages/core/src/shared/client/explain.ts → .explain()
packages/core/src/shared/query/compiler.ts → compila where/select/orderBy/paginação
packages/core/src/shared/errors.ts         → BetterDrizzleError + normalização cross-dialeto
packages/core/src/types/*                  → superfície pública de tipos
benchmark/                                  → suíte de performance (parity vs Drizzle cru)
apps/web/content/docs/*.mdx                 → o site de docs (/docs)
examples/                                   → catálogo de exemplos em markdown
skills/better-drizzle/                      → skill pack para agentes de IA
```