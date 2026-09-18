# 03 — Leitura: `findMany`, `select` e cláusulas

Este é o coração da API. Todas as leituras seguem o mesmo objeto de argumentos:

```ts
client.users.findMany({
	where,        // filtro (ver 04-filtros-where.md)
	select,       // projeção
	include,      // relações: FETCH + traversal de grafo (ver 08)
	omit,         // remove campos do resultado
	orderBy,
	limit,        // alias: take
	start,        // alias: skip
	range,        // record ranges (users:1..users:100)
	split,        // SPLIT (desdobra arrays)
	groupBy,      // GROUP BY
	groupAll,     // GROUP ALL
	only,         // FROM ONLY
	value,        // SELECT VALUE (retorna valores diretos)
	with,         // WITH [NO]INDEX
	timeout,      // TIMEOUT
	parallel,     // PARALLEL
	version,      // VERSION (query no passado)
	explain,      // roda EXPLAIN e devolve o plano
	meta,         // metadata para hooks/plugins
});
```

## `findMany`

```ts
const users = await client.users.findMany({
	where: { active: true },
	select: { id: true, name: true, email: true },
	orderBy: [{ createdAt: 'desc' }],
	limit: 20,
	start: 0,
});
```

```surql
SELECT id, name, email FROM users
WHERE active = $p0
ORDER BY createdAt DESC
LIMIT $p1
START $p2;
-- vars: { p0: true, p1: 20, p2: 0 }
```

Retorno: `User[]` (array vazio se nada casar). Nunca lança por "não achou".

### Sem `select` e com `omit`

```ts
await client.users.findMany({ omit: ['password'] });
```

```surql
SELECT * OMIT password FROM users;
```

## `findFirst` / `findOne` / `findUnique`

| Método | Semântica | SurrealQL |
| --- | --- | --- |
| `findFirst(args?)` | primeiro resultado de um filtro | `SELECT * FROM users WHERE ... LIMIT 1` |
| `findOne(args?)` | alias de `findFirst` | idem |
| `findUnique(args)` | registro único (id ou campo único) | `SELECT * FROM ONLY users:aeon` |

```ts
const user = await client.users.findUnique({ where: { id: 'users:aeon' } });

if (!user) {
	// tipo: User | null
}

const aeon = await client.users.findUnique({ where: { id: 'users:aeon' } })
	.throw(() => new Error('Usuário não encontrado'));
// tipo: User
```

```surql
SELECT * FROM ONLY users:aeon;
```

- Com `id` no `where`, `findUnique` compila `FROM ONLY <record id>` — o servidor devolve **objeto**,
  não array.
- Com campo único (ex.: `email`), compila `SELECT * FROM users WHERE email = $p0 LIMIT 1`.
- `findUnique` sem `id` e sem campo único no schema é rejeitado em tempo de tipo/runtime
  (`code: 'UniqueTargetRequired'`).
- Todos os três retornam `ThrowingResult<T>`: `await` dá `T | null`; `.throw()` dá `T` ou lança.

## `count` e `exists`

```ts
const total = await client.users.count({ where: { active: true } });
const hasActive = await client.users.exists({ where: { active: true } });
```

```surql
SELECT count() FROM users WHERE active = $p0 GROUP ALL;
-- → [{ count: 42 }]

SELECT VALUE id FROM users WHERE active = $p0 LIMIT 1;
-- → [ users:... ]  (exists => length > 0)
```

- `count` sem filtro: `SELECT count() FROM users GROUP ALL;`.
- Ambos ignoram `select`/`include`/`orderBy` (não fazem sentido): só `where`, `range`, `timeout`,
  `parallel`, `version`, `meta`.

## `aggregate` — GROUP BY / GROUP ALL

```ts
const porPais = await client.users.aggregate({
	where: { active: true },
	groupBy: ['address.country'],
	select: {
		country: 'address.country',
		_count: true,                          // count()
		avgAge: { avg: 'age' },
		minAge: { min: 'age' },
		maxAge: { max: 'age' },
		emails: { collect: 'email' },          // array::group(email)
	},
	orderBy: [{ _count: 'desc' }],
});

const geral = await client.orders.aggregate({
	groupAll: true,
	select: {
		_count: true,
		revenue: { sum: 'total' },
		avgTicket: { avg: 'total' },
		lastOrder: { max: 'createdAt' },
	},
});
```

