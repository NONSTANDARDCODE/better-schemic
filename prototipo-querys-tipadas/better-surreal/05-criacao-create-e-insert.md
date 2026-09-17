# 05 — Criação: `create`, `createMany`, `insert`, `insertMany`

O SurrealDB separa **`CREATE`** de **`INSERT`** — e o better-surreal mantém os dois, porque a diferença
importa:

| Statement | Semântica | Ids | Duplicados |
| --- | --- | --- | --- |
| `CREATE` | sempre cria um novo registro | gerado aleatório (ou o que você passar) | **falha** se o id já existe |
| `INSERT` | insere um ou vários (aceita ids explícitos) | mantém os ids do payload | id duplicado = falha, a menos de `onDuplicate` |
| `INSERT IGNORE` | insere o que der | mantém ids | **pula** ids existentes |
| `INSERT ... ON DUPLICATE KEY UPDATE` | insere ou atualiza no conflito de id | mantém ids | atualiza campos mapeados |
| `UPSERT` | cria se não existir, atualiza se existir | id explícito ou gerado | nunca conflita |

Regra prática: **`create` para "novo registro"** (id novo, falha se repetido), **`insert` para dados
que vêm de fora com ids próprios** (import, sync, seed) e **`upsert` para "garantir o estado"**
(ver [06](06-atualizacao-e-upsert.md)).

## `create`

```ts
const user = await client.users.create({
	data: { name: 'Aeon', email: 'aeon@surreal.db', active: true },
});
// user.id → 'users:⟨aleatório⟩'
```

```surql
CREATE users CONTENT $p0;
-- vars: { p0: { name: 'Aeon', email: 'aeon@surreal.db', active: true } }
-- retorna: [ { id: users:⟨...⟩, name: 'Aeon', ... } ]
```

Com id explícito:

```ts
await client.users.create({
	data: { id: 'users:aeon', name: 'Aeon', email: 'aeon@surreal.db' },
});
```

```surql
CREATE users:aeon CONTENT $p0;
-- erro: Database Error — record already exists (se users:aeon já existir)
```

Ids não-ASCII e caracteres especiais são suportados (o SurrealDB usa `⟨...⟩` quando necessário):

```ts
await client.users.create({ data: { id: 'users:東京', name: 'Tóquio' } });
await client.users.create({ data: { id: 'users:hello world', name: 'Space' } });
```

```surql
CREATE users:⟨東京⟩ CONTENT $p0;
CREATE users:⟨hello world⟩ CONTENT $p0;
```

- `only: true` usa `CREATE ONLY users CONTENT $p0;` e devolve **um objeto** (não um array).
- `return: 'after'` é o default; `return: 'before'` devolve `null` lógico em criação;
  `return: 'none'` devolve `null` e o tipo vira `ThrowingResult<null>`. `return: 'diff'` devolve
  o JSON Patch (útil para auditoria).

### `createMany`

`CREATE` não aceita arrays; o better-surreal compila **um statement por registro em um único
`db.query`** (um round-trip) e, fora de transação, envolve em `BEGIN/COMMIT` para atomicidade.

```ts
const created = await client.users.createMany({
	data: [
		{ name: 'Aeon', email: 'aeon@surreal.db' },
		{ name: 'Landevin', email: 'landevin@surreal.db' },
	],
});
// created.count → 2
// created.data   → [User, User]
```

```surql
BEGIN TRANSACTION;
CREATE users CONTENT $p0;
CREATE users CONTENT $p1;
COMMIT TRANSACTION;
-- vars: { p0: {...}, p1: {...} }
```

- Um id repetido no meio aborta tudo (transação implícita) — o erro aponta `statementIndex`.
- Para volumes grandes com ids próprios, prefira `insertMany` (1 statement).

## `insert`

```ts
const rows = await client.users.insert({
	data: [
		{ id: 'users:aeon', name: 'Aeon', email: 'aeon@surreal.db' },
		{ id: 'users:landevin', name: 'Landevin', email: 'landevin@surreal.db' },
	],
});
```

```surql
INSERT INTO users $p0;
-- vars: { p0: [ {...}, {...} ] }
-- retorna: [ { id: users:aeon, ... }, { id: users:landevin, ... } ]
```

Aceita objeto único ou array; `insertMany` é só a forma explícita para arrays (mesma tipagem).

### `onDuplicate` — o que fazer no conflito

```ts
// 1. ignorar duplicados (INSERT IGNORE)
await client.users.insertMany({
	data: externalUsers,
	onDuplicate: 'ignore',
});
```

