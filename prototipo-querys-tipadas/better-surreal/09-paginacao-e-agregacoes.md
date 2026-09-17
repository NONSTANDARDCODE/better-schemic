# 09 — Paginação e agregações

## `paginate` — offset (`LIMIT`/`START`)

```ts
const page = await client.posts.paginate({
	where: { published: true },
	orderBy: [{ createdAt: 'desc' }],
	limit: 20,          // por página
	start: 40,          // offset
	select: { id: true, title: true, createdAt: true },
});
```

```ts
page.data;        // Post[]
page.pagination;  // { type: 'offset', page, perPage, total, pageCount, hasNext, hasPrevious }
```

```surql
SELECT id, title, createdAt FROM posts
WHERE published = $p0
ORDER BY createdAt DESC
LIMIT $p1 START $p2;

SELECT count() FROM posts WHERE published = $p0 GROUP ALL;
-- vars: { p0: true, p1: 20, p2: 40 }
```

- As duas queries viajam no **mesmo `db.query`** (1 round-trip).
- `page` é calculado como `floor(start / limit) + 1`.
- `total` vem do `count()`; `pageCount = ceil(total / limit)`; `hasNext`/`hasPrevious` são derivados.
- `paginate` existe só para leituras — para `count` puro use `client.posts.count()`.

### Paginação sem total (mais barata)

Se você não precisa do `total` (infinit scroll), passe `count: false`:

```ts
const page = await client.posts.paginate({
	where: { published: true },
	limit: 20,
	start: 0,
	count: false,          // evita o SELECT count()
});
// page.pagination.total → undefined; hasNext pela sonda LIMIT n+1
```

```surql
SELECT * FROM posts WHERE published = $p0 LIMIT 21 START $p1;
-- o better-surreal usa o 21º registro para hasNext e corta para 20
```

## `cursor` — paginação por cursor

### Cursor por record id (o mais comum)

```ts
const first = await client.posts.cursor({
	where: { published: true },
	limit: 20,
	orderBy: [{ id: 'asc' }],
});

const next = await client.posts.cursor({
	where: { published: true },
	limit: 20,
	orderBy: [{ id: 'asc' }],
	after: first.pagination.nextCursor,       // posts:⟨...⟩
});

const prev = await client.posts.cursor({
	where: { published: true },
	limit: 20,
	orderBy: [{ id: 'asc' }],
	before: first.pagination.previousCursor,
});
```

```surql
-- first
SELECT * FROM posts WHERE published = $p0 ORDER BY id ASC LIMIT $p1;
-- next (after = posts:abc)
SELECT * FROM posts WHERE published = $p0 AND id > $p2 ORDER BY id ASC LIMIT $p1;
-- prev (before = posts:xyz)
SELECT * FROM posts WHERE published = $p0 AND id < $p3 ORDER BY id DESC LIMIT $p1;
-- o better-surreal reordena o resultado de 'prev'

-- sonda para hasNext (limit n+1)
SELECT id FROM posts WHERE published = $p0 ORDER BY id ASC LIMIT $p4;
```

```ts
first.pagination; // { type: 'cursor', hasNext, hasPrevious, nextCursor, previousCursor }
```

- O default é `orderBy: [{ id: 'asc' }]` — o record id é único e ordenável, perfeito para cursor.
- `nextCursor` = id do último item; `previousCursor` = id do primeiro.
- `after` e `before` são **mutuamente exclusivos** (`code: 'CursorDirectionConflict'`).

### Cursor com ordenação customizada (tupla)

Quando o `orderBy` não é o id, o cursor vira uma **tupla** `{ valores..., id }` para desempate:

```ts
const page = await client.posts.cursor({
	where: { published: true },
	orderBy: [{ score: 'desc' }, { id: 'asc' }],
	limit: 20,
});
// page.pagination.nextCursor → { score: 91, id: 'posts:abc' }
```

```surql
SELECT * FROM posts WHERE published = $p0
  AND (score < $c0 OR (score = $c0 AND id > $c1))
ORDER BY score DESC, id ASC
LIMIT $p1;
-- vars: { c0: 91, c1: posts:abc }
```

- A comparação `(a < x) OR (a = x AND b > y)` é gerada para tuplas de qualquer tamanho.
- O último campo da tupla deve ser único (`id` por default) — a API força isso
  (`code: 'CursorTiebreakerRequired'` se o `orderBy` não terminar em campo único).

## Agregações

`aggregate` (ver [03](./03-leitura-select.md)) cobre `GROUP BY`/`GROUP ALL` com os agregadores
`count`, `sum`, `avg`, `min`, `max`, `collect`, `distinct`, `median`, `stddev` e fragments
`surql`. Dois pontos importantes aqui:

### Agregados + paginação

```ts
const page = await client.orders.paginate({
	groupBy: ['customerId'],
	select: {
		customerId: true,
		_count: true,
		revenue: { sum: 'total' },
	},
	orderBy: [{ revenue: 'desc' }],
	limit: 10,
	start: 0,
});
```

```surql
SELECT customerId, count() AS _count, math::sum(total) AS revenue
FROM orders GROUP BY customerId ORDER BY revenue DESC LIMIT $p0 START $p1;

SELECT count() FROM (SELECT customerId FROM orders GROUP BY customerId) GROUP ALL;
```

- O `count()` de paginação com `groupBy` conta **grupos**, não linhas
  (subquery envolvendo o `GROUP BY`).

### `math::*` e expressões

```ts
await client.orders.aggregate({
	groupAll: true,
	select: {
		_count: true,
		revenue: surql`math::sum(total)`,
		margin: surql`math::sum(total - cost)`,
		conversion: surql`math::round(count(paid) / count() * 100, 2)`,
	},
});
```

```surql
SELECT count() AS _count,
       math::sum(total) AS revenue,
       math::sum(total - cost) AS margin,
       math::round(count(paid) / count() * 100, 2) AS conversion
FROM orders GROUP ALL;
```

## `SPLIT`

`SPLIT` desdobra arrays em linhas — útil para agregações por tag/categoria:

```ts
const porTag = await client.posts.aggregate({
	split: 'tags',
	select: { tags: true, _count: true },
	groupBy: ['tags'],
	orderBy: [{ _count: 'desc' }],
});
```

```surql
SELECT tags, count() AS _count FROM posts SPLIT tags GROUP BY tags ORDER BY _count DESC;
```

## `.explain()` de paginação

```ts
const plano = await client.posts.paginate({ where, limit: 20, start: 40 }).explain();
```

```ts
plano.statements;
// [ { key: 'data',  surql: 'SELECT ... LIMIT 20 START 40;', plan: {...} },
//   { key: 'total', surql: 'SELECT count() ... GROUP ALL;', plan: {...} } ]
```

## Dicas de performance

| Situação | Recomendação |
| --- | --- |
| Só avançar/voltar | `cursor()` (sem `COUNT`, sem offset profundo). |
| Precisa de `total` | `paginate({ count: true })`; o `count()` usa índice se houver. |
| Ordenação por campo não indexado | crie índice (no seu schema/tooling); `with: { index: 'idx' }` pode forçar. |
| Filtros + `GROUP BY` grandes | `parallel: true` no `aggregate`. |
| `SPLIT` em arrays enormes | considere tabela normalizada/aresta. |
| `TIMEOUT` de segurança | passe `timeout: '5s'` em endpoints críticos. |
