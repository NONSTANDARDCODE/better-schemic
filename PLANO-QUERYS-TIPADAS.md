# Plano — ORM & Queries Tipadas (better-schemic)

> **Fonte de design:** `prototipo-querys-tipadas/better-surreal/*` (API alvo, 14 docs), apoiado em
> `prototipo-querys-tipadas/analise-better-drizzle/*` (estilo de API de repositório) e nos tutoriais
> oficiais em `prototipo-querys-tipadas/surrealdb/*`.
>
> **O que este documento é:** o plano de execução completo para **substituir o ORM fluente atual**
> (`select(User).where(...)`, `db.create(T).content(...)`) por uma **camada de repositórios tipada**
> — `client.users.findMany({ where, select, ... })` — construída **do zero** sobre o que já existe
> (authoring `s.*`, codecs, DDL/migrations, conexão gerenciada). O design de **schema** não muda:
> `defineTable`/`defineRelation`/`defineFunction` continuam a fonte de verdade; o ORM só consome.
>
> **Como usar:** aprovado este plano, a implementação segue **ponto a ponto** na ordem do §4
> (M0 → M7). Cada milestone é um entregável fechável (ideal: um land), com aceite explícito.
> Onde o protótipo e o SurrealDB **3.1.4** divergirem, vale o que for verificado ao vivo (M0.1) —
> o protótipo é intenção de design, não verdade de sintaxe.

---

## 0. Decisões de arquitetura

### 0.1 O que muda (visão de 10 000 m)

| Hoje (a substituir) | Depois (novo ORM) |
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
| `@better-schemic/core/query` (Row/Project/decodeProjection) | **removido** no cutover (M7); o compilador novo é driver-owned |

### 0.2 Nomes e superfícies (decisões — confirmar antes do M0.5)

| Item | Decisão recomendada | Alternativas | Racional |
| --- | --- | --- | --- |
| Factory | **`betterSurreal(db, { schema })`** | `betterSchemic(...)` · `orm(...)` | `betterSchemic` já é o export do `better-schemic.config.ts` — colisão em arquivos de bootstrap (DX ruim, AGENTS §DX). `betterSurreal` é fiel ao protótipo e o pacote é SurrealDB-only. |
| Subpath | **`@better-schemic/surrealdb/orm`** | reusar `/client` · `/query` | `/orm` = camada de repositórios; `/query` fica para fragments (`surql`/`fn`/`block`); `/client` sai no cutover. |
| Conveniência gerenciada | **`createBetterSurreal({ url, namespace, database, auth, schema })`** | só `betterSurreal` + `connect()` | Espelha o protótipo (§02) e reaproveita o resolver de config (`connect()` de `defineConfig`). |
| Artefato de schema | **`defineSchema({ users: User, likes: Likes, sendMail })`** | objeto literal direto | Branding runtime (chaves, duplicatas, colisões) + filtragem por tipo (TableDef/RelationDef/FunctionDef/`string`); o literal continua aceito. |
| Erros | **`BetterSchemicError` + `BetterSchemicErrorCode`** | `BetterSurrealError` | Produto = better-schemic; prefixo consistente com os packages. |
| Plugins oficiais | **subpaths** `@better-schemic/surrealdb/plugins/<nome>` | packages separados | Evita inchar a lista de 5 packages em lockstep; promove a package depois, se crescer. |
| Wrapper de resultado | `ThrowingResult<T>` / `BatchResult<T>` / `StatementResult<T>` | — | Igual ao protótipo. |

### 0.3 Reuso vs. reescrita (inventário explícito)

**Reusar (não reimplementar):**

| Ativo | Onde | Uso no novo ORM |
| --- | --- | --- |
| `s.*` + `defineTable`/`defineRelation`/`defineSingleton`/`defineFunction` | `drivers/surrealdb/src/pure.ts` | Fonte de tipos/DDL/codecs; nada muda. |
| `App/Create/Update/Wire`, `TableDef.decode/encode/encodePartial/object.shape/singletonId` | `pure.ts` | Decode de linhas, validação fail-fast de writes, metadados. |
| `RecordIdField.tables`, `RelationDef.endpointDefs(dir)` | `pure.ts` | Metadados de link/aresta do `SchemaIndex` (§1.1). |
| `surql` / `BoundQuery` / `toFragment` / `mergeRaw` / `operandText` / `stripOuterParens` / `argRenderer` | `pure.ts`, `src/query/render.ts` | Compilação parametrizada e fragments dentro de `where`/`select`/`data`. |
| `fn.ts` (catálogo `surql.fn.*`) + `block.ts` | `src/fn.ts`, `src/query/block.ts` | Escape hatches tipados e bodies de função/evento; ficam no `/query`. |
| `FunctionDef`/`CallQuery` + driver `invoke` | `pure.ts`, `driver/surreal.ts` | `client.fn.call` e atalho tipado. |
| `connectFromConfig`/resolver de config/`OrmClientBase`/`asyncDisposable` | `src/client.ts`, `packages/core/src/client.ts` | Conexão gerenciada e ciclo de vida (`await using`). |
| Harness e2e/live + `@ark/attest` + budgets | `test/e2e/harness.ts`, `test/types/` | Verificação ao vivo e de tipos. |

**Reescrever do zero (o ORM em si):** compilador (`where`/`select`/escritas/`include`/paginação/
live), executor multi-statement, wrappers de resultado, delegates, plugins/hooks, erros, `$raw`/
`$query`/`$unsafe`, `$withContext`, `client.transaction`.

