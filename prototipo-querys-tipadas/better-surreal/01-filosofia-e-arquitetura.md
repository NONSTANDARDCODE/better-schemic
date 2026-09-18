# 01 — Filosofia e arquitetura

## O que o better-surreal é

Uma camada de **repositórios** por cima do SDK oficial do SurrealDB (v2+). Ela não esconde o SurrealQL:
**compila** a API tipada para SurrealQL parametrizado, executa em **um único round-trip** sempre que
possível e devolve resultados tipados, com escape hatches (`$raw`, `$query`, `$sdk`) quando você quiser
descer para o metal.

```
Seu schema tipado (já existente no seu projeto)
        │
        ▼
SDK Surreal  (new Surreal(); connect(); use(); signin())
        │
        ▼
betterSurreal(db, { schema, plugins, hooks, raw, transaction, live })
        │
        ├─ client.users / client.posts / client.likes   ← delegate por tabela/aresta
        ├─ client.transaction(...) · client.live(...) · client.changes(...)
        ├─ client.fn · client.api · client.auth · client.$withContext(...)
        └─ client.$raw / $query / $unsafe / $sdk
```

## Cinco princípios

1. **Minimal e type-safe, sem codegen.**
   Nada de schema paralelo ou client gerado: o schema do seu projeto já carrega os tipos; os delegates
   são inferidos a partir dele em tempo de compilação.
2. **Um delegate por tabela.**
   Nada de `db.query('SELECT * FROM users ...')` espalhado; você escreve `client.users.findMany(...)`,
   e o nome da tabela também vira o nome do repositório.
3. **Um objeto de args, nunca um DSL.**
   `findMany({ where, select, orderBy, limit })`, `create({ data })`, `upsert({ where, create, update })`.
   O mesmo gesto para tudo; composição em vez de encadeamento.
4. **Aproveitar o SurrealDB até o fim.**
   `ONLY`, `FETCH`, traversal de grafo, `UPSERT`, `ON DUPLICATE KEY UPDATE`, `LIVE SELECT`,
   `SHOW CHANGES`, full-text, KNN — cada recurso tem um lugar natural na API, e o SurrealQL gerado
   aparece nos exemplos para provar.
5. **Seguro por default, cru por escolha.**
   Tudo parametrizado; `$unsafe` desligado; sem `where` em operações destrutivas os guardrails
   disparam; recursos indisponíveis (live via HTTP, KNN sem índice, dialeto/nível de acesso) falham
   com erro tipado.

## Como uma operação funciona por dentro

```
client.users.findMany({ where: {...}, select: {...}, limit: 10 })
        │
   1. Validação + normalização dos args (aliases take→limit, skip→start)
        │
   2. Pipeline de plugins (se houver): transform(op) muta where/select/data
        │
   3. Compilação → BoundQuery
        surql:  "SELECT id, name FROM users WHERE active = $p0 ORDER BY createdAt DESC LIMIT $p1"
        vars:   { p0: true, p1: 10 }
        │
   4. Execução (1 statement; em lote/relações: statements encadeados no MESMO db.query)
        │
   5. Hooks de observação (beforeQuery/afterQuery) e checagem de status por statement
        │
   6. Resultado tipado: Row[] · ThrowingResult<Row> · BatchResult<T> · AggregationResult
```

Pontos-chave:

- **Parametrização sempre.** Valores viram `$p0`, `$p1`, ... e são passados como variáveis ligadas.
  O que não é dado (nomes de tabela, campos, direção de `ORDER BY`) é validado contra o schema e
  interpolado como identificador.
- **Um round-trip.** `createMany`, `updateEach`, `upsertMany`, `paginate` (dados + count) e leituras
  com relações compilam para **múltiplos statements em um só `db.query`**. O SDK devolve um array de
  resultados por statement, e o better-surreal remonta o resultado público.
- **Fast path.** Se nenhum plugin tem trabalho para aquela operação, o pipeline é pulado e o
  compilador vai direto ao statement.
- **Status por statement.** O SDK pode devolver erros no meio de um lote; o better-surreal inspeciona
  cada resultado e lança `BetterSurrealError` com `statementIndex`, preservando o que já executou
  (quando dentro de `transaction`, o rollback é automático).

## Nomes e formas (contrato da API)