```surql
SELECT address.country AS country, count() AS _count,
       math::avg(age) AS avgAge, math::min(age) AS minAge, math::max(age) AS maxAge,
       array::group(email) AS emails
FROM users
WHERE active = $p0
GROUP BY address.country
ORDER BY _count DESC;
```

```surql
SELECT count() AS _count, math::sum(total) AS revenue,
       math::avg(total) AS avgTicket, math::max(createdAt) AS lastOrder
FROM orders
GROUP ALL;
```

Operadores de agregação e o SurrealQL que geram:

| Arg | SurrealQL |
| --- | --- |
| `_count: true` | `count()` |
| `{ sum: 'field' }` | `math::sum(field)` |
| `{ avg: 'field' }` | `math::avg(field)` |
| `{ min: 'field' }` | `math::min(field)` |
| `{ max: 'field' }` | `math::max(field)` |
| `{ collect: 'field' }` | `array::group(field)` |
| `{ median: 'field' }` / `{ stddev: 'field' }` / `{ variance: 'field' }` | `math::median/...` |
| `{ distinct: 'field' }` | `array::distinct(field)` |
| fragmento `surql` | interpolado como expressão (`AS` pela chave) |

- `having` não existe no SurrealQL: filtre em volta com uma subquery via [`$query`](./12-raw-funcoes-e-apis.md)
  ou um `LET` cru. A API é explícita quanto a essa limitação (`code: 'HavingUnsupported'` se você passar `having`).
- Agregações são helpers — para relatórios complexos, prefira `$query` com tipos explícitos.

## `select` — projeções

| Forma | Exemplo | SurrealQL |
| --- | --- | --- |
| Campos diretos | `select: { id: true, title: true }` | `SELECT id, title` |
| Array de campos | `select: ['id', 'title']` | `SELECT id, title` |
| Caminho aninhado | `select: { 'address.city': true }` | `SELECT address.city` |
| Alias de caminho | `select: { authorName: 'author.name' }` | `SELECT author.name AS authorName` |
| Sub-objeto | `select: { address: { city: true, country: true } }` | `SELECT address.city, address.country` |
| Tudo + extras | `select: { '*': true, score: surql`search::score(0)` }` | `SELECT *, search::score(0) AS score` |
| Expressão | `select: { idadeEm2025: surql`age + ${1}` }` | `SELECT age + $p0 AS idadeEm2025` |
| Valor direto | `select: { name: true }, value: true` | `SELECT VALUE name` |

```ts
const posts = await client.posts.findMany({
	select: {
		'*': true,
		authorName: 'author.name',
		similarity: surql`vector::similarity::cosine(embedding, ${vec})`,
	},
	orderBy: [{ similarity: 'desc' }],
	limit: 5,
});
```

```surql
SELECT *, author.name AS authorName,
       vector::similarity::cosine(embedding, $p0) AS similarity
FROM posts
ORDER BY similarity DESC
LIMIT $p1;
```

## `orderBy`

```ts
orderBy: [{ createdAt: 'desc' }, { name: 'asc' }]

orderBy: [surql`rand()`]                     // ORDER BY rand()

orderBy: [{ score: surql`search::score(0) DESC` }]  // expressão própria
```

```surql
ORDER BY createdAt DESC, name ASC;
```

## Limites, ranges e `SPLIT`

```ts
await client.logs.findMany({ limit: 100, start: 200 });
await client.users.findMany({ limit: 10, take: 10 });   // 'take' é alias de 'limit'
```

```surql
SELECT * FROM logs LIMIT $p0 START $p1;
```

Record ranges: `FROM users:1..users:100` (inclusive por padrão até o limite).

```ts
await client.users.findMany({
	range: { start: 'users:1', end: 'users:100' },
});

await client.users.findMany({
	range: { start: 'users:1', end: 'users:100', inclusive: true }, // users:1..=users:100
});
```