**Remover no cutover (M7):** `src/query/index.ts`, `src/query/write.ts`, `src/query/graph.ts`,
`src/query/schemaless.ts`, os métodos de query do `src/client.ts` atual, `packages/core/src/query/*`
(`Row`/`Project`/`decodeProjection`/`callFunction`) e os exports correspondentes.

### 0.4 Não-objetivos (disciplina de escopo)

- **Sem schema paralelo / codegen** — os tipos saem do `defineSchema` existente (como no better-drizzle).
- **Sem pool/reconnect próprio** — o ciclo de vida é do SDK; expomos `close()` e `$sdk`.
- **Sem dialetos** — SurrealDB-only (o fork já é). O `SchemaIndex` é driver-owned.
- **Sem `DEFINE`/migrações na API do ORM** — schema continua no engine (`sc gen/migrate/diff`) ou `$raw`.
- **Sem `lock` (`FOR UPDATE`)** — SurrealDB não tem; concorrência = transação otimista + `retries`.
- **Sem `include` com joins manuais** — links/grafos são nativos (`FETCH`/traversal/subqueries).

---

## 1. Arquitetura interna

```
defineSchema({ users, posts, likes, fn… })                (artefato tipado do app)
        │
        ▼
betterSurreal(db | connection, { schema, plugins, hooks, raw, transaction, live, strict })
        │
        ├─ SchemaIndex      metadados por tabela (colunas, links, arestas, singleton, fns)
        ├─ PluginPipeline   transform(args) → args + operationArgs tipados
        ├─ Compiler         args → BoundQuery { surql, vars }  (SEMPRE parametrizado)
        ├─ Executor         1 db.query com N statements; status por statement; tx implícita em lotes
        ├─ Decoder          codecs (App<T>) + remontagem de projeções/include/_count
        └─ Results          Row[] · ThrowingResult<T> · BatchResult<T> · PaginationResult<T>
```

### 1.1 `SchemaIndex` (contexto runtime)

Extraído **uma vez** do `defineSchema` no bootstrap; validado fail-fast.

Por **tabela/aresta**:
- `key` (chave TS) · `name` (nome físico) · `singletonId?` · `codec` (`decode`/`encode`/`encodePartial`);
- `columns`: nome → `{ family: "string"|"number"|"bool"|"date"|"duration"|"array"|"set"|"object"|"record"|"geometry"|"bytes"|"other"|"any"; optional; arrayElem?; targetTables? }` — derivado do shape Zod (o mesmo walker de `ddl.ts`/`expr.ts`, consolidado);
- `links`: campo → tabelas alvo (`RecordIdField.tables`), desembrulhando `optional`/`nullable`/`array`/`union`;
- `edges`: adjacência de `RelationDef` do schema — `outgoing` (arestas cujo `from` inclui a tabela) e `incoming` (cujo `to` inclui), com `endpointDefs`;
- `functions`: `FunctionDef`s do schema (nome, args Shape, retorno).

Validação de bootstrap: nomes físicos duplicados; chave de relação ambígua (campo × aresta — **campo
vence**, e o conflito é erro de bootstrap); aresta apontando para tabela ausente do schema; `.get(Preset)` sem preset.

### 1.2 Compilador (args → `BoundQuery`)

- Tudo **parametrizado**: valores → `$p0`, `$p1`, …; nomes (tabela/campo/ordem) validados contra o
  índice e interpolados como identificadores escapados (`escapeIdent` / `⟨…⟩`).
- Fast path: `where` só com colunas escalares diretas → um único `AND` sem montar pipeline.
- Fragments `surql` aceitos em `where`, `select`, `orderBy`, `data`, `groupBy`, `split` (interpolação
  com binds mesclados — reaproveita `mergeRaw`/`toFragment`).
- Subqueries correlacionadas: refs do registro externo → `$parent.<col>` (já suportado hoje).
- Saída sempre `BoundQuery` (`{ sql, vars }`), pronta para o executor e para composição.

### 1.3 Executor

- **1 round-trip** por operação: `db.query(...)` com N statements (lotes, `paginate`, `updateEach`, `createMany`).
- **Status por statement**: usar `Query.responses()` do SDK v2 (`QueryResponse` = `success`/`error` +
  `stats`) para `StatementResult`/`throwOnError:false`; sem isso, qualquer `success:false` vira
  `BetterSchemicError` com `statementIndex` + `surql` + `vars` (censurados salvo `debug:true`).
- **Atomicidade**: lotes fora de transação ganham `BEGIN/COMMIT` implícito (ou transação SDK);
  dentro de `client.transaction` usam a transação corrente (sem aninhar).
- Ordem dos resultados preservada; `RETURN NONE` evita payload.

### 1.4 Decoder

- Linha cheia → `TableDef.decode` (codec: `Date`, `RecordId`, `Duration`, `Decimal`, bytes…).
- Projeção → decode **por entrada** (coluna pelo codec do campo; expressão/fragment = passthrough ou
  decode do alvo do builder); `include`/`_count` remontados no cliente quando o SQL devolver colunas
  achatadas (`author_id` → `author: { id }`), conforme verificação do M3.
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
`isTransactionRollback`, `isNotFound`). Códigos completos no §2.10.

### 1.8 Mapa de arquivos (novo)

```
drivers/surrealdb/src/orm/
  index.ts          betterSurreal · createBetterSurreal · defineSchema · definePlugin · erros · tipos
  schema.ts         defineSchema + SchemaIndex + validação de bootstrap
  client.ts         bound client (delegates, repository, tables, close, $withContext, extends)
  delegate.ts       createDelegate (tabela/aresta) + $model/$state/$withState/$withoutPlugins
  compiler/
    shared.ts       binds, identificadores, parens, fragments (sobre query/render)
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
  types/
    schema.ts       SchemaDef/SchemaOf/keys
    where.ts        Where<T> + operadores
    select.ts       Select/Include/OrderBy/Omit + ResultOf
    results.ts      wrappers públicos
    plugin.ts       Plugin/Operation/OperationArgs/Hook payloads
```