| Ação | Método | Statement SurrealQL |
| --- | --- | --- |
| buscar vários | `findMany` | `SELECT` |
| buscar primeiro | `findFirst` / `findOne` | `SELECT ... LIMIT 1` |
| buscar único | `findUnique` | `SELECT ... FROM ONLY <id>` |
| contar | `count` | `SELECT count() ... GROUP ALL` |
| existe? | `exists` | `SELECT VALUE id ... LIMIT 1` |
| agregar | `aggregate` | `SELECT ... GROUP BY/GROUP ALL` |
| paginar (offset) | `paginate` | `SELECT` + `count()` |
| paginar (cursor) | `cursor` | `SELECT` com `id > $cursor` / tupla |
| criar | `create` / `createMany` | `CREATE` |
| inserir | `insert` / `insertMany` | `INSERT [IGNORE]` + `ON DUPLICATE KEY UPDATE` |
| atualizar | `update` / `updateMany` | `UPDATE SET/MERGE/CONTENT/PATCH/REPLACE/UNSET` |
| atualizar por lote | `updateEach` | `FOR` + `UPDATE ... WHERE by = ...` |
| upsert | `upsert` / `upsertMany` | `UPSERT` ou `INSERT ... ON DUPLICATE` |
| remover | `delete` / `deleteMany` | `DELETE` |
| relacionar | `relate` / `unrelate` | `RELATE` / `DELETE <edge>` |
| ouvir mudanças | `live` | `LIVE SELECT` |
| changefeed | `changes` (client) | `SHOW CHANGES` |

### Aliases para quem vem do better-drizzle

- `take` → `limit` (canônico `limit`; ambos aceitos).
- `skip` → `start`.
- `orderBy: [{ createdAt: 'desc' }]` idêntico.
- `select` / `include` / `_count` com a mesma semântica.
- `only: true` existe nos dois (aqui compila `FROM ONLY`).
- `paginate`/`cursor` devolvem o mesmo envelope `{ data, pagination }`.

### Retornos

```ts
type ThrowingResult<T> = Promise<T | null> & {
	throw(factory?: (info: NotFoundInfo) => Error): Promise<T>;
};

type BatchResult<T> = {
	count: number;      // quantos registros foram afetados
	data?: T[];         // presente quando o RETURN devolve registros
	skipped?: number;   // itens ignorados (onEmpty: 'return', skipDuplicates)
	statements?: number;// quantos statements foram compilados (telemetria)
};

type StatementResult<T> = {
	result: T;
	status: 'OK' | 'ERR';
	time: string;
	error?: BetterSurrealError;
};
```

- `findMany` → `Row[]` (nunca lança por "não achou"; array vazio).
- `findFirst`/`findOne`/`findUnique`/`update`/`delete` → `ThrowingResult<Row>`.
- `create`/`insert`/`upsert` → `Row` (sempre devolvem o registro resultante; `return: 'none'`
  muda para `null` → então o tipo é `ThrowingResult`).
- `createMany`/`insertMany`/`updateMany`/`deleteMany`/`updateEach`/`upsertMany` → `BatchResult<Row>`.
- `count`/`exists`/`aggregate` → `number`/`boolean`/`Row[]`.

## O que muda em relação ao better-drizzle

| Aspecto | better-drizzle (SQL) | better-surreal |
| --- | --- | --- |
| Identidade | chave primária composta/`id` | **record id** (`users:aeon`, `users:⟨aleatório⟩`) |
| Relações | joins + batch loader | `FETCH` (links) e traversal de grafo (`RELATE`, `->`, `<-`) |
| Upsert | `ON CONFLICT DO UPDATE` | `UPSERT` + `ON DUPLICATE KEY UPDATE` nativos |
| Paginação | `LIMIT/OFFSET` + cursor por coluna | `LIMIT/START` + cursor por record id (ou tupla) |
| Schema | obrigatório (tabelas Drizzle) | **já existe no seu projeto**; aqui só consumimos |
| Tempo real | — | `live()` e `changes()` |
| Funções/APIs do banco | — | `fn.call()`, `client.api` |
| Tipos ricos | colunas SQL | `record`, `option`, `geometry`, `duration`, `datetime`, `decimal`, `array`, `set` |

## Quando NÃO usar (e usar `$raw`/`$sdk`)

- Statements muito específicos: `DEFINE`/`REMOVE`, `INFO`, `EXPLAIN` manual, `FOR` com lógica complexa,
  `IF/ELSE` grande — vão melhor em `$raw`/`$query` ou no `client.$sdk`.
- Queries de relatório com `LET`, subqueries profundas e `GROUP BY` com expressões: use `aggregate`
  quando couber bem; senão `$query` com tipos explícitos.
- Migrações/definições de schema: seu projeto de schema já cuida disso (ou `$raw`).

Nada disso é uma porta fechada: `where` e `select` aceitam **fragments `surql`** (interpolados com
parâmetros), então dá para misturar a API de repositório com SurrealQL cru no mesmo statement.
