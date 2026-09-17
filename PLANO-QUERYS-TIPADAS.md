# Plano — ORM & Queries Tipadas (better-schemic)

> **Fontes de design:** `prototipo-querys-tipadas/better-surreal/*` (14 docs da API alvo),
> `prototipo-querys-tipadas/analise-better-drizzle/*` (estilo de API de repositório) e os tutoriais em
> `prototipo-querys-tipadas/surrealdb/*`. Inspiração de implementação: `tmp/better-drizzle` (camada de
> repositório sobre Drizzle) e `tmp/drizzle-orm` (máquina de tipos e pipeline de execução).
>
> **O que este documento é:** o plano de execução completo para **substituir o ORM fluente atual**
> (`select(User).where(...)`, `db.create(T).content(...)`) por uma **camada de repositórios tipada**
> — `client.users.findMany({ where, select, ... })` — construída **do zero** sobre o que já existe
> (authoring `s.*`, codecs, DDL/migrations, conexão gerenciada). O design de **schema** não muda:
> `defineTable`/`defineRelation`/`defineFunction` continuam a fonte de verdade; o ORM só consome.
>
> **Como usar:** a implementação segue **ponto a ponto** na ordem do §7 (M0 → M7). Cada milestone é um
> entregável fechável (ideal: um land), com aceite explícito. Onde o protótipo e o SurrealDB real
> divergirem, vale o que for verificado ao vivo (M0.1) — o protótipo é intenção de design, não verdade
> de sintaxe.

## Status de implementação

| Milestone | Status | Entregáveis |
| --- | --- | --- |
| M0.1 Syntax map ao vivo | ✅ concluído | `drivers/surrealdb/docs/orm-syntax-map.md`, `test/live/orm-syntax.test.ts` (51 probes verdes) |
| M0.2 `defineSchema` + `SchemaIndex` | ✅ concluído | `src/orm/schema.ts`, `src/orm/types/schema.ts`, `src/orm/errors.ts` (classe + catálogo), `test/unit/orm-schema.test.ts`, `test/types/orm-schema.assert.ts` |
| M0.3 Result wrappers + normalização/predicados | ✅ concluído | `src/orm/results.ts` (`ThrowingResult`/`BatchResult`/`StatementResult` + `attachThrow`), `errors.ts` estendido (`from`/`normalizeError` + 8 predicados), `test/unit/orm-errors.test.ts`, `test/unit/orm-results.test.ts`, `test/types/orm-results.assert.ts` |
| M0.4 Executor | ✅ concluído | `src/orm/execute.ts` (1 round-trip via `responses()`, `BEGIN/COMMIT` atômico, falha raiz, binds únicos), `test/unit/orm-execute.test.ts`, `test/live/orm-execute.test.ts` |
| M0.5 Bootstrap + delegates + substituição do legado | ⏳ próximo | `src/orm/index.ts`, `client.ts`, `delegate.ts`, `/orm`, §6 |
| M0.5 Bootstrap + delegates + substituição do legado | ⏳ | `src/orm/index.ts`, `client.ts`, `delegate.ts`, `/orm`, §6 |

> Notas do M0.2: a classe `BetterSchemicError`/catálogo saiu antecipada (o aceite do M0.2 exige
> `SchemaInvalid`); o M0.3 fica com normalização + predicados. `defineSchema`/`SchemaIndex` ainda não
> são re-exportados pelo índice de authoring/`/orm` — isso entra no M0.5 junto da superfície pública.
> Nota do M0.3: o executor (M0.4) usará `responses()` do SDK + `statementResult` para status por
> statement; a normalização cobre `ServerError` por `kind`/details + heurística de mensagem, `ZodError`,
> `Error` comum e throwables não-Error.
> Nota do M0.4 (verificado ao vivo): batch **sem** transação NÃO é atômico (cada statement é
> independente); `BEGIN/COMMIT` é atômico em 1 round-trip e, ao falhar, remarca os statements
> anteriores como `NotExecuted` — o executor escolhe a falha raiz, não o artefato. Detalhes no
> `orm-syntax-map.md` §2.7.

---

## Sumário