Subpath novo no `package.json` do driver: `"./orm"`. `/query` permanece (fragments). `/client`
sai no M7 (ou vira alias deprecado por uma release).

---

## 2. Superfície pública — referência completa (alvo a implementar)

> Esta seção é a **checklist de cada ponto** da API. Legenda de status: ⏳ implementar ·
> 🔶 decide/verifica no milestone indicado.

### 2.1 Client e bootstrap

```ts
const db = betterSurreal(surreal, { schema, plugins?, hooks?, raw?, transaction?, live?, strict?, debug? });
const db2 = await createBetterSurreal({ url, namespace, database, auth, schema, connectTimeoutMs, ...opts });
```

| Membro | Descrição | Milestone |
| --- | --- | --- |
| `client.<key>` | delegate da tabela/aresta (chave do schema) | M0.5 |
| `client.repository(name)` | delegate dinâmico (chave TS ou nome físico); `RepositoryNotFound` | M0.5 |
| `client.tables` | nomes conhecidos | M0.5 |
| `client.extends(fn \| obj)` | helpers do projeto (reaplicado em clones/tx); conflito = fail-fast | M5.3 |
| `client.transaction(fn, opts?)` | ver §2.7 | M4.1 |
| `client.live(table, args, cb)` | live dinâmica | M4.2 |
| `client.changes(args)` | `SHOW CHANGES` | M4.3 |
| `client.fn.call(nameOrDef, args?)` + `client.fn.<key>(args)` | funções definidas | M5.2 |
| `client.api.get/post/put/patch/delete` | `DEFINE API` | M5.2 |
| `client.auth.signin/signup/authenticate/invalidate/record` | auth (incl. record access) | M5.2 |
| `client.$withContext({ namespace?, database?, auth?, meta? })` | clone com NS/DB/sessão/contexto; override por chamada | M5.3 |
| `client.$raw` / `$query` / `$unsafe` | §2.8 | M5.1 |
| `client.info(level, table?)` | `INFO FOR ROOT/NS/DB/TABLE` | M5.2 |
| `client.version()` / `client.ping()` | saúde | M5.2 |
| `client.export()` / `client.import(dump)` | dump/restore | M5.2 |
| `client.afterCommit(cb)` / `afterRollback(cb)` | escopo de transação corrente | M4.1 |
| `client.close()` · `[Symbol.asyncDispose]` | ciclo de vida (BYO = no-op no close) | M0.5 |
| `client.forkSession()` | sessão própria (auth) → novo client bound | M5.3 |
| `client.$sdk` | o `Surreal` original | M0.5 |

### 2.2 Delegate — leitura

| Método | Args principais | Retorno | Lowering |
| --- | --- | --- | --- |
| `findMany(args?)` | `where, select, include, omit, orderBy, limit/take, start/skip, range, split, groupBy, groupAll, only, value, with, timeout, parallel, version, explain, meta` | `Row[]` | `SELECT …` |
| `findFirst(args?)` / `findOne(args?)` | idem | `ThrowingResult<Row>` | `SELECT … LIMIT 1` |
| `findUnique(args)` | `where` (id ou campo único) | `ThrowingResult<Row>` | `SELECT * FROM ONLY t:id` ou `WHERE uniq = $p LIMIT 1` |
| `count(args?)` | `where, range, timeout, parallel, version, meta` | `number` | `SELECT count() … GROUP ALL` |
| `exists(args?)` | idem | `boolean` | `SELECT VALUE id … LIMIT 1` |
| `aggregate(args)` | `where, groupBy, groupAll, split, select (agregadores), orderBy, limit/start, timeout, parallel, version, meta` | `Row[]` | `SELECT count()/math::sum/… GROUP BY/ALL` |
| `paginate(args)` | leitura + `limit, start, count?` | `PaginationResult<Row>` | 2 statements no mesmo `db.query` |
| `cursor(args)` | leitura + `limit, orderBy, after?, before?` | `CursorResult<Row>` | `WHERE id > $c` (ou tupla) + probes |

`select` (§2.2.1), `orderBy` (§2.2.2), cláusulas (§2.2.3), `.throw()`/`.explain()` (§2.2.4).

#### 2.2.1 Formas de `select`

| Forma | Exemplo | SurrealQL |
| --- | --- | --- |
| campos | `{ id: true, title: true }` / `['id','title']` | `SELECT id, title` |
| caminho | `{ 'address.city': true }` | `SELECT address.city` |
| alias | `{ authorName: 'author.name' }` | `SELECT author.name AS authorName` |
| sub-objeto | `{ address: { city: true } }` | `SELECT address.city AS address.city` 🔶 (mensagem exata no M0.1) |
| tudo + extras | `{ '*': true, score: surql\`…\` }` | `SELECT *, <expr> AS score` |
| expressão tipada | `{ idade: surql\`age + ${1}\` }` | `SELECT age + $p0 AS idade` |
| `value: true` | `select: { name: true }, value: true` | `SELECT VALUE name` |
| `omit` | `omit: ['password']` | `SELECT * OMIT password` |
| `only: true` | `only: true` (findMany) | `FROM ONLY` (objeto, não array) |

#### 2.2.2 `orderBy`