```surql
INSERT IGNORE INTO users $p0;
```

```ts
// 2. atualizar todos os campos presentes no payload (exceto id)
await client.users.insertMany({
	data: externalUsers,
	onDuplicate: 'update',
});
```

```surql
INSERT INTO users $p0
ON DUPLICATE KEY UPDATE name = $input.name, email = $input.email, active = $input.active;
```

```ts
// 3. mapeamento explícito (expressões surql podem usar $input)
await client.users.insertMany({
	data: externalUsers,
	onDuplicate: {
		name: surql`$input.name`,
		email: surql`$input.email`,
		syncedAt: surql`time::now()`,
		imports: surql`imports + 1`,
	},
});
```

```surql
INSERT INTO users $p0
ON DUPLICATE KEY UPDATE name = $input.name, email = $input.email,
                        syncedAt = time::now(), imports = imports + 1;
```

- `onDuplicate: 'update'` sem `$input` disponível no SurrealDB para campos aninhados: use o mapa
  explícito para caminhos (`$input.address.city`).
- `onDuplicate` funciona tanto em `insert` (objeto único) quanto em `insertMany`.
- `onDuplicate: 'ignore'` + `select` devolve só os inseridos; `count` reflete apenas inserções.

### `insert` como "seed idempotente"

O par `insertMany` + `onDuplicate: 'update'` é o caminho recomendado para sincronização em massa
(1 statement, menos memória, idempotente):

```ts
await client.users.insertMany({
	data: usersFromExternalApi,       // cada um com id 'users:<slug>'
	onDuplicate: { syncedAt: surql`time::now()`, active: surql`$input.active` },
	return: 'none',
});
```

```surql
INSERT INTO users $p0
ON DUPLICATE KEY UPDATE syncedAt = time::now(), active = $input.active
RETURN NONE;
```

## `RETURN` em criação

| `return` | Efeito | SurrealQL |
| --- | --- | --- |
| `'after'` (default) | registros resultantes | `RETURN AFTER` (omitido por ser default) |
| `'before'` | estado anterior (sempre `NONE` em create) | `RETURN BEFORE` |
| `'diff'` | JSON Patch do que mudou | `RETURN DIFF` |
| `'none'` | nada (economiza payload) | `RETURN NONE` |

```ts
const created = await client.users.create({
	data: { name: 'Aeon' },
	return: 'diff',
});
// created → [ { op: 'add', path: '/name', value: 'Aeon' }, ... ]
```

## Relações na criação

- **Record link direto**: basta passar o id — `data: { author: 'users:aeon' }`.
- **Grafo**: use [`relate`](./08-relacoes-e-grafos.md) ou crie o registro da aresta
  (`data: { in: 'users:aeon', out: 'posts:1' }`).
- **Sub-relacionamentos em um round-trip**: `create` aceita `relate` no payload (açúcar que compila
  `CREATE` + `RELATE` no mesmo `db.query`):

```ts
await client.posts.create({
	data: { title: 'SurrealDB', author: 'users:aeon' },
	relate: [
		{ from: 'users:aeon', edge: 'authored', to: '$self' },
	],
});
```

```surql
BEGIN TRANSACTION;
LET $created = (CREATE ONLY posts CONTENT $p0);
RELATE users:aeon->authored->$created;
COMMIT TRANSACTION;
```

> `to: '$self'` é compilado como o id criado pelo `CREATE`, capturado com
> `LET $created = (CREATE ...)` no mesmo lote e usado no `RELATE`.

## Plugins e campos automáticos

Plugins como `@better-surreal/timestamps` preenchem `createdAt`/`updatedAt` em `create`/`insert`
quando os campos existem no payload de transformação. Se você preferir que o **banco** defina
  (`DEFAULT time::now()`), o plugin pode ser configurado com `mode: 'database'` (ver [13](13-plugins-hooks-e-erros.md)).

## Erros comuns

| Situação | `code` | Dica |
| --- | --- | --- |
| id já existe em `create` | `RecordAlreadyExists` | use `upsert`/`insert onDuplicate` |
| id duplicado em `insert` sem `onDuplicate` | `RecordAlreadyExists` | `onDuplicate: 'ignore'`/`'update'` |
| violação de `ASSERT`/`TYPE` de campo | `AssertionFailed` / `ValidationError` | valide com o plugin zod antes |
| permissão negada (record access) | `PermissionDenied` | confira `DEFINE TABLE ... PERMISSIONS` |