```surql
SELECT * FROM users:1..users:100;
SELECT * FROM users:1..=users:100;
```

`SPLIT` desdobra arrays em várias linhas:

```ts
await client.posts.findMany({ select: { title: true, tags: true }, split: 'tags' });
```

```surql
SELECT title, tags FROM posts SPLIT tags;
```

## Dicas de plano: `with`, `timeout`, `parallel`, `version`

```ts
await client.users.findMany({
	where: { email },
	with: { index: 'idx_email' },   // WITH INDEX idx_email
});

await client.reports.findMany({
	where: { year: 2024 },
	timeout: '10s',                 // TIMEOUT 10s
	parallel: true,                 // PARALLEL
});

await client.invoices.findMany({
	where: { status: 'open' },
	version: '2025-01-01T00:00:00Z', // VERSION d'2025-01-01T00:00:00Z'
});
```

```surql
SELECT * FROM users WITH INDEX idx_email WHERE email = $p0;
SELECT * FROM reports WHERE year = $p0 TIMEOUT 10s PARALLEL;
SELECT * FROM invoices WHERE status = $p0 VERSION d'2025-01-01T00:00:00Z';
```

- `timeout` aceita `number` (ms) ou string de duração (`'10s'`, `'500ms'`, `'1h'`).
- `with` aceita `{ index: 'idx' | ['idx1','idx2'], noIndex: true }`.
- `version` aceita `Date` ou string ISO; compila para o literal `d'...'`.

## `only`

- `only: true` compila `FROM ONLY` e devolve **um objeto** — útil em conjunto com `findMany` para
  pegar o registro já desembrulhado. Os helpers de registro único (`findUnique`, `update`, `delete`,
  `upsert`) já usam `ONLY` quando o alvo é um id, então raramente você precisa passar `only`.

## `.throw()` em leituras

```ts
const user = await client.users.findFirst({ where: { email } })
	.throw(({ table, where }) => new NotFoundError(`${table} não encontrado: ${JSON.stringify(where)}`));
```

```ts
type NotFoundInfo = {
	table: string;
	operation: 'findFirst' | 'findOne' | 'findUnique' | 'update' | 'delete';
	where: unknown;
	surql: string;
	vars: Record<string, unknown>;
};
```

Sem factory, `.throw()` lança `BetterSurrealError` com `code: 'ResultNotFound'`.

## `.explain()` — plano sem executar a query

Toda leitura (incluindo `paginate`/`cursor`) devolve um thenable preguiçoso com `.explain()`:

```ts
const plano = await client.users.findMany({
	where: { active: true },
	orderBy: [{ createdAt: 'desc' }],
	limit: 10,
}).explain();
```

```ts
type ExplainResult = {
	driver: 'surrealdb';
	operation: 'findMany';
	statements: Array<{
		key: 'data' | 'total' | 'count' | 'exists' | 'probe:hasNext' | 'probe:hasPrevious';
		surql: string;
		vars: Record<string, unknown>;
		plan: unknown;          // saída do EXPLAIN do SurrealDB
	}>;
	ignoredOptions: string[];   // ex.: ['parallel'] quando não aplicável
};
```

```surql
EXPLAIN SELECT * FROM users WHERE active = $p0 ORDER BY createdAt DESC LIMIT $p1;
```

- `paginate` gera dois planos (`data` + `total`); `cursor` gera `data` + probes.
- `.explain()` **não executa** a query real e **não dispara** hooks de query — é ferramenta de
  diagnóstico.
- `explain: true` no args faz o mesmo inline: `await client.users.findMany({ where, explain: true })`.

## Nota sobre locks

SurrealDB não tem `FOR UPDATE`/`FOR SHARE` como os bancos SQL. O controle de concorrência é por
**transação otimista**: conflitos de escrita retornam `write conflict` e podem ser re-tentados
(ver [10-transacoes](./10-transacoes.md)). Por isso não existe `lock` na API; use transações +
retry (`retry: { on: ['writeConflict'] }`).