`[{ createdAt: 'desc' }, { name: 'asc' }]` → `ORDER BY createdAt DESC, name ASC`;
`[surql\`rand()\`]`; `[{ score: surql\`search::score(0) DESC\` }]`. 🔶 formas mistas no M0.1.

#### 2.2.3 Cláusulas de leitura

| Arg | SurrealQL | Notas |
| --- | --- | --- |
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

#### 2.2.4 `.throw()` e `.explain()`

- `.throw(factory?)` → `ResultNotFound` (ou erro da factory) com `NotFoundInfo`.
- `.explain()` → `ExplainResult { driver, operation, statements[{ key, surql, vars, plan }], ignoredOptions }`;
  keys `data|total|count|exists|probe:hasNext|probe:hasPrevious`; **não executa** e **não dispara hooks**.

### 2.3 Delegate — escrita

| Método | Args | Retorno | Lowering |
| --- | --- | --- | --- |
| `create({ data, only?, return? })` | `data` validado por `Create<T>` | `Row` (ou `ThrowingResult` com `return:'none'`) | `CREATE [ONLY] t CONTENT $p` |
| `createMany({ data[], skipDuplicates?, return? })` | N creates em 1 query | `BatchResult<Row>` | `BEGIN; CREATE …; CREATE …; COMMIT;` |
| `insert({ data, onDuplicate?, return? })` / `insertMany` | `'ignore' \| 'update' \| mapa surql` | `Row` / `BatchResult<Row>` | `INSERT [IGNORE] INTO t $p [ON DUPLICATE KEY UPDATE …]` |
| `update({ where, data?, mode?, unset?, return?, only?, timeout? })` | `mode: merge (default) \| set \| content \| replace \| patch` | `ThrowingResult<Row>` | `UPDATE … MERGE/SET/CONTENT/REPLACE/PATCH … WHERE …` |
| `updateMany({ where?, data, mode?, return?, timeout? })` | sem `where` = tabela inteira (rules) | `BatchResult<Row>` | `UPDATE … WHERE …` |
| `updateEach({ by, data[], mode?, onEmpty?, select?, return? })` | `by ∈ colunas`, sem duplicados | `BatchResult<Row>` | `FOR $row IN $p { UPDATE … WHERE by = $row.by };` |
| `patch({ where, patches })` | JSON Patch | `ThrowingResult<Row>` | `UPDATE … PATCH $p WHERE …` |
| `upsert({ where, data \| (create + update), mode? })` | id | `Row` | `UPSERT t:id MERGE $p` / `INSERT … ON DUPLICATE KEY UPDATE` |
| `upsertMany({ data[], update?, conflict?, return? })` | com id = 1 statement; sem id = `conflict` + LET/IF | `BatchResult<Row>` | ver M2.5 |
| `delete({ where, return?, only? })` | `return: before (default) \| none` | `ThrowingResult<Row>` | `DELETE [FROM] … RETURN BEFORE` |
| `deleteMany({ where?, all?, return? })` | sem `where` exige `all: true` (rules) | `BatchResult<never>` | `DELETE … WHERE …` |
| `relate(from, edge, to, { data?, return? })` | endpoints tipados | `Row` | `RELATE a->edge->b SET …` |
| `relateMany([...])` | | `BatchResult<Row>` | N `RELATE` em 1 query |
| `unrelate(from, edge, to)` / `unrelateMany({ where })` | | `BatchResult<never>` | `DELETE edge WHERE in = $a AND out = $b` / filtro |

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

### 2.4 Relações e grafos

**Descoberta de chave relacional** (campo × aresta) definida no `SchemaIndex` (§1.1).

| Recurso | Args | Lowering |
| --- | --- | --- |
| `include: { author: true }` (link) | | `FETCH author` |
| `include: { author: { select: {...} } }` | projeção no link | achatado + remontagem no client 🔶 |
| `include: { author: { include: { profile: true } } }` | aninhado | `FETCH author.profile` |
| `include: { likes: true }` (aresta) | | `(SELECT … FROM ->likes->posts) AS likes` |
| `include: { likes: { edge: true } }` | dados da aresta | `->likes` |
| `include: { likes: { edge: {...}, target: {...} } }` | ambos | `(SELECT …, out.* FROM ->likes) AS likes` |
| `include: { likes: { where, select, orderBy, limit, start } }` | subquery por pai | `(SELECT … FROM ->likes->posts WHERE … LIMIT …) AS likes` |
| `include: { relations: { wildcard: true, … } }` | `->?` | `(SELECT … FROM ->?) AS relations` |
| `include: { _count: { select: { posts: true, likes: { where } } } }` | contagens | `count(->posts) AS _count_posts` · `count(->likes[WHERE …])` |
| `where: { posts: { some: {...} } }` | filtro de relação | `count(->posts[WHERE …]) > 0` |
| `where: { posts: { none: {...} } }` | | `= 0` |
| `where: { followers: { every: {...} } }` | | `count(->followers[WHERE NOT …]) = 0` |
| `where: { profile: { is: {...} } }` / `isNot` | link | `profile.<campo> = $p` / negação |
| `select`/`where` com traversal | açúcar + `surql` | `->likes->posts.title`, `count(->likes)`, `<->?` |
| recursão | `surql` + helpers | **sintaxe 3.1.4** `rec.{1..2}(->edge->node)` / `@.{1..2}->edge->node` (o protótipo usa forma 2.x) 🔶 |

### 2.5 Paginação e agregações

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

### 2.6 Live queries e changefeeds