- [0. Decisões travadas](#0-decisões-travadas)
- [1. Arquitetura](#1-arquitetura)
- [2. Pontos da API (checklist ponto-a-ponto)](#2-pontos-da-api-checklist-ponto-a-ponto)
- [3. Compilação (lowering)](#3-compilação-lowering)
- [4. Tipagem (type-level)](#4-tipagem-type-level)
- [5. Estrutura de arquivos e subpaths](#5-estrutura-de-arquivos-e-subpaths)
- [6. Remoção do legado](#6-remoção-do-legado)
- [7. Milestones](#7-milestones)
- [8. Testes e verificação](#8-testes-e-verificação)
- [9. Riscos e questões abertas](#9-riscos-e-questões-abertas)
- [Apêndice A — Rastreabilidade protótipo → milestones](#apêndice-a--rastreabilidade-protótipo--milestones)
- [Apêndice B — Onde cada padrão foi colhido (drizzle/better-drizzle)](#apêndice-b--onde-cada-padrão-foi-colhido-drizzlebretter-drizzle)

---

## 0. Decisões travadas

| Item | Decisão | Alternativas descartadas |
| --- | --- | --- |
| **Factory (BYO)** | `betterSchemic(db, { schema, ...opts })` — síncrono, não abre conexão | `betterSurreal` (nome do protótipo), `orm()` |
| **Factory (gerenciada)** | `createBetterSchemic({ url, namespace, database, auth, schema, ...opts })` | só `betterSchemic` + `connect()` |
| **Subpath** | `@better-schemic/surrealdb/orm` | reusar `/client`; `/query` |
| **Builder fluente atual** | **Substituído já** (M0.5): deletado em bloco com o legado, sem coexistência longa | coexistir até M7; manter os dois para sempre |
| **`defineSchema`** | `defineSchema({ users: User, likes: Likes, sendMail, audit: 'audit_log' })` — brand runtime + validação fail-fast; literais diretos também aceitos | objeto literal sem brand |
| **Erros** | `BetterSchemicError` + `BetterSchemicErrorCode` + predicados | `BetterSurrealError` |
| **Plugins oficiais** | subpaths `@better-schemic/surrealdb/plugins/<nome>` | packages separados |
| **Wrapper de resultado** | `ThrowingResult<T>` · `BatchResult<T>` · `StatementResult<T>` | retorno cru |
| **Escopo** | Superfície completa do protótipo, faseada em M0–M7 | MVP primeiro |
| **Este plano** | `PLANO-QUERYS-TIPADAS.md` (raiz) | junto ao driver; dentro do protótipo |

### 0.1 O que muda (visão de 10 000 m)

| Hoje (a remover) | Depois (novo ORM) |
| --- | --- |
| `select(User).where((u) => u.age.gt(18)).return(...)` — builder fluente | `client.users.findMany({ where: { age: { gt: 18 } }, select: {...} })` — um objeto de args |
| `db.select / db.get / db.create / db.update / db.upsert / db.delete / db.relate` no `Client` | delegates por tabela: `client.users.findMany/findUnique/create/insert/update/upsert/delete/relate/...` |
| `select("user")` schemaless ad-hoc | `client.repository("user")` (ou entrada schemaless declarada no `defineSchema`) |
| `db.query(sql, vars)` / `.as([...])` | `client.$raw` / `$query` / `$unsafe` (+ `$sdk`); `$raw` é o escape padrão |
| Sem paginação de 1ª classe | `paginate()` (offset) e `cursor()` (record id/tupla), envelope `{ data, pagination }` |
| Sem `include`/`FETCH`/`_count` | `include` (link/FETCH + grafo + `_count`), filtros `is/isNot/some/every/none` |
| Sem `insert`/`ON DUPLICATE`/`PATCH`/`UNSET`/`updateEach` | todos, por statement nativo |
| Sem transações no client | `client.transaction(fn, { retries, afterCommit, ... })` |
| Sem live/changefeed | `client.users.live(...)`, `client.changes(...)` |
| Sem plugins/hooks/`.throw()`/`.explain()` | `definePlugin`, hooks, `ThrowingResult.throw()`, `.explain()` |
| `@better-schemic/core/query` (Row/Project/decodeProjection/callFunction) | **removido** no M0.5; o compilador novo é driver-owned |

### 0.2 Reuso vs. reescrita (inventário explícito)

**Reusar (não reimplementar):**

| Ativo | Onde | Uso no novo ORM |
| --- | --- | --- |
| `s.*` + `defineTable`/`defineRelation`/`defineSingleton`/`defineFunction` | `drivers/surrealdb/src/pure.ts` | Fonte de tipos/DDL/codecs; nada muda. |
| `App/Create/Update/Wire`, `TableDef.decode/encode/encodePartial/object.shape/singletonId` | `pure.ts` | Decode de linhas, validação fail-fast de writes, metadados. |
| `RecordIdField.tables`, `RelationDef.endpointDefs(dir)` | `pure.ts` | Metadados de link/aresta do `SchemaIndex`. |
| `surql` / `BoundQuery` / `toFragment` / `mergeRaw` / `operandText` / `stripOuterParens` / `argRenderer` / `hasRefDeep` | `pure.ts`, `src/query/render.ts` | Compilação parametrizada e fragments dentro de `where`/`select`/`data` — **movido** para `src/surql/render.ts`. |
| `fn.ts` (catálogo `surql.fn.*`) + `block.ts` | `src/fn.ts`, `src/query/block.ts` | Escape hatches tipados e bodies de função/evento; ficam no `/query`. |
| `FunctionDef`/`CallQuery` + driver `invoke` | `pure.ts`, `driver/surreal.ts` | `client.fn.call` e atalho tipado. |
| `connectFromConfig`/resolver de config/`OrmClientBase`/`asyncDisposable` | `src/client.ts`, `packages/core/src/client.ts` | Conexão gerenciada e ciclo de vida (`await using`). |
| Harness e2e/live + `@ark/attest` + `scripts/type-perf.ts` | `test/e2e/harness.ts`, `test/types/` | Verificação ao vivo e de tipos. |

**Reescrever do zero (o ORM em si):** compilador (`where`/`select`/escritas/`include`/paginação/live),
executor multi-statement, wrappers de resultado, delegates, plugins/hooks, erros,
`$raw`/`$query`/`$unsafe`, `$withContext`, `client.transaction`.

**Remover no M0.5:** ver §6 (inventário completo).

### 0.3 Não-objetivos (disciplina de escopo)

- **Sem schema paralelo / codegen** — os tipos saem do `defineSchema` existente (como no better-drizzle).
- **Sem pool/reconnect próprio** — o ciclo de vida é do SDK; expomos `close()` e `$sdk`.
- **Sem dialetos** — SurrealDB-only (o fork já é). O `SchemaIndex` é driver-owned.
- **Sem `DEFINE`/migrações na API do ORM** — schema continua no engine (`sc gen/migrate/diff`) ou `$raw`.
- **Sem `lock` (`FOR UPDATE`)** — SurrealDB não tem; concorrência = transação otimista + `retries`.
- **Sem `include` com joins manuais** — links/grafos são nativos (`FETCH`/traversal/subqueries).

---

## 1. Arquitetura

```
defineSchema({ users, posts, likes, fn… })                (artefato tipado do app)
        │
        ▼
betterSchemic(db | conn, { schema, plugins, hooks, raw, transaction, live, strict })
        │
        ├─ SchemaIndex      metadados por tabela (colunas, links, arestas, singleton, fns)
        ├─ PluginPipeline   transform(args) → args + operationArgs tipados
        ├─ Compiler         args → BoundQuery { surql, vars }  (SEMPRE parametrizado)
        ├─ Executor         1 conn.query com N statements; status por statement; tx implícita em lotes
        ├─ Decoder          codecs (App<T>) + remontagem de projeções/include/_count
        └─ Results          Row[] · ThrowingResult<T> · BatchResult<T> · PaginationResult<T>
```

### 1.1 `SchemaIndex` (contexto runtime)

Extraído **uma vez** do `defineSchema` no bootstrap; validado fail-fast.

Por **tabela/aresta**:

- `key` (chave TS) · `name` (nome físico) · `singletonId?` · `codec` (`decode`/`encode`/`encodePartial`/`object`);
- `columns`: nome → `{ family: "string"|"number"|"bool"|"date"|"duration"|"array"|"set"|"object"|"record"|"geometry"|"bytes"|"other"|"any"; optional; arrayElem?; targetTables? }` — derivado do shape Zod (consolidar o walker que já existe em `ddl.ts:inferField` e `query/expr.ts:kindOf`);
- `links`: campo → tabelas alvo (`RecordIdField.tables`), desembrulhando `optional`/`nullable`/`array`/`union`;
- `edges`: adjacência de `RelationDef` do schema — `outgoing` (arestas cujo `from` inclui a tabela) e `incoming` (cujo `to` inclui), com `endpointDefs`;
- `functions`: `FunctionDef`s do schema (nome, args Shape, retorno).

Validação de bootstrap: nomes físicos duplicados; chave de relação ambígua (campo × aresta — **campo
vence**, e o conflito é erro de bootstrap); aresta apontando para tabela ausente do schema; `.get(Preset)` sem preset.

### 1.2 Compilador (args → `BoundQuery`)

- Tudo **parametrizado**: valores → `$p0`, `$p1`, …; nomes (tabela/campo/ordem) validados contra o
  índice e interpolados como identificadores escapados (`escapeIdent` / `⟨…⟩`).
- Fast path: `where` só com colunas escalares diretas → um único `AND` sem montar pipeline
  (padrão `compileSimpleWhere` do better-drizzle, `packages/core/src/shared/query/compiler.ts:71`).
- Fragments `surql` aceitos em `where`, `select`, `orderBy`, `data`, `groupBy`, `split` (interpolação
  com binds mesclados — reaproveita `mergeRaw`/`toFragment`).
- Subqueries correlacionadas: refs do registro externo → `$parent.<col>` (já suportado hoje).
- Saída sempre `BoundQuery` (`{ sql, vars }`), pronta para o executor e para composição.

### 1.3 Executor

- **1 round-trip** por operação: `conn.query(...)` com N statements (lotes, `paginate`, `updateEach`,
  `createMany`).
- **Status por statement**: usar `Query.responses()` do SDK v2 para `StatementResult`/`throwOnError:false`;
  sem isso, qualquer statement com erro vira `BetterSchemicError` com `statementIndex` + `surql` + `vars`
  (censurados salvo `debug:true`).
- **Atomicidade**: lotes fora de transação ganham `BEGIN/COMMIT` implícito (ou transação SDK);
  dentro de `client.transaction` usam a transação corrente (sem aninhar).
- Ordem dos resultados preservada; `RETURN NONE` evita payload.

### 1.4 Decoder

- Linha cheia → `TableDef.decode` (codec: `Date`, `RecordId`, `Duration`, `Decimal`, bytes…).
- Projeção → decode **por entrada** (coluna pelo codec do campo; expressão/fragment = passthrough ou
  decode do alvo do builder); `include`/`_count` remontados no cliente quando o SurrealQL devolver
  colunas achatadas (`author_id` → `author: { id }`), conforme verificação do M3.
- `.raw()` por operação? **Não** no desenho do protótipo: quem quer cru usa `$raw`/`$query`.

### 1.5 Result wrappers

```ts
type ThrowingResult<T> = Promise<T | null> & {
  throw(factory?: (info: NotFoundInfo) => Error): Promise<T>;
};
type BatchResult<T> = { count: number; data?: T[]; skipped?: number; statements: number };
type StatementResult<T> = { result: T; status: 'OK' | 'ERR'; time: string; error?: BetterSchemicError };
type NotFoundInfo = { table: string; operation: string; where: unknown; surql: string; vars: Record<string, unknown> };
```

`findMany` nunca lança por vazio; `findFirst/findOne/findUnique/update/delete` → `ThrowingResult`;
`create/insert/upsert` → `Row` (ou `ThrowingResult` com `return:'none'`); lotes → `BatchResult`.
Implementação: thenable + `attachThrow`/`attachExplain` no estilo better-drizzle
(`packages/core/src/shared/client/hooks.ts:314-385`) — custo zero quando não usados.

### 1.6 Pipeline de hooks/plugins

```
checkTransactionNotAborted()
├─ fast path (sem plugin com trabalho no kind) → executeOperation(args)
└─ runPluginPipeline(kind, args, state)          transform(op) muta where/data/kind
   executeOperation(args′)                       hooks before*/after* + operação
   runPluginAfterHooks(...)
```

Hooks **observam** (podem ser async; erro em `before*` aborta, em `after*` vai para `onError`);
plugins **mutam** (`operationArgs` tipados, `transform`, `hooks`, `extendClient`, `extendModel`,
`setup`, `$withState`, `$withoutPlugins`).

### 1.7 Erros

`BetterSchemicError` com `code`, `status`, `table?`, `field?`, `operation?`, `statementIndex?`,
`surql?`, `vars?`, `details?`, `cause?`. Normalização dos erros do SDK/servidor (`ServerError`,
`QueryResponseFailure`, `parseRpcError`, mensagens de ASSERT) + predicados
(`isUniqueViolation`, `isAssertionFailed`, `isPermissionDenied`, `isWriteConflict`,
`isTransactionRollback`, `isNotFound`). Catálogo completo em §2.10.

### 1.8 Mapa de arquivos (novo)

```
drivers/surrealdb/src/orm/
  index.ts          betterSchemic · createBetterSchemic · defineSchema · definePlugin · erros · tipos
  schema.ts         defineSchema + SchemaIndex + validação de bootstrap
  client.ts         bound client (delegates, repository, tables, close, $withContext, extends)
  delegate.ts       createDelegate (tabela/aresta) + $model/$state/$withState/$withoutPlugins
  compiler/
    shared.ts       binds, identificadores, parens, fragments (sobre surql/render)
    where.ts        operadores universais/tipados/lógicos/paths/relacionais
    select.ts       select/omit/orderBy/split/group|groupAll/with/timeout/parallel/version/range
    write.ts        create/createMany/insert/insertMany/update/updateMany/patch/upsert/upsertMany/delete/deleteMany/updateEach/relate/unrelate
    include.ts      FETCH + traversal + _count
    pagination.ts   paginate (offset) + cursor (id/tupla)
    live.ts         LIVE SELECT [DIFF] [FETCH]
  execute.ts        executor multi-statement + status + tx implícita
  results.ts        ThrowingResult/BatchResult/StatementResult/ExplainResult + paginação
  errors.ts         BetterSchemicError + códigos + normalização + predicados
  hooks.ts          tipos + dispatch
  plugins.ts        definePlugin + pipeline + estado
  transaction.ts    client.transaction (sdk/sql, retries, afterCommit/Rollback)
  raw.ts            $raw/$query/$unsafe (+ opções)
  admin.ts          fn.call · api · auth · info/version/ping/export/import
  context.ts        $withContext (USE NS/DB; sessão/isolamento) + fork
  live.ts           live delegate/dinâmica + LiveSubscription + changes
  types/
    schema.ts       SchemaDef/SchemaOf/keys
    where.ts        Where<T> + operadores
    select.ts       Select/Include/OrderBy/Omit + ResultOf
    results.ts      wrappers públicos
    plugin.ts       Plugin/Operation/OperationArgs/Hook payloads

drivers/surrealdb/src/surql/
  render.ts         (movido de src/query/render.ts) Ctx/FRAGMENT/RefState/renderRef/renderData/
                    mergeRaw/operandText/stripOuterParens/argRenderer/toFragment/hasRefDeep
```

Subpath novo no `package.json` do driver: `"./orm"`. `/query` permanece (fragments: `surql`/`fn`/`block`).
`/client` **sai no M0.5**.

---

## 2. Pontos da API (checklist ponto-a-ponto)

> Esta seção é a **checklist de cada ponto** da API. Legenda de milestone: M0 fundação · M1 leitura ·
> M2 escrita · M3 relação/grafo · M4 tx/live · M5 raw/admin · M6 plugins · M7 hardening.
> 🔶 = decide/verifica no milestone indicado (sintaxe SurrealDB real, via M0.1).

### 2.1 Bootstrap e client (M0)

| ID | Ponto | Contrato | Milestone |
| --- | --- | --- | --- |
| B1 | `betterSchemic(db, opts)` | BYO; síncrono; `close()` no-op; recebe `Surreal`/`SurrealSession` | M0.5 |
| B2 | `createBetterSchemic(opts)` | `{ url, namespace, database, auth, schema, connectTimeoutMs, ...opts }`; conecta+auth; `close()` fecha | M0.5 |
| B3 | `defineSchema({...})` | brand runtime; aceita `TableDef`/`RelationDef`/`FunctionDef`/`string`; validação fail-fast | M0.2 |
| B4 | `client.<key>` | delegate da tabela/aresta (chave do schema) | M0.5 |
| B5 | `client.repository(name)` | delegate dinâmico (chave TS ou nome físico); `RepositoryNotFound`; registro dual `Object.create(null)` | M0.5 |
| B6 | `client.tables` | nomes conhecidos | M0.5 |
| B7 | `client.extends(fn \| obj)` | helpers do projeto (reaplicado em clones/tx); conflito = fail-fast | M5.3 |
| B8 | `client.transaction(fn, opts?)` | ver §2.6 | M4.1 |
| B9 | `client.live(table, args, cb)` | live dinâmica | M4.2 |
| B10 | `client.changes(args)` | `SHOW CHANGES` | M4.3 |
| B11 | `client.fn.call(nameOrDef, args?)` + `client.fn.<key>(args)` | funções definidas | M5.2 |
| B12 | `client.api.get/post/put/patch/delete` | `DEFINE API` | M5.2 |
| B13 | `client.auth.signin/signup/authenticate/invalidate/record` | auth (incl. record access) | M5.2 |
| B14 | `client.$withContext({ namespace?, database?, auth?, meta? })` | clone com NS/DB/sessão/contexto; override por chamada | M5.3 |
| B15 | `client.$raw` / `$query` / `$unsafe` | §2.8 | M5.1 |
| B16 | `client.info(level, table?)` | `INFO FOR ROOT/NS/DB/TABLE` | M5.2 |
| B17 | `client.version()` / `client.ping()` | saúde | M5.2 |
| B18 | `client.export()` / `client.import(dump)` | dump/restore | M5.2 |
| B19 | `client.afterCommit(cb)` / `afterRollback(cb)` | escopo de transação corrente | M4.1 |
| B20 | `client.close()` · `[Symbol.asyncDispose]` | ciclo de vida (BYO = no-op no close) | M0.5 |
| B21 | `client.forkSession()` | sessão própria (auth) → novo client bound | M5.3 |
| B22 | `client.$sdk` | o `Surreal` original | M0.5 |
| B23 | `client.version`/`defineSchema` types | `SchemaOf`, `Client<S>`, `TableKeys<S>` | M0.2/M0.5 |
| B24 | Integração `defineConfig().connect()` | opener lazy do `surrealConnection` devolve o client `/orm` | M0.5 |

```ts
const client = betterSchemic(db, { schema, plugins?, hooks?, raw?, transaction?, live?, strict?, debug? });
const managed = await createBetterSchemic({ url, namespace, database, auth, schema, connectTimeoutMs });
```

### 2.2 Delegate — leitura (M1)

| ID | Método | Args principais | Retorno | Lowering |
| --- | --- | --- | --- | --- |
| R1 | `findMany(args?)` | `where, select, include, omit, orderBy, limit/take, start/skip, range, split, groupBy, groupAll, only, value, with, timeout, parallel, version, explain, meta` | `Row[]` | `SELECT …` |
| R2 | `findFirst(args?)` / `findOne(args?)` | idem | `ThrowingResult<Row>` | `SELECT … LIMIT 1` |
| R3 | `findUnique(args)` | `where` (id ou campo único) | `ThrowingResult<Row>` | `SELECT * FROM ONLY t:id` ou `WHERE uniq = $p LIMIT 1` |
| R4 | `count(args?)` | `where, range, timeout, parallel, version, meta` | `number` | `SELECT count() … GROUP ALL` |
| R5 | `exists(args?)` | idem | `boolean` | `SELECT VALUE id … LIMIT 1` |
| R6 | `aggregate(args)` | `where, groupBy, groupAll, split, select (agregadores), orderBy, limit/start, timeout, parallel, version, meta` | `Row[]` | `SELECT count()/math::sum/… GROUP BY/ALL` |
| R7 | `paginate(args)` | leitura + `limit, start, count?` | `PaginationResult<Row>` | 2 statements no mesmo `db.query` |
| R8 | `cursor(args)` | leitura + `limit, orderBy, after?, before?` | `CursorResult<Row>` | `WHERE id > $c` (ou tupla) + probes |
| R9 | `.throw(factory?)` | — | `Promise<Row>` | `ResultNotFound` com `NotFoundInfo` |
| R10 | `.explain(options?)` / `explain: true` | — | `ExplainResult` | `EXPLAIN …` (não executa; não dispara hooks) |

`select` (§2.2.1), `where` (§2.2.2), `orderBy`/cláusulas (§2.2.3).

#### 2.2.1 Formas de `select`

| Forma | Exemplo | SurrealQL |
| --- | --- | --- |
| campos | `{ id: true, title: true }` / `['id','title']` | `SELECT id, title` |
| caminho | `{ 'address.city': true }` | `SELECT address.city` |
| alias | `{ authorName: 'author.name' }` | `SELECT author.name AS authorName` |
| sub-objeto | `{ address: { city: true } }` | `SELECT address.city, …` 🔶 (mensagem exata no M0.1) |
| tudo + extras | `{ '*': true, score: surql`…` }` | `SELECT *, <expr> AS score` |
| expressão tipada | `{ idade: surql`age + ${1}` }` | `SELECT age + $p0 AS idade` |
| `value: true` | `select: { name: true }, value: true` | `SELECT VALUE name` |
| `omit` | `omit: ['password']` | `SELECT * OMIT password` |
| `only: true` | `only: true` (findMany) | `FROM ONLY` (objeto, não array) |

#### 2.2.2 `where` — vocabulário completo

Regras: múltiplas chaves = **AND**; valor puro = `equals`; `null` = `= NULL`; `NONE` = `= NONE`;
operadores no mesmo campo = AND; chaves `AND`/`OR`/`NOT` podem conviver com campos; **tudo parametrizado**.

| Categoria | Operadores |
| --- | --- |
| Igualdade | valor puro/`equals`, `notEquals`, `exact` (`==`), `isNull`/`isNotNull`, `isNone`/`isNotNone` |
| Comparação | `lt`, `lte`, `gt`, `gte`, `between: [a,b]`, `outside: [a,b]`, `any: {…}` (`?<`…), `all: {…}` (`*<`…) |
| Conjuntos | `in`, `notIn`, `inRange: [a,b]` |
| Strings | `contains` (substring, `CONTAINS`), `startsWith`/`endsWith` (`string::*`), `fuzzy` (`~`) 🔶, `anyFuzzy`/`allFuzzy` (`?~`/`*~`) 🔶, `matches` (`string::matches`), `eqInsensitive`, `containsInsensitive`, `matchesFullText` (`@@`/`@n@`) |
| Arrays/sets | `contains`, `containsNot`, `containsAll`, `containsAny`, `containsNone`, `inside`, `notInside`, `allInside`, `anyInside`, `noneInside`, `outside`, `intersects`, `anyEquals` (`?=`), `allEquals` (`*=`), `length` |
| Geo | `intersects`, `inside`, `near` (não-vetorial: `geo::distance ≤ r`) |
| Vetorial | `near: { vector, k, distance? }` → `<\|k,metric\|>` |
| Records | valor `RecordId`, `contains*` em arrays de records |
| Lógicos | `AND`, `OR`, `NOT` (negam grupos), `not` por campo |
| Paths | `'address.city'`, `'contacts[*].type'` 🔶, `'contacts[0].value'` 🔶 |
| Cru | fragmento `surql` como valor de campo ou `where` inteiro |

#### 2.2.3 Cláusulas de leitura

| Arg | SurrealQL | Notas |
| --- | --- | --- |
| `orderBy: [{ createdAt: 'desc' }, { name: 'asc' }]` | `ORDER BY createdAt DESC, name ASC` | aceita `surql` e `{ campo: surql`…` }` |
| `range: { start, end, inclusive? }` | `FROM users:1..=users:100` | alvo de tabela (record range) |
| `split: 'tags'` | `SPLIT tags` | desdobra array em linhas |
| `groupBy: ['address.country']` | `GROUP BY address.country` | |
| `groupAll: true` | `GROUP ALL` | |
| `with: { index: 'idx' \| ['a','b'], noIndex: true }` | `WITH INDEX idx` / `WITH NOINDEX` | |
| `timeout: '10s' \| number` | `TIMEOUT 10s` | número = ms |
| `parallel: true` | `PARALLEL` | |
| `version: '2025-01-01T00:00:00Z' \| Date` | `VERSION d'…'` | requer changefeed 🔶 |
| `explain: true` | `EXPLAIN …` | não executa |
| `meta` | — | hooks/plugins |

### 2.3 Delegate — escrita (M2)

| ID | Método | Args | Retorno | Lowering |
| --- | --- | --- | --- | --- |
| W1 | `create({ data, only?, return? })` | `data` validado por `Create<T>` | `Row` (ou `ThrowingResult` com `return:'none'`) | `CREATE [ONLY] t CONTENT $p` |
| W2 | `createMany({ data[], skipDuplicates?, return? })` | N creates em 1 query | `BatchResult<Row>` | `BEGIN; CREATE …; CREATE …; COMMIT;` |
| W3 | `insert({ data, onDuplicate?, return? })` / `insertMany` | `'ignore' \| 'update' \| mapa surql` | `Row` / `BatchResult<Row>` | `INSERT [IGNORE] INTO t $p [ON DUPLICATE KEY UPDATE …]` |
| W4 | `update({ where, data?, mode?, unset?, return?, only?, timeout? })` | `mode: merge (default) \| set \| content \| replace \| patch` | `ThrowingResult<Row>` | `UPDATE … MERGE/SET/CONTENT/REPLACE/PATCH … WHERE …` |
| W5 | `updateMany({ where?, data, mode?, return?, timeout? })` | sem `where` = tabela inteira (rules) | `BatchResult<Row>` | `UPDATE … WHERE …` |
| W6 | `updateEach({ by, data[], mode?, onEmpty?, select?, return? })` | `by ∈ colunas`, sem duplicados | `BatchResult<Row>` | `FOR $row IN $p { UPDATE … WHERE by = $row.by };` |
| W7 | `patch({ where, patches })` | JSON Patch | `ThrowingResult<Row>` | `UPDATE … PATCH $p WHERE …` |
| W8 | `upsert({ where, data \| (create + update), mode? })` | id | `Row` | `UPSERT t:id MERGE $p` / `INSERT … ON DUPLICATE KEY UPDATE` |
| W9 | `upsertMany({ data[], update?, conflict?, return? })` | com id = 1 statement; sem id = `conflict` + LET/IF | `BatchResult<Row>` | ver §3.3 |
| W10 | `delete({ where, return?, only? })` | `return: before (default) \| none` | `ThrowingResult<Row>` | `DELETE [FROM] … RETURN BEFORE` |
| W11 | `deleteMany({ where?, all?, return? })` | sem `where` exige `all: true` (rules) | `BatchResult<never>` | `DELETE … WHERE …` |
| W12 | `relate(from, edge, to, { data?, return? })` | endpoints tipados | `Row` | `RELATE a->edge->b SET …` |
| W13 | `relateMany([...])` | | `BatchResult<Row>` | N `RELATE` em 1 query |
| W14 | `unrelate(from, edge, to)` / `unrelateMany({ where })` | | `BatchResult<never>` | `DELETE edge WHERE in = $a AND out = $b` / filtro |

**Semântica de UPDATE (crítica):** `UPDATE t:id` **cria** se não existir. O novo ORM compila updates
por **alvo + `WHERE`** (`UPDATE t MERGE $p WHERE id = t:id`) para devolver vazio quando não casa
(`null`/`.throw()`), mantendo `upsert` como o único create-or-update. 🔶 verificar forma exata (M0.1).

**RETURN por operação** (resumo):

| Operação | `before` | `after` (default) | `diff` | `none` |
| --- | --- | --- | --- | --- |
| `create`/`insert` | ✓ (vazio) | ✓ | ✓ | ✓ |
| `update`/`upsert`/`patch` | ✓ | ✓ | ✓ | ✓ |
| `delete` | ✓ default | ✗ (`ReturnNotSupported`) | ✗ | ✓ |

**Expressões em writes:** qualquer valor pode ser `surql` (`balance - ${100}`, `time::now()`,
`IF … THEN … ELSE … END`, `$input.name` no `ON DUPLICATE`).

**`create` + `relate` no payload** (açúcar): `relate: [{ from, edge, to: '$self' }]` compila
`LET $created = (CREATE ONLY …); RELATE …->$created;` — 🔶 verificar `CREATE ONLY` como expressão.

### 2.4 Relações e grafos (M3)

**Descoberta de chave relacional** (campo × aresta) definida no `SchemaIndex` (§1.1).

| ID | Recurso | Args | Lowering |
| --- | --- | --- | --- |
| G1 | `include: { author: true }` (link) | | `FETCH author` |
| G1 | `include: { author: { select: {...} } }` | projeção no link | achatado + remontagem no client 🔶 |
| G1 | `include: { author: { include: { profile: true } } }` | aninhado | `FETCH author.profile` |
| G2 | `include: { likes: true }` (aresta) | | `(SELECT … FROM ->likes->posts) AS likes` |
| G2 | `include: { likes: { edge: true } }` | dados da aresta | `->likes` |
| G2 | `include: { likes: { edge: {...}, target: {...} } }` | ambos | `(SELECT …, out.* FROM ->likes) AS likes` |
| G2 | `include: { likes: { where, select, orderBy, limit, start } }` | subquery por pai | `(SELECT … FROM ->likes->posts WHERE … LIMIT …) AS likes` |
| G2 | `include: { relations: { wildcard: true, … } }` | `->?` | `(SELECT … FROM ->?) AS relations` |
| G3 | `include: { _count: { select: { posts: true, likes: { where } } } }` | contagens | `count(->posts) AS _count_posts` · `count(->likes[WHERE …])` |
| G4 | `where: { posts: { some: {...} } }` | filtro de relação | `count(->posts[WHERE …]) > 0` |
| G4 | `where: { posts: { none: {...} } }` | | `= 0` |
| G4 | `where: { followers: { every: {...} } }` | | `count(->followers[WHERE NOT …]) = 0` |
| G4 | `where: { profile: { is: {...} } }` / `isNot` | link | `profile.<campo> = $p` / negação |
| G5 | `select`/`where` com traversal | açúcar + `surql` | `->likes->posts.title`, `count(->likes)`, `<->?` |
| G5 | recursão | `surql` + helpers | **sintaxe 3.1.4** (`rec.{1..2}(->edge->node)` vs `@.{1..2}->edge->node`) 🔶 |

### 2.5 Paginação e agregações (M1)

- **`paginate`**: envelope `{ data, pagination: { type:'offset', page, perPage, total, pageCount, hasNext, hasPrevious } }`;
  `count:false` → sem `total`, `hasNext` pela sonda `LIMIT n+1`; `perPage` = `limit`;
  `page = floor(start/limit)+1`; com `groupBy`, o count conta **grupos** (subquery).
- **`cursor`**: envelope `{ data, pagination: { type:'cursor', hasNext, hasPrevious, nextCursor, previousCursor } }`;
  default `orderBy: [{ id: 'asc' }]`; `after`/`before` exclusivos (`CursorDirectionConflict`);
  ordenação custom → cursor tupla `{ …campos, id }` e comparação `(a < x) OR (a = x AND b > y)`;
  último campo do `orderBy` deve ser único (`CursorTiebreakerRequired`).
- **`aggregate`**: `_count: true` → `count()`; `{ sum|avg|min|max|median|stddev|variance: 'campo' }` → `math::*`;
  `{ collect: 'campo' }` → `array::group`; `{ distinct: 'campo' }` → `array::distinct`; `surql` livre;
  `having` → `HavingUnsupported` (não existe no SurrealQL; usar subquery/`$query`).

### 2.6 Transações (M4)

```ts
await client.transaction(async (tx) => { … }, {
  mode: 'sdk' | 'sql', retries: { attempts, on: ['writeConflict', …], delayMs, jitter },
  timeout, context, isolation?, onUnsupported: 'warn' | 'throw' | 'ignore',
});
```

- `tx` = client completo bound (delegates, `$raw`, `fn`, plugins/hooks).
- Sucesso → commit; exceção → cancel + propagação; `tx.rollback(reason)` → `TransactionRollback`.
- `tx.afterCommit(cb)` / `tx.afterRollback(cb)`; `client.afterCommit` no escopo corrente.
- Aninhada = mesma transação (sem savepoint); abrir `client.transaction` dentro de tx → `TransactionAlreadyActive`.
- `mode:'sdk'` usa `Surreal.beginTransaction()`/`SurrealTransaction.commit|cancel`; `mode:'sql'` emite
  `BEGIN/COMMIT/CANCEL TRANSACTION`.

### 2.7 Live queries e changefeeds (M4)

| Recurso | API | Lowering/observação |
| --- | --- | --- |
| live por delegate | `client.users.live({ where, select, diff, fetch, only, meta }, cb?)` | `LIVE SELECT … WHERE … DIFF FETCH …` |
| live dinâmica | `client.live('users', args, cb)` | idem |
| iterar | `for await (const c of sub)` | `LiveSubscription implements AsyncIterable` |
| encerrar | `sub.kill()` / `client.kill(uuid)` | idempotente |
| reatar | `client.liveOf(uuid, handler)` | `UnmanagedLivePromise` (SDK) |
| notificação | `LiveNotification<Row> { action, value, recordId, diff?, uuid, result? }` | normalizar `LiveMessage` do SDK |
| cláusulas inválidas | `orderBy/limit/group` → `ClauseNotSupportedInLive`; `live` em tx → `LiveInTransaction` |
| feature/transporte | WebSocket; `live.checkFeature` (SDK `Features`) 🔶 | HTTP → `LiveQueryUnsupported` |
| reconexão | `live.reconnect` (default true) re-assina + evento `RECONNECTED` (extensão nossa) | observar eventos do `Surreal` |
| changefeed | `client.changes({ table?, since, limit })` | `SHOW CHANGES FOR TABLE/DATABASE SINCE … LIMIT …` |
| `ChangeSet` | `{ versionstamp, changes: [{ action, recordId, value?, before?, diff? }] }` | normalização |

### 2.8 Raw, funções e admin (M5)

| ID | Recurso | API | Notas |
| --- | --- | --- | --- |
| X1 | `$raw<T>` | tagged template (1 `${}` = 1 bind) ou `surql`/`BoundQuery`; `options: { timeout, meta, name }` | 1º statement, tipado pelo generic |
| X1 | `$query<T[]>` | vários statements; `{ throwOnError:false }` → `StatementResult[]` | usa `responses()` |
| X1 | `$unsafe` | string crua; exige `raw: { unsafe: true }`; senão `UnsafeDisabled` | `$unsafe(sql, params?)` |
| X1 | opções raw | `raw: { unsafe, requireComment, timeoutMs }` | hooks `beforeRaw/afterRaw/onRawError` |
| X2 | `fn.call` | `client.fn.call\<R\>('fn::x', args)` / `client.fn.x(args)` (schema) | via `db.run`/`invoke` |
| X2 | `api` | `client.api.get/post/put/patch/delete(path, { query, headers, body })` | SDK `api()`; erro com `status` + `details` |
| X2 | `auth` | `signin/signup/authenticate/invalidate/record` | SDK; `$withContext({auth})` isola sessão |
| X2 | admin | `info(level, table?)`, `version()`, `ping()`, `export()`, `import()` | passthrough SDK/`INFO` |
| X3 | `$withContext` | clone com NS/DB (`USE NS … DB …;` prefixado na operação), `auth` (via `forkSession`), `meta` | 1 round-trip |
| X3 | `extends` / delegate helpers | `$model` / `$state` / `$withState` / `$withoutPlugins` | conflito = fail-fast |
| X3 | `$sdk` | `Surreal` original | escape final |

### 2.9 Hooks e plugins (M6)

`beforeQuery`/`afterQuery` · `beforeCreate`/`afterCreate` · `beforeUpdate`/`afterUpdate` ·
`beforeDelete`/`afterDelete` · `beforeRelate`/`afterRelate` · `beforeRaw`/`afterRaw`/`onRawError` ·
`beforeTransaction`/`afterTransactionCommit`/`afterTransactionRollback`/`onTransactionError` · `onError`.
Todos recebem `meta` (merge: `$withContext` → chamada vence) e são async-friendly.

Plugins: `{ id, name?, version?, description?, config?, operationArgs?, setup?, transform?, hooks?,
extendClient?, extendModel? }` + delegates `$model/$state/$withState/$withoutPlugins`.

Escopo faseado: **F1** `plugins/rules` (`noRawUnsafe`, `destructiveWriteWithoutWhere`, `requireLimit`,
`requireOrderByForCursor`, `maxLimit`; presets `safe/recommended/strict`) e `plugins/zod` (validação de
resultado/overrides — writes já validam via codec); **F2** `plugins/timestamps`, `plugins/soft-delete`.

### 2.10 Erros — catálogo de códigos

`ResultNotFound` · `DatabaseError` · `ParseError` · `AssertionFailed` · `RecordAlreadyExists` ·
`RecordNotFound` · `WriteConflict` · `SerializationFailure` · `PermissionDenied` · `NotAuthenticated` ·
`ValidationError` · `UnsafeDisabled` · `UnsupportedCapability` · `LiveQueryUnsupported` ·
`ClauseNotSupportedInLive` · `LiveInTransaction` · `TransactionAlreadyActive` · `TransactionRollback` ·
`CursorDirectionConflict` · `CursorTiebreakerRequired` · `UniqueTargetRequired` · `ReturnNotSupported` ·
`HavingUnsupported` · `RepositoryNotFound` · `UnknownField` · `PluginError` · `UnsafeMutation` (rules) ·
`SchemaInvalid` (bootstrap).

---

## 3. Compilação (lowering)

### 3.1 `where`

- Múltiplas chaves = `AND`; valor puro = `=`; `null` → `= NULL`; `isNone` → `= NONE`
  (`NONE` e `NULL` são coisas diferentes no SurrealDB).
- Operadores no mesmo campo também são `AND`: `{ age: { gte: 18, lt: 65 } }` →
  `age >= $p0 AND age < $p1`.
- Strings: não existe `ENDSWITH` como operador — `startsWith`/`endsWith` compilam para
  `string::starts_with(campo, $p)` / `string::ends_with(campo, $p)`.
- Lógicos: `AND`/`OR`/`NOT` aninham em qualquer profundidade; parênteses explícitos;
  `NOT` nega o grupo compilado.
- Relacionais: `some` → `count(traversal[WHERE …]) > 0`; `none` → `= 0`;
  `every` → `count(traversal[WHERE NOT …]) = 0`; `is`/`isNot` resolve por path do link.
- Fast path: objeto só com igualdades escalares diretas → um único `and(eq…)` sem pipeline.
- Fragments `surql`: como valor de campo (`campo <fragmento>`) ou substituindo o `where` inteiro.

### 3.2 `select` / `omit` / `orderBy`

- Projeção por lista de campos, paths, aliases, sub-objetos, `'*'` e expressões `surql` (com bind).
- `omit` → `SELECT * OMIT a, b` (sem `select`).
- `orderBy`: `[{ campo: 'asc' | 'desc' }]`, `surql` direto, ou `{ campo: surql`expressão` }`.
- `value: true` → `SELECT VALUE <expr>`; `only: true` → `FROM ONLY` e resultado único.

### 3.3 Escritas

| Operação | Regra de compilação |
| --- | --- |
| `create` | `CREATE [ONLY] t CONTENT $p` (`t:id` como alvo quando id explícito) |
| `createMany` | N `CREATE` em 1 `conn.query`, `BEGIN/COMMIT` implícito fora de tx |
| `insert` | `INSERT [IGNORE] INTO t $p`; `onDuplicate: 'update'` → `ON DUPLICATE KEY UPDATE campo = $input.campo, …`; mapa usa `$input`/`time::now()` |
| `update` (merge/set/content/replace) | `UPDATE t MERGE|SET|CONTENT|REPLACE $p WHERE …`; `unset` combinado com `data` = 2 statements no mesmo round-trip |
| `patch` | `UPDATE t PATCH $ops WHERE …` |
| `upsert` (id) | `UPSERT t:id MERGE $p` ou `INSERT INTO t $create ON DUPLICATE KEY UPDATE …` quando `create`+`update` distintos |
| `upsert` (campo único) | `LET $e = (SELECT VALUE id FROM t WHERE uniq = $p LIMIT 1); IF array::len($e)=0 THEN CREATE … ELSE UPDATE $e[0] … END;` |
| `upsertMany` (com ids) | 1 `INSERT … ON DUPLICATE KEY UPDATE` (`update: 'all'\|mapa\|callback`) |
| `upsertMany` (sem ids) | `conflict` obrigatório; N blocos `LET`/`IF` em 1 query + tx implícita |
| `delete` | `DELETE t:id` (id) / `DELETE FROM t WHERE …`; `RETURN BEFORE`/`NONE` |
| `updateEach` | `FOR $row IN $p { UPDATE t MERGE $row.fields WHERE by = $row.by };` |
| `relate` | `RELATE a->edge->b [SET …]`; `relateMany` = N statements; `unrelate` = `DELETE edge WHERE in = $a AND out = $b` |

`$input` referencia o registro do `INSERT`; campos sem prefixo referenciam o próprio registro
(`logins + 1`); `$update` é o payload de atualização quando `create`+`update` distintos.

### 3.4 `include`

- Link simples → `FETCH campo`; aninhado → `FETCH a.b`; múltiplos → `FETCH a, b`.
- Link projetado → achatar (`author.id AS author_id`) + remontar no decoder 🔶 (mensagem exata no M0.1).
- Aresta → `(SELECT … FROM ->edge->target …) AS alias`; `edge: true` → registros da aresta;
  `edge`+`target` → `SELECT …, out.* FROM ->edge`.
- `_count` → subqueries correlacionadas no mesmo `SELECT` (`count(->posts) AS _count_posts`).

### 3.5 Paginação

- `paginate`: `SELECT … LIMIT $l START $s` + `SELECT count() … GROUP ALL` no mesmo `conn.query`;
  com `groupBy`, o count envolve o `GROUP BY` numa subquery.
- `cursor`: id → `WHERE … AND id > $c ORDER BY id ASC LIMIT $l` (`before` = `id < $c ORDER BY id DESC`
  + reordenação no client); tupla → `(a < $x) OR (a = $x AND b > $y)`; probe `LIMIT n+1` quando
  `count:false`.

### 3.6 Segurança / parametrização

- Valores **sempre** viram `$pN` (via `toFragment`/`argRenderer`); nomes validados no `SchemaIndex`
  e escapados (identificadores `⟨…⟩` quando necessário).
- Nenhuma string de valor concatenada; fragments crus passam pela mesma validação de binds.
- `strict: true` rejeita campo/tabela desconhecidos **antes** de compilar (`UnknownField`).

---

## 4. Tipagem (type-level)

### 4.1 Princípios

- **Sem schema paralelo:** os tipos saem de `App<TD>`, `Create<TD>`, `Update<TD>` (Zod + codecs).
- **Args-objeto, não DSL fluente:** o retorno é inferido do **literal de args** capturado por um
  generic `const` — o análogo do `PayloadForArgs` do better-drizzle
  (`tmp/better-drizzle/packages/core/src/types/query.ts:633`).
- **Honestidade de cardinalidade:** `findMany` → `Row[]`; `only`/`groupAll` → `Row`;
  `findFirst/findUnique/update/delete` → `ThrowingResult<Row>`.
- **Type-perf é requisito:** depth guards, `Simplify` nas fronteiras, budgets no CI
  (`scripts/type-perf.ts` + `@ark/attest`).

### 4.2 Padrões herdados (com referência)

| Padrão | Origem | Uso |
| --- | --- | --- |
| Captura do literal de args → payload | better-drizzle `types/query.ts:633-643` (`PayloadForArgs`) | `ResultOf<TD, Args>` despacha por `select`/`include`/`omit`/`value`/`only`/`return` |
| Filtro por tipo do campo | better-drizzle `types/utils.ts:422-432` (`ScalarFilter<T>`) | `FieldFilter<T>` por família (string/number/date/array/record/geo/vetor) |
| `where` recursivo + relações | better-drizzle `types/query.ts:108-124`; drizzle `relations.ts:210-277` (`DBQueryConfig`) | recursão com depth guard + `some/every/none/is/isNot` |
| Inferência de `include` | drizzle `relations.ts:320-404` (`BuildQueryResult`/`BuildRelationResult`) | link → `App<Target>`/`App<Target>[]`; `_count` → `number` |
| Projeção `select` | drizzle `query-builders/select.types.ts:39-74,162-167` (`SelectResult`/`SelectResultField`) | simplificado (sem joins): `true`, path, alias, sub-objeto, `'*'`, `surql<T>` |
| Guarda de profundidade | drizzle `select.types.ts:162-167` (`TDeep`), `utils.ts:158-164` | recursão de `Where`/`Include` limitada (degrada p/ `string`/`unknown`) |
| `Simplify` / `Assume` / `Equal` | drizzle `utils.ts:144-176` | fronteiras de resultado, commit de union, dispatch |
| `KnownKeysOnly` | drizzle `utils.ts:249-251`; `query.ts:33,49` | args e `include` sem excess-property inference |
| Mensagens de erro tipadas | drizzle `utils.ts:174-176` (`DrizzleTypeError`) | args incoerentes produzem erro legível, não `never` |
| `NoInfer` / `const` generics | better-drizzle `types/plugins.ts:963-980`, `factory.ts:1333` | args de plugin não poluem inferência; literais preservados |
| Thenable aumentado | better-drizzle `hooks.ts:314-385` (`attachThrow`/`attachExplain`) | `.throw()`/`.explain()` sem custo quando não usados |
| Registro dual de delegates | better-drizzle `factory.ts:1034-1047` | `client.<key>` e `repository(name)` aceitam chave TS e nome físico |

### 4.3 Assinaturas por área

```ts
// client
declare function betterSchemic<S extends SchemaDef, const O extends OrmOptions<S>>(
  conn: Queryable, opts: O & { schema: S },
): Client<S, O>;

// delegate (exemplo de leitura)
interface Delegate<TD extends AnyTableDef, S extends SchemaDef> {
  findMany<const A extends FindManyArgs<TD, S>>(args?: A): Promise<ResultOf<TD, A>[]>;
  findFirst<const A extends FindFirstArgs<TD, S>>(args?: A): ThrowingResult<ResultOf<TD, A>>;
  findUnique<const A extends FindUniqueArgs<TD, S>>(args: A): ThrowingResult<ResultOf<TD, A>>;
  paginate<const A extends PaginateArgs<TD, S>>(args: A): Promise<PaginationResult<ResultOf<TD, A>>>;
  cursor<const A extends CursorArgs<TD, S>>(args: A): Promise<CursorResult<ResultOf<TD, A>>>;
  // writes análogos: create<const A extends CreateArgs<TD>>(args: A): Promise<ResultOf<TD, A>>;
}

// where
type Where<TD, S, D extends number = 3> = {
  [K in keyof App<TD>]?: FieldFilter<App<TD>[K]> | RelationFilter<...>;
} & { AND?: Where[]; OR?: Where[]; NOT?: Where } & { [path: string]: FieldFilter<unknown> };

// resultado
type ResultOf<TD, A> =
  A extends { select: infer Sel } ? SelectedShape<TD, Sel>
  : A extends { omit: infer O } ? OmitShape<TD, O>
  : App<TD>;  // + WithIncludes<TD, A> + Counts<A> + value/only/groupAll
```

### 4.4 Type-perf

- Testes `test/types/orm-*.assert.ts` (attest) e `.bench.ts` (budgets) rodando via
  `bun run test:types`; re-baseline **consciente** (nunca aumentar budget sem justificar).
- Foco: `Where` recursivo, `Include`, `ResultOf`; medir com `tsc --extendedDiagnostics`.
- Preferir mapped types a condicionais distributivas; `interface` merging quando o hover degradar.

---

## 5. Estrutura de arquivos e subpaths

```
drivers/surrealdb/src/orm/…            (ver §1.8)
drivers/surrealdb/src/surql/render.ts  (movido de src/query/render.ts)
drivers/surrealdb/src/fn.ts            (permanece; rewire p/ surql/render)
drivers/surrealdb/src/frag.ts          (permanece)
```

`package.json` do driver:

```jsonc
"exports": {
  ".":            { /* authoring — inalterado */ },
  "./driver":     { /* inalterado */ },
  "./connection": { /* inalterado (opener passa a apontar p/ /orm) */ },
  "./query":      { /* fragments: surql/fn/block — sem select/write/graph/schemaless */ },
  "./orm":        { "bun": "./src/orm/index.ts", "import": { "types": "./lib/orm.d.ts", "default": "./lib/orm.js" } },
  "./package.json": "./package.json"
}
```

`/client` **removido** no M0.5. Plugins oficiais: `"./plugins/rules"`, `"./plugins/zod"` (F1);
`"./plugins/timestamps"`, `"./plugins/soft-delete"` (F2).

---

## 6. Remoção do legado

> Executada em bloco no **M0.5** (substituição imediata, decidida). O gate do land só roda com a
> árvore consistente — nada de big bang no `main`: o land do M0.5 já leva a API nova esquelética.

**Deletar:**

- `drivers/surrealdb/src/query/index.ts` (builder SELECT fluente)
- `drivers/surrealdb/src/query/write.ts` (create/update/remove/relate fluentes)
- `drivers/surrealdb/src/query/graph.ts` (traversal fluente)
- `drivers/surrealdb/src/query/schemaless.ts` (adapter schemaless do builder)
- `drivers/surrealdb/src/query/expr.ts` (FieldRef ops — substituído pelo compiler `where`)
- `drivers/surrealdb/src/client.ts` (Client/Session antigos; `connect`/`connectFromConfig` migram p/ `src/orm`)
- `packages/core/src/query/*` (`ref.ts`, `project.ts`, `codec.ts`, `call.ts`, `index.ts`, `query.ts`)
- `packages/core/test/unit/query.test.ts`, `query-call.test.ts`
- export `"./query"` do `packages/core/package.json` + `Query` types do `packages/core/src/index.ts`

**Mover:**

- `src/query/render.ts` → `src/surql/render.ts`; rewiring de `src/index.ts` (`hasRefDeep`, `renderData`),
  `src/fn.ts` (`argRenderer`, `Ctx`, `RefKind`), `src/pure.ts` (usos de `FieldRefBase`/`brandRef`).

**Triagem dos testes do driver (14 arquivos):**

| Teste | Destino |
| --- | --- |
| `query-builder`, `query-phase1`, `query-writes`, `query-schemaless`, `graph-traversal`, `ref-methods`, `ref-operands`, `array-closures`, `record-for-refs`, `parent-subquery` | **deletar** (builder fluente) |
| `block`, `call-ref-args`, `range`, `singleton` | **manter** (fragments/authoring), rewirando imports |
| `test/types/query-types.{assert,bench}.ts` | **reescrever** como `orm-*.{assert,bench}.ts` |

**Atualizar:** `ROADMAP.md` (substituir o arco query-layer), driver `README.md`, `AGENTS.md` (surface
`/orm`), `packages/core/docs/query-builder-design.md` (marcar superseded), `MULTI-CONNECTION.md`
(`ctx.connections` sem `.select`), `CHANGELOG.md` (breaking + added).

---

## 7. Milestones

> Convenção: cada milestone lista **objetivo · entregáveis · aceite · deps**. Um land por milestone
> (branch `feat/typed-querys` → `bun scripts/land.ts`).

### M0 — Fundação + substituição do legado

#### M0.1 — Mapa de sintaxe verificado ao vivo
- **Objetivo:** provar cada construto SurrealQL que o ORM vai emitir contra o servidor real (3.x),
  como o `docs/graph-syntax-map.md` já faz para grafos.
- **Entregáveis:** `drivers/surrealdb/docs/orm-syntax-map.md` + `test/live/orm-syntax.test.ts`
  (probes ao vivo, skip sem binário).
- **Cobre:** `INSERT`/`IGNORE`/`ON DUPLICATE KEY UPDATE`; `UPDATE` `SET/MERGE/CONTENT/REPLACE/PATCH/UNSET`
  + `ONLY`; `RETURN BEFORE/AFTER/DIFF/NONE`; update por `WHERE id =` (não cria) × `UPDATE t:id` (cria);
  `CREATE ONLY` em expressão (`LET $x = (CREATE ONLY …)`); `FETCH` simples/aninhado/projetado; `OMIT`;
  `SPLIT`; `GROUP BY/ALL` + `math::*`/`array::group`; `WITH [NO]INDEX`; `TIMEOUT/PARALLEL/VERSION`;
  `EXPLAIN`; ranges `t:a..=b`; `LIVE SELECT … DIFF FETCH`; `SHOW CHANGES`; subquery correlacionada
  (`$parent`); operadores `~`/`?~`/`*~`/`?=`/`*=`/`INSIDE`/`INTERSECTS`/`@@`/`@n@`/`<|k|>`; paths
  `[*]`/`[0]`; recursão 3.x; `SELECT VALUE`; `count()`/`exists` probe.
- **Aceite:** cada linha do mapa com resultado real anexado; divergências do protótipo registradas.

#### M0.2 — `defineSchema` + `SchemaIndex`
- **Entregáveis:** `src/orm/schema.ts`, `src/orm/types/schema.ts`, `test/unit/orm-schema.test.ts`.
- **API:** `defineSchema({ users: User, likes: Likes, sendMail, audit: 'audit_log' })`.
- **Aceite:** índice correto para `s.recordId(User)` (single/array/optional/union), `RelationDef`
  (adjacência from/to), singleton, `FunctionDef`; bootstrap falha com `SchemaInvalid` em duplicata/
  colisão/aresta órfã; tipos `SchemaOf`/`TableKeys`/`Client<S>` compilam.

#### M0.3 — Result wrappers + erros
- **Entregáveis:** `src/orm/results.ts`, `src/orm/errors.ts`, testes unit.
- **Aceite:** `ThrowingResult` (await e `.throw()` com factory), `BatchResult`, `StatementResult`,
  normalização de `ServerError`/`QueryResponseFailure` → códigos, predicados.

#### M0.4 — Executor
- **Entregáveis:** `src/orm/execute.ts`, testes unit com fake connection.
- **Aceite:** N statements em **1** chamada; ordem preservada; status por statement via `responses()`;
  erro com `statementIndex`/`surql`/`vars`; `BEGIN/COMMIT` implícito quando fora de tx; binds únicos.

#### M0.5 — Bootstrap, delegates e **remoção do legado**
- **Entregáveis:** `src/orm/index.ts`, `src/orm/client.ts`, `src/orm/delegate.ts`; export `./orm`;
  **§6 executado**; testes unit (client shape) e types (keys → delegates).
- **API:** `betterSchemic`, `createBetterSchemic`, `client.<key>`, `repository()`, `tables`, `$sdk`,
  `close`, `[asyncDispose]`, `forkSession`.
- **Aceite:** delegate existe para cada chave; `.repository` por chave/nome físico; schemaless entry;
  colisão de `extends` falha; BYO close = no-op; managed close fecha; workspace typecheck+test verde.

### M1 — Leitura

| Sub | Escopo | Aceite |
| --- | --- | --- |
| M1.1 | `compiler/shared.ts` + `compiler/where.ts` + `types/where.ts` | golden args→`{surql,vars}`; injeção impossível; budget de tipos |
| M1.2 | `findMany` + `select` (todas as formas) + `omit`/`orderBy`/`limit`/`start`/`only`/`value`/`range`/`split`/`groupBy`/`groupAll`/`with`/`timeout`/`parallel`/`version`/`meta` | golden por forma; decode linha/projeção; live tests |
| M1.3 | `findFirst`/`findOne`/`findUnique` + `.throw()` | `ONLY`/`LIMIT 1`; `UniqueTargetRequired`; `NotFoundInfo` |
| M1.4 | `count`/`exists` | `GROUP ALL`; `VALUE id LIMIT 1`; `ignoredOptions` no explain |
| M1.5 | `aggregate` | operadores do §2.5 + `surql` livre + `_count`; `HavingUnsupported`; tipos |
| M1.6 | `paginate` + `cursor` | 2 statements/1 query; `count:false`; cursor id/tupla; exclusividade; tiebreaker |
| M1.7 | `.explain()` + `explain: true` | keys `data/total/count/exists/probe:*`; não executa; não dispara hooks |
| M1.8 | Tipos de leitura | `test/types/orm-reads.assert.ts` + budgets |

### M2 — Escritas

- **M2.1 `create`/`createMany`** — `Create<T>` codec fail-fast; `only`; `return`; `skipDuplicates`;
  `relate` no payload; tx implícita; `RecordAlreadyExists` normalizado.
- **M2.2 `insert`/`insertMany`** — `onDuplicate: 'ignore'|'update'|mapa`; `$input`; `RETURN`.
- **M2.3 `update`/`updateMany`** — modes `merge/set/content/replace/patch`; `unset` (+ 2 statements
  quando combinado com data); expressões `surql`; `only/timeout`; semântica "update não cria".
- **M2.4 `patch` + `RETURN DIFF`** — JSON Patch; auditoria.
- **M2.5 `upsert`/`upsertMany`** — por id (`UPSERT`/`ON DUPLICATE`) e por campo único (`LET`+`IF/ELSE`);
  `update: 'all'|mapa|callback`; sem id exige `conflict`.
- **M2.6 `delete`/`deleteMany`** — `RETURN BEFORE/NONE`; `ReturnNotSupported` para `after/diff`;
  `all: true` para tabela inteira; cascatas server-side (`REFERENCE ON DELETE`) documentadas.
- **M2.7 `updateEach`** — `by` (default `id`), duplicados rejeitados, `mode`, `onEmpty:'return'|'throw'`,
  ordem do `data`, `skipped`, `statements`.
- **M2.8 `relate`/`relateMany`/`unrelate`/`unrelateMany`** — endpoints tipados (id/row/array/subquery/
  `$param`), edge id nomeado, `data` na aresta; delegates de aresta normais.
- **Aceite de cada:** golden SQL + live test + decode + erro normalizado.

### M3 — Relações e grafos

- **M3.1 `include` link → `FETCH`** — simples, aninhado, projetado (remontagem), múltiplos links.
- **M3.2 `include` grafo** — traversal, `edge`/`target`, filtros por pai, wildcard, polimórfico.
- **M3.3 `_count`** — subqueries correlacionadas; links array (`count(campo)`) e arestas.
- **M3.4 `where` relacional** — `is`/`isNot`/`some`/`every`/`none` (comportamento NONE em negação
  verificado ao vivo).
- **M3.5 Traversal/recursão** — açúcares + `surql`; documentar a sintaxe 3.x; helpers mínimos só se o
  M0.1 confirmar.
- **Aceite:** cada forma com live test no grafo de exemplo + tipos de `include`/`_count` + budgets.

### M4 — Transações, live e changefeeds

- **M4.1 `client.transaction`** — `sdk`/`sql`, commit/cancel, `rollback`, aninhada mesma tx,
  `afterCommit`/`afterRollback`, retries (`writeConflict`/`serializationFailure`/`connectionError`),
  `timeout`/`context`, `onUnsupported`; `TransactionAlreadyActive`.
- **M4.2 `live`** — delegate + dinâmica, `where/select/diff/fetch/only`; `LiveSubscription`
  (asyncIterator, `kill`), `liveOf`, normalização `LiveNotification`, feature check, reconexão +
  `RECONNECTED`; erros `LiveQueryUnsupported`/`ClauseNotSupportedInLive`/`LiveInTransaction`.
- **M4.3 `changes`** — `SHOW CHANGES` table/database, `since` (versionstamp/Date/ISO), normalização
  `ChangeSet`, paginação por versionstamp.
- **Aceite:** live e2e (WebSocket/ephemeral), rollback em erro, retry forçado, tipos dos envelopes.

### M5 — Escape hatches, admin e contexto

- **M5.1 `$raw`/`$query`/`$unsafe`** — tagged template parametrizado, `BoundQuery`, opções raw,
  `throwOnError:false`, hooks raw; `UnsafeDisabled`.
- **M5.2 `fn`/`api`/`auth`/admin** — `fn.call` + atalho tipado por `defineSchema`; `api.*` (status +
  `details`); `auth.*`; `info/version/ping/export/import`.
- **M5.3 `$withContext`/`extends`/estado** — clone com NS/DB (`USE NS … DB …;` prefixado na operação),
  `auth` (via `forkSession`), `meta`; helpers reaplicados; `$model/$state/$withState/$withoutPlugins`.
- **Aceite:** multi-tenant e2e (NS/DB por contexto sem vazar estado global), raw parametrizado,
  helpers em tx/clone.

### M6 — Plugins e hooks

- **M6.1 Hooks** — tipos + dispatch em todos os pipelines (fast path preservado).
- **M6.2 `definePlugin`** — pipeline, `operationArgs` tipados, `extendClient`/`extendModel`, `setup`,
  estado por delegate, `transform` mutando `where/data/kind`, `setup` fail-fast.
- **M6.3 F1** — `plugins/rules` (presets + guardrails; `UnsafeMutation`/`UnknownField`) e
  `plugins/zod` (validação de resultado/overrides).
- **M6.4 F2 (opcional)** — `plugins/timestamps`, `plugins/soft-delete` (+ `restore`).
- **Aceite:** soft-delete/rules e2e; plugin com `operationArgs` estendendo a tipagem do delegate.

### M7 — Hardening, docs e release

- **M7.1** `drivers/surrealdb/docs/ORM-COVERAGE.md` **exaustivo** (autor→emit→introspect→diff→execute).
- **M7.2** Docs: driver `README.md`, `ROADMAP.md` (novo arco), `AGENTS.md`, `query-builder-design.md`
  (superseded), `EXAMPLES`/cookbook (`examples/orm/*` + manifest), `MULTI-CONNECTION.md`.
- **M7.3** Verificação final: `bun scripts/land.ts` (gate verde), type-perf baseline, e2e/live,
  CHANGELOG (breaking + added) numa entrada de release.
- **Aceite:** nenhuma referência à API antiga; ORM coverage sem lacunas não-documentadas.

---

## 8. Testes e verificação

| Camada | O que | Como |
| --- | --- | --- |
| Golden (unit) | args → `{ surql, vars }` exato, por forma | `test/unit/orm-*.test.ts` |
| Unit de decode | fake rows → `App<T>`/projeção/include | idem, sem servidor |
| Live | cada construto SurrealQL (M0.1) + operações ponta a ponta | `test/live/orm-*.test.ts` (skip sem `surreal`) |
| E2e | fluxos (tenant, transação, live, seed) | `test/e2e/` com harness existente |
| Tipos | completude (attest) + budgets de instanciação | `test/types/orm-*.assert.ts` / `.bench.ts` |
| Exemplos | cookbook (`examples/orm/*`) | `_kit.ts` + `bun run gen:examples` |
| Coverage | matriz exaustiva da superfície ORM | `drivers/surrealdb/docs/ORM-COVERAGE.md` |

Padrões do repo: live tests com timeout alto (carga paralela), `setDefaultTimeout` no harness e2e,
`surrealBinaryAvailable()` para skip, nomes de teste que o reconcile de coverage espera.

---

## 9. Riscos e questões abertas

| # | Risco/questão | Mitigação |
| --- | --- | --- |
| 1 | Divergência protótipo × SurrealDB real (recursão 3.x, `~`, `[*]`, FETCH projetado, `EXPLAIN`, `VERSION`, `UPDATE t:id` cria) | M0.1 verifica **antes** de implementar; mapa versionado |
| 2 | Type-perf de `Where`/`Include` recursivos | recursão limitada + budgets (attest) desde M1; re-baseline consciente |
| 3 | `include` com projeção/remontagem complexa | faseado (FETCH simples → projetado → grafo) e verificado por caso |
| 4 | `$withContext` NS/DB sem estado global | `USE NS…DB…` prefixado por operação (1 round-trip); `auth` via `forkSession`; teste multi-tenant |
| 5 | Retry de transação re-executa callback | documentar callback puro + `afterCommit` para efeitos |
| 6 | `ON DUPLICATE`/`PATCH`/`REPLACE`/`UPSERT` por campo único | M0.1 + live tests antes de expor |
| 7 | Volume de plugins oficiais | F1 `rules`/`zod` primeiro; resto incremental, subpaths (não packages) |
| 8 | Colisão de nomes de relação (campo × aresta) | precedência documentada (campo vence) + erro de bootstrap |
| 9 | Nome `betterSchemic` colide com o export do `better-schemic.config.ts` no mesmo arquivo | documentar alias (`import { betterSchemic as db }`) e manter o import do config com outro nome |
| 10 | Rompimento imediato da API atual (decisão "substituir já") | land único do M0.5 com a API nova esquelética; CHANGELOG marca o breaking; alpha permite |

---

## Apêndice A — Rastreabilidade protótipo → milestones

| Doc do protótipo | Conteúdo | Cobertura |
| --- | --- | --- |
| `README` / `01-filosofia` | princípios, formas de retorno, pipeline | §0, §1 (M0) |
| `02-client-e-conexao` | bootstrap, opções, client, auth, `$withContext`, info, fn, api | M0.5, M5.2, M5.3 |
| `03-leitura-select` | `find*`, `count`, `exists`, `aggregate`, projeções, cláusulas, `.throw`, `.explain` | M1 |
| `04-filtros-where` | vocabulário completo de operadores | M1.1 (+ M0.1) |
| `05-criacao` | `create`/`insert`/`ON DUPLICATE`/RETURN | M2.1, M2.2 |
| `06-atualizacao-e-upsert` | `update` modes, `unset`, `patch`, upsert por id/campo | M2.3–M2.5 |
| `07-remocao-e-batches` | `delete`/`deleteMany`, `updateEach`, atomicidade, `skipDuplicates` | M2.6, M2.7 |
| `08-relacoes-e-grafos` | FETCH, traversal, `_count`, filtros relacionais, recursão, `relate` | M3, M2.8 |
| `09-paginacao-e-agregacoes` | `paginate`, `cursor`, agregadores, `SPLIT` | M1.5, M1.6 |
| `10-transacoes` | `transaction`, rollback, retries, afterCommit | M4.1 |
| `11-live-e-changefeeds` | `live`, notificações, `changes` | M4.2, M4.3 |
| `12-raw-funcoes-e-apis` | `$raw`/`$query`/`$unsafe`, `fn.call`, `api`, `$sdk` | M5.1, M5.2 |
| `13-plugins-hooks-e-erros` | hooks, plugins, erros | M6, M0.3 |
| `14-referencia-e-cookbook` | cheat-sheets + receitas | §2, M7.3 |
| `analise-better-drizzle/*` | estilo (delegate, args-objeto, retornos, segurança) | §0, §2, §4 |

## Apêndice B — Onde cada padrão foi colhido (drizzle/better-drizzle)

| Arquivo de referência | Padrão | Uso no plano |
| --- | --- | --- |
| `tmp/better-drizzle/packages/core/src/types/query.ts:633-643` | `PayloadForArgs` | `ResultOf<TD, Args>` (§4.2) |
| `…/types/utils.ts:422-432` | `ScalarFilter<T>` | `FieldFilter<T>` por família |
| `…/types/query.ts:108-124` | `WhereInput` com `AND/OR/NOT` + relações | `Where<TD>` |
| `…/shared/query/compiler.ts:71-162,444-556` | fast path + compilador de filtros | `compiler/where.ts` |
| `…/shared/client/factory.ts:1034-1047,1330-1345` | registro dual + bound client | `client.ts` (`Object.create(null)`) |
| `…/shared/client/hooks.ts:314-385` | `attachThrow`/`attachExplain` | `results.ts` |
| `…/shared/client/relations.ts` | batch loader/hydration (conceito) | remontagem de `include` (M3) |
| `…/types/plugins.ts:963-980,1228-1253` | `definePlugin` + `operationArgs` + `NoInfer` | `plugins.ts` (M6) |
| `tmp/drizzle-orm/drizzle-orm/src/query-builders/select.types.ts:39-74,162-167` | `SelectResult`/`SelectResultField`/`TDeep` | `SelectedShape` + depth guard |
| `…/src/relations.ts:210-277,320-404` | `DBQueryConfig`/`BuildQueryResult` | `include` typing |
| `…/src/utils.ts:144-176,249-251` | `Simplify`/`Assume`/`Equal`/`KnownKeysOnly`/`DrizzleTypeError` | guardrails de tipo (§4.4) |
| `…/src/column.ts:115-121,138-144` | `mapFromDriverValue`/`GetColumnData` | decode por campo (já temos via Zod/codecs) |
| `…/src/relations.ts:666-724` | `mapRelationalRow` (path-based rebuild) | remontagem de projeção/include |

---

**Próximo passo:** iniciar pelo **M0.1** — escrever `drivers/surrealdb/docs/orm-syntax-map.md` +
`test/live/orm-syntax.test.ts` e verificar cada construto contra o servidor real antes de codar.