| Recurso | API | Lowering/observação |
| --- | --- | --- |
| live por delegate | `client.users.live({ where, select, diff, fetch, only, meta }, cb?)` | `LIVE SELECT … WHERE … DIFF FETCH …` |
| live dinâmica | `client.live('users', args, cb)` | idem |
| iterar | `for await (const c of sub)` | `LiveSubscription implements AsyncIterable` |
| encerrar | `sub.kill()` / `client.kill(uuid)` | idempotente |
| reatar | `client.liveOf(uuid, handler)` | `UnmanagedLivePromise` (SDK) |
| notificação | `LiveNotification<Row> { action, value, recordId, diff?, uuid, result? }` | normalizar `LiveMessage` do SDK |
| cláusulas inválidas | `orderBy/limit/group` → `ClauseNotSupportedInLive`; `live` em tx → `LiveInTransaction` |
| feature/transporte | WebSocket; `live.checkFeature` (SDK `Features`?) 🔶 | HTTP → `LiveQueryUnsupported` |
| reconexão | `live.reconnect` (default true) re-assina + evento `RECONNECTED` (extensão nossa) | observar eventos do `Surreal` |
| changefeed | `client.changes({ table?, since, limit })` | `SHOW CHANGES FOR TABLE/DATABASE SINCE … LIMIT …` |
| `ChangeSet` | `{ versionstamp, changes: [{ action, recordId, value?, before?, diff? }] }` | normalização |

### 2.7 Transações

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

### 2.8 Raw, funções e admin

| Recurso | API | Notas |
| --- | --- | --- |
| `$raw<T>` | tagged template (1 `${}` = 1 bind) ou `surql`/`BoundQuery`; `options: { timeout, meta, name }` | 1º statement, tipado pelo generic |
| `$query<T[]>` | vários statements; `{ throwOnError:false }` → `StatementResult[]` | usa `responses()` |
| `$unsafe` | string crua; exige `raw: { unsafe: true }`; senão `UnsafeDisabled` | `$unsafe(sql, params?)` |
| opções raw | `raw: { unsafe, requireComment, timeoutMs }` | hooks `beforeRaw/afterRaw/onRawError` |
| `fn.call` | `client.fn.call\<R\>('fn::x', args)` / `client.fn.x(args)` (schema) | via `db.run`/`invoke` |
| `api` | `client.api.get/post/put/patch/delete(path, { query, headers, body })` | SDK `api()`; erro com `status` + `details` |
| `auth` | `signin/signup/authenticate/invalidate/record` | SDK; `$withContext({auth})` isola sessão |
| admin | `info(level, table?)`, `version()`, `ping()`, `export()`, `import()` | passthrough SDK/`INFO` |
| `$sdk` | `Surreal` original | escape final |

### 2.9 `where` — vocabulário completo

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

### 2.10 Erros — catálogo de códigos

`ResultNotFound` · `DatabaseError` · `ParseError` · `AssertionFailed` · `RecordAlreadyExists` ·
`RecordNotFound` · `WriteConflict` · `SerializationFailure` · `PermissionDenied` · `NotAuthenticated` ·
`ValidationError` · `UnsafeDisabled` · `UnsupportedCapability` · `LiveQueryUnsupported` ·
`ClauseNotSupportedInLive` · `LiveInTransaction` · `TransactionAlreadyActive` · `TransactionRollback` ·
`CursorDirectionConflict` · `CursorTiebreakerRequired` · `UniqueTargetRequired` · `ReturnNotSupported` ·
`HavingUnsupported` · `RepositoryNotFound` · `UnknownField` · `PluginError` · `UnsafeMutation` (rules) ·
`SchemaInvalid` (bootstrap).

### 2.11 Hooks (payloads por operação)

`beforeQuery`/`afterQuery` · `beforeCreate`/`afterCreate` · `beforeUpdate`/`afterUpdate` ·
`beforeDelete`/`afterDelete` · `beforeRelate`/`afterRelate` · `beforeRaw`/`afterRaw`/`onRawError` ·
`beforeTransaction`/`afterTransactionCommit`/`afterTransactionRollback`/`onTransactionError` · `onError`.
Todos recebem `meta` (merge: `$withContext` → chamada vence) e são async-friendly.

### 2.12 Plugins

Contrato: `{ id, name?, version?, description?, config?, operationArgs?, setup?, transform?, hooks?,
extendClient?, extendModel? }` + delegates `$model/$state/$withState/$withoutPlugins`.

Escopo faseado: **F1** `rules` (guardrails: `noRawUnsafe`, `destructiveWriteWithoutWhere`,
`requireLimit`, `requireOrderByForCursor`, `maxLimit`; presets `safe/recommended/strict`) e
`zod` (validação de resultado/overrides — writes já validam via codec); **F2** `timestamps`,
`soft-delete`; **F3** (opcional) `audit`, `search`, `vector`, `record-id`.

---

## 3. Tipagem (type-level)

- **Base existente**: `App<TD>` (decoded), `Create<TD>`, `Update<TD>`, `Wire<TD>` — os shapes Zod já
  carregam tudo; o ORM **não cria schema paralelo**.
- **`Where<TD>`**: mapped type sobre `App<TD>`; operador por família do campo (reusar a lógica
  condicional de `expr.ts`); chaves lógicas `AND|OR|NOT`; paths aninhados por recursão **limitada**
  (budget de profundidade ~2–3, fallback `string` documentado); chaves relacionais = links ∪ arestas.
- **`Select<TD, S>`** → tipo projetado (alias, sub-objeto, `surql<T>` → `T`, `'*'`); **`Omit`**;
  **`Include<TD, I>`** → reescreve links com `App<Target>` / `App<Target>[]` e injeta `_count`;
  **`ResultOf<TD, Args>`** = interseção (full row ∪ select/omit ∪ include) — a base do retorno.
- **Delegates**: `Client<S>` = `{ [K in keyof S]: Delegate<S[K], S> }`; `repository()` retorna a união;
  entradas `string`/`Table` caem num delegate schemaless (`Record<string, unknown>`).
- **Pagination types**: `PaginationResult<T>` / `CursorResult<T>` (envelopes do §2.5).
- **`.throw()`/`.explain()`** preservam generics via `ThrowingResult<T>`/thenable preguiçoso.
- **Type-perf**: suíte `test/types/orm-*.assert.ts` (attest) + `orm-*.bench.ts` (budgets) sob
  `scripts/type-perf.ts`; re-baseline consciente. Foco: `Where` recursivo, `Include`, `ResultOf`.

---

## 4. Milestones (implementação ponto a ponto)

> Convenção: cada milestone lista **objetivo · entregáveis · API · SurrealQL · testes/aceite · deps**.
> O cutover da API antiga é o **M7** (a API nova cresce ao lado até lá; o `main` fica verde).

### M0 — Fundação

#### M0.1 — Mapa de sintaxe verificado ao vivo (`orm-syntax-map.md`)
- **Objetivo**: provar cada construto SurrealQL que o ORM vai emitir contra o **3.1.4**, como o
  `graph-syntax-map.md` já faz para grafos. Nada de implementar sobre suposição.
- **Entregáveis**: `drivers/surrealdb/docs/orm-syntax-map.md` + `test/live/orm-syntax.test.ts`
  (probes ao vivo, skip sem binário).
- **Cobre**: `INSERT`/`IGNORE`/`ON DUPLICATE KEY UPDATE`; `UPDATE` `SET/MERGE/CONTENT/REPLACE/PATCH/UNSET`
  + `ONLY`; `RETURN BEFORE/AFTER/DIFF/NONE`; update por `WHERE id =` (não cria) × `UPDATE t:id` (cria);
  `CREATE ONLY` em expressão (`LET $x = (CREATE ONLY …)`); `FETCH` simples/aninhado/projetado;
  `OMIT`; `SPLIT`; `GROUP BY/ALL` + `math::*`/`array::group`; `WITH [NO]INDEX`; `TIMEOUT/PARALLEL/VERSION`;
  `EXPLAIN`; ranges `t:a..=b`; `LIVE SELECT … DIFF FETCH`; `SHOW CHANGES`; subquery correlacionada
  (`$parent`); operadores `~`/`?~`/`*~`/`?=`/`*=`/`INSIDE`/`INTERSECTS`/`@@`/`@n@`/`<|k|>`; paths
  `[*]`/`[0]`; recursão 3.x (`rec.{…}(…)` vs `@.{…}->…`); `SELECT VALUE`; `count()`/`exists` probe.
- **Aceite**: cada linha do mapa com resultado real anexado; divergências do protótipo registradas.

#### M0.2 — `defineSchema` + `SchemaIndex`
- **Objetivo**: metadados runtime por tabela (colunas, links, arestas, singleton, funções) + validação.
- **Entregáveis**: `src/orm/schema.ts`, `src/orm/types/schema.ts`, testes `test/unit/orm-schema.test.ts`.
- **API**: `defineSchema({ users: User, likes: Likes, sendMail, auditLog: 'audit_log' })`.
- **Aceite**: índice correto para `s.recordId(User)` (single/array/optional/union), `RelationDef`
  (adjacência from/to), singleton, `FunctionDef`; bootstrap falha com `SchemaInvalid` em duplicata/
  colisão/aresta órfã; tipos: `SchemaOf` extrai keys/delegates.

#### M0.3 — Result wrappers + erros
- **Entregáveis**: `src/orm/results.ts`, `src/orm/errors.ts`, testes unit.
- **Aceite**: `ThrowingResult` (await e `.throw()` com factory), `BatchResult`,
  `StatementResult`, normalização de `ServerError`/`QueryResponseFailure` → códigos, predicados.

#### M0.4 — Executor
- **Entregáveis**: `src/orm/execute.ts`, testes unit com fake connection.
- **Aceite**: N statements em **1** chamada; ordem preservada; status por statement via `responses()`;
  erro com `statementIndex`/`surql`/`vars`; `BEGIN/COMMIT` implícito quando fora de tx; binds únicos.

#### M0.5 — Bootstrap e delegates (esqueleto)
- **Entregáveis**: `src/orm/index.ts`, `src/orm/client.ts`, `src/orm/delegate.ts`; export `./orm` no
  `package.json`; testes unit (client shape) e types (keys → delegates).
- **API**: `betterSurreal`, `createBetterSurreal`, `client.<key>`, `repository()`, `tables`, `$sdk`,
  `close`, `[asyncDispose]`, `forkSession`.
- **Aceite**: delegate existe para cada chave; `.repository` por chave/nome físico; schemaless entry;
  colisão de `extends` falha; BYO close = no-op; managed close fecha.

### M1 — Leitura

#### M1.1 — Compilador `where`
- **Entregáveis**: `compiler/shared.ts`, `compiler/where.ts`, `types/where.ts`, golden tests.
- **Escopo**: universais + por tipo + lógicos + paths aninhados + fragments + fast path; **tudo**
  do §2.9, com verificação do M0.1 onde marcado 🔶.
- **Aceite**: golden args→`{surql,vars}`; injeção impossível (nomes validados/escapados); budget de tipos.

#### M1.2 — `findMany` + cláusulas
- **Escopo**: `select` (todas as formas), `omit`, `orderBy`, `limit/take`, `start/skip`, `only`,
  `value`, `range`, `split`, `groupBy/groupAll`, `with`, `timeout`, `parallel`, `version`, `meta`.
- **Aceite**: golden SurrealQL por forma; decode de linha cheia/projeção; live tests (M0.1) para as
  formas usadas; `ClauseNotSupported` quando incoerente (ex.: `groupBy` sem agregador?).

#### M1.3 — `findFirst`/`findOne`/`findUnique` + `.throw()`
- **Aceite**: `ONLY`/`LIMIT 1`; `UniqueTargetRequired` sem id/campo único; `NotFoundInfo` correto;
  tipos `ThrowingResult<Row>`.

#### M1.4 — `count`/`exists`
- **Aceite**: `GROUP ALL`; `exists` via `SELECT VALUE id … LIMIT 1`; ignora cláusulas inválidas com
  `ignoredOptions` no explain.

#### M1.5 — `aggregate`
- **Aceite**: operadores do §2.5 + `surql` livre + `_count`; `having` → `HavingUnsupported`; tipos do
  resultado pelos agregadores.

#### M1.6 — `paginate` + `cursor`
- **Aceite**: 2 statements em 1 query (`data`+`total`); `count:false` sonda n+1; cursor id e tupla;
  `after`/`before` exclusivos; tiebreaker obrigatório; aritmética do envelope; tipos.

#### M1.7 — `.explain()` + `explain: true`
- **Aceite**: `ExplainResult` com `statements[].key` correto por operação; **não executa**; hooks de
  query não disparam; `ignoredOptions`.

#### M1.8 — Tipos de leitura
- **Aceite**: `test/types/orm-reads.assert.ts` (projeção/omit/include básico/value/only) + budgets.

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
  `all: true` para tabela inteira; cascatas documentadas (server-side `REFERENCE ON DELETE`).
- **M2.7 `updateEach`** — `by` (default `id`), duplicados rejeitados, `mode`, `onEmpty:'return'|'throw'`,
  ordem do `data`, `skipped`, `statements`.
- **M2.8 `relate`/`relateMany`/`unrelate`/`unrelateMany`** — endpoints tipados (id/row/array/subquery/
  `$param`), edge id nomeado, `data` na aresta; delegates de aresta normais; `REFERENCE ON DELETE`.
- **Aceite de cada**: golden SQL + live test + decode + hooks (quando existirem) + erro normalizado.

### M3 — Relações e grafos

- **M3.1 `include` link → `FETCH`** — simples, aninhado, projeção (remontagem), múltiplos links.
- **M3.2 `include` grafo** — traversal, `edge`/`target`, filtros por pai, wildcard, polimórfico.
- **M3.3 `_count`** — subqueries correlacionadas; links array (`count(campo)`) e arestas.
- **M3.4 `where` relacional** — `is`/`isNot`/`some`/`every`/`none` (comportamento NONE em negação
  verificado ao vivo).
- **M3.5 Traversal/recursão** — açúcares + `surql`; documentar a sintaxe 3.x (`rec.{…}(…)`);
  helpers mínimos (`@.{n}` em SELECT) só se o M0.1 confirmar.
- **Aceite**: cada forma com live test no grafo de exemplo (usar `docs/graph-syntax-map.md` como base)
  + tipos de `include`/`_count` + budgets.

### M4 — Transações, live e changefeeds

- **M4.1 `client.transaction`** — `sdk`/`sql`, commit/cancel, `rollback`, aninhada mesma tx,
  `afterCommit`/`afterRollback`, retries (`writeConflict`/`serializationFailure`/`connectionError`),
  `timeout`/`context`, `onUnsupported`; `TransactionAlreadyActive`.
- **M4.2 `live`** — delegate + dinâmica, `where/select/diff/fetch/only`; `LiveSubscription`
  (asyncIterator, `kill`), `liveOf`, normalização `LiveNotification`, feature check, reconexão +
  `RECONNECTED`; erros `LiveQueryUnsupported`/`ClauseNotSupportedInLive`/`LiveInTransaction`.
- **M4.3 `changes`** — `SHOW CHANGES` table/database, `since` (versionstamp/Date/ISO), normalização
  `ChangeSet`, paginação por versionstamp.
- **Aceite**: live e2e (WebSocket/ephemeral), rollback em erro, retry forçado, tipos dos envelopes.

### M5 — Escape hatches, admin e contexto

- **M5.1 `$raw`/`$query`/`$unsafe`** — tagged template parametrizado, `BoundQuery`, opções raw,
  `throwOnError:false`, hooks raw; `UnsafeDisabled`.
- **M5.2 `fn`/`api`/`auth`/admin** — `fn.call` + atalho tipado por `defineSchema`; `api.*` (status +
  `details`); `auth.*`; `info/version/ping/export/import`.
- **M5.3 `$withContext`/`extends`/estado** — clone com NS/DB (`USE NS … DB …;` prefixado na operação),
  `auth` (via `forkSession`), `meta`; helpers reaplicados; `$model/$state/$withState/$withoutPlugins`.
- **Aceite**: multi-tenant e2e (NS/DB por contexto sem vazar estado global), raw parametrizado,
  helpers em tx/clone.

### M6 — Plugins e hooks

- **M6.1 Hooks** — tipos + dispatch em todos os pipelines (fast path preservado).
- **M6.2 `definePlugin`** — pipeline, `operationArgs` tipados, `extendClient`/`extendModel`, `setup`,
  estado por delegate, `transform` mutando `where/data/kind`, `setup` fail-fast.
- **M6.3 Plugins oficiais F1** — `plugins/rules` (presets + guardrails; `UnsafeMutation`/
  `UnknownField`/`RepositoryNotFound`) e `plugins/zod` (validação de resultado/overrides).
- **M6.4 F2 (opcional)** — `timestamps`, `soft-delete` (+ `restore`).
- **Aceite**: soft-delete/rules e2e; plugin com `operationArgs` estendendo a tipagem do delegate.

### M7 — Cutover, limpeza e hardening

- **M7.1 Cutover** — remover fluent builder (`query/index.ts`, `write.ts`, `graph.ts`, `schemaless.ts`),
  métodos de query do `/client`, `packages/core/src/query/*` e exports; `/query` fica só fragments;
  ajustar `connection.ts`/config (`EntryClient`) e `ctx.connections`; atualizar `AGENTS.md` (surface).
- **M7.2 Docs** — `ROADMAP.md` (substituir o arco query-layer), `RELEASE-MATURITY.md`, `AUTHORING-SPLIT.md`,
  `MULTI-CONNECTION.md`, `packages/core/docs/query-builder-design.md` (marcar histórico/superseded),
  driver `README`, `docs/ORM-COVERAGE.md` novo (exaustivo), examples/cookbook.
- **M7.3 Verificação final** — `bun scripts/land.ts` gate; type-perf; e2e/live; exemplos + manifest;
  CHANGELOG (breaking + added) numa entrada de release.
- **Aceite**: workspace typecheck+test verde; nenhuma referência à API antiga; coverage do ORM
  sem lacunas não-documentadas; protótipo referenciado como design.

---

## 5. Testes e verificação

| Camada | O que | Como |
| --- | --- | --- |
| Golden (unit) | args → `{ surql, vars }` exato, por forma | `test/unit/orm-*.test.ts` |
| Unit de decode | fake rows → `App<T>`/projeção/include | idem, sem servidor |
| Live | cada construto SurrealQL (M0.1) + operações ponta a ponta | `test/live/orm-*.test.ts` (skip sem `surreal`) |
| E2e | fluxos (tenant, transação, live, seed) | `test/e2e/` com harness existente |
| Tipos | completude (attest) + budgets de instanciação | `test/types/orm-*.assert.ts` / `.bench.ts` |
| Exemplos | cookbook (`examples/orm/*`) | `_kit.ts` + `bun run gen:examples` |
| Coverage | matriz exaustiva da superfície ORM | `drivers/surrealdb/docs/ORM-COVERAGE.md` |

Padrões do repo: live tests com timeout alto (5s default do bun × carga paralela), `setDefaultTimeout`
no harness e2e, `surrealBinaryAvailable()` para skip, nomes de teste que o reconcile de coverage espera.

---

## 6. Migração, breaking changes e documentação

- **Coexistência**: M0–M6 adicionam o `/orm` **ao lado** da API atual; só o M7 remove. O gate do
  `land.ts` roda a cada milestone — nada de big bang.
- **Breaking (M7)**: remoção de `select/create/update/upsert/remove/relate/get` fluentes, `Any*`/
  `AnyStatement`, `Select`/`CreateQuery`/…, schemaless builder, `core/query`; `Client` antigo → conexão
  enxuta. Alpha permite; CHANGELOG marca.
- **Config/consumidores**: `surrealConnection`/`defineConfig().connect()` passam a devolver a conexão;
  `ctx.connections` deixa de ter `.select` (docs/`MULTI-CONNECTION.md` atualizados no M7.2).
- **Protótipo**: permanece como referência de design; a verdade de sintaxe é o `orm-syntax-map.md`.

---

## 7. Riscos e questões abertas

| # | Risco/questão | Mitigação |
| --- | --- | --- |
| 1 | Divergência protótipo × SurrealDB 3.1.4 (recursão, `~`, `[*]`, FETCH projetado, `EXPLAIN`, `VERSION`) | M0.1 verifica **antes** de implementar; mapa versionado como os outros docs empíricos. |
| 2 | `UPDATE t:id` cria registro (semântica) | compilar update por `WHERE id = …` e testar ao vivo (M0.1/M2.3). |
| 3 | Type-perf de `Where`/`Include` recursivos | recursão limitada + budgets (attest) desde M1; re-baseline consciente. |
| 4 | `include` com projeção/remontagem complexa | faseado (FETCH simples → projetado → grafo) e verificado por caso. |
| 5 | `$withContext` NS/DB sem estado global | `USE NS…DB…` prefixado por operação (1 round-trip); `auth` via `forkSession`; teste multi-tenant. |
| 6 | Retry de transação re-executa callback | documentar callback puro + `afterCommit` para efeitos. |
| 7 | `ON DUPLICATE`/`PATCH`/`REPLACE` não usados hoje no driver | M0.1 + live tests antes de expor. |
| 8 | Volume de plugins oficiais | F1 `rules`/`zod` primeiro; resto incremental, subpaths (não packages). |
| 9 | Colisão nomes de relação (campo × aresta) | precedência documentada + erro de bootstrap. |
| 10 | Nome da factory (`betterSurreal` vs `betterSchemic`) | decisão do §0.2 — confirmar antes do M0.5 (trivial de trocar depois). |

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
| `14-referencia-e-cookbook` | cheat-sheets + receitas | §2, M7.3 (exemplos) |
| `analise-better-drizzle/*` | estilo (delegate, args-objeto, retornos, segurança) | §0.1, §0.2, §2 |

---

**Próximo passo:** confirmar as decisões do §0.2 (nomes) e iniciar pelo **M0.1**.
