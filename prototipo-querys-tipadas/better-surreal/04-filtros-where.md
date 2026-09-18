# 04 — Filtros: o objeto `where`

O `where` é um objeto tipado que compila para a cláusula `WHERE` do SurrealQL, sempre parametrizado.
Ele cobre **todos os operadores relacionais do SurrealDB** — inclusive os exclusivos: `?=`, `*=`, `~`,
`CONTAINS*`, `INSIDE`, `INTERSECTS`, matches de full-text `@@`/`@n@` e KNN `<|k|>`.

```ts
where: {
	active: true,                                  // equals (shorthand)
	age: { gte: 18, lt: 65 },                      // operadores
	'address.country': 'BR',                       // caminho aninhado
	tags: { containsAny: ['db', 'graph'] },        // array
	OR: [
		{ email: { endsWith: '@surreal.db' } },
		{ role: { in: ['admin', 'owner'] } },
	],
}
```

```surql
WHERE active = $p0
  AND age >= $p1 AND age < $p2
  AND address.country = $p3
  AND tags CONTAINSANY $p4
  AND (string::ends_with(email, $p5) OR role IN $p6);
```

> No SurrealQL não existe `ENDSWITH` como operador: `startsWith`/`endsWith` compilam para
> `string::starts_with(campo, $p)` / `string::ends_with(campo, $p)`.

## Regras básicas

- **Múltiplas chaves = AND** (nunca OR implícito).
- **Valor puro = `equals`**: `{ active: true }` → `active = $p0`.
- **`null` é valor especial**: `{ deletedAt: null }` → `deletedAt = NULL`; `{ deletedAt: { isNone: true } }`
  → `deletedAt = NONE` (`NONE` e `NULL` são coisas diferentes no SurrealDB).
- **Operadores no mesmo campo também são AND**: `{ age: { gte: 18, lt: 65 } }`.
- **Tudo é parametrizado**: nenhum valor vira string no SQL.

## Operadores por tipo

### Universais

| API | SurrealQL | Exemplo |
| --- | --- | --- |
| `equals` / valor puro | `=` | `{ status: 'active' }` |
| `notEquals` | `!=` | `{ status: { notEquals: 'banned' } }` |
| `exact` | `==` (sem coerção de tipo) | `{ age: { exact: 30 } }` |
| `in` | `IN` | `{ role: { in: ['admin', 'owner'] } }` |
| `notIn` | `NOT IN` | `{ role: { notIn: ['guest'] } }` |
| `isNone` | `= NONE` | `{ deletedAt: { isNone: true } }` |
| `isNotNone` | `!= NONE` | `{ verifiedAt: { isNotNone: true } }` |
| `isNull` | `= NULL` | `{ note: { isNull: true } }` |
| `isNotNull` | `!= NULL` | `{ note: { isNotNull: true } }` |
| `not` (negação) | `!=` / `NOT (...)` | `{ email: { not: { contains: '@spam.' } } }` |

### Strings

| API | SurrealQL |
| --- | --- |
| `contains` | `CONTAINS` (substring) |
| `startsWith` | `string::starts_with(campo, $p)` |
| `endsWith` | `string::ends_with(campo, $p)` |
| `fuzzy` | `~` (match fuzzy, case-insensitive) |
| `anyFuzzy` / `allFuzzy` | `?~` / `*~` |
| `matches` | `string::matches(campo, /regex/)` (regex literal) |
| `eqInsensitive` | `string::lowercase(campo) = string::lowercase($p)` |
| `containsInsensitive` | `string::lowercase(campo) CONTAINS string::lowercase($p)` |
| `matchesFullText` | `@@` ou `@n@` (ver seção de full-text) |

```ts
where: {
	name: { contains: 'aeon' },
	email: { endsWith: '@surreal.db' },
	bio: { fuzzy: 'surrealista' },
	slug: { matches: /^post-[a-z0-9-]+$/ },
}
```

```surql
WHERE name CONTAINS $p0
  AND string::ends_with(email, $p1)
  AND bio ~ $p2
  AND string::matches(slug, /^post-[a-z0-9-]+$/);
```

### Números, datas, durações

| API | SurrealQL |
| --- | --- |
| `lt` / `lte` / `gt` / `gte` | `<` / `<=` / `>` / `>=` |
| `between: [a, b]` | `campo >= $a AND campo <= $b` |
| `outside: [a, b]` | `campo < $a OR campo > $b` |
| `in` com range | `campo IN 10..20` (range literal) |
| `any: { lt: v }` / `all: { lt: v }` | `?<` / `*<` (família any/all comparação) |

```ts
where: {
	age: { between: [18, 29] },
	score: { any: { gt: 90 } },          // score ?>= ... ver tabela
	createdAt: { gte: new Date('2025-01-01') },
	ttl: { in: '1h..24h' },              // range de duração
}
```

```surql
WHERE age >= $p0 AND age <= $p1
  AND score ?> $p2
  AND createdAt >= $p3
  AND ttl IN 1h..24h;
```

### Booleanos

`equals` / `notEquals` / `not` apenas. Truthiness do SurrealQL vale para fragments crus.

### Arrays e sets

| API | SurrealQL |
| --- | --- |
| `contains` | `CONTAINS` |
| `containsNot` | `CONTAINSNOT` |
| `containsAll` | `CONTAINSALL` |
| `containsAny` | `CONTAINSANY` |
| `containsNone` | `CONTAINSNONE` |
| `inside` | `INSIDE` |
| `notInside` | `NOTINSIDE` / `NOT INSIDE` |
| `allInside` | `ALLINSIDE` |
| `anyInside` | `ANYINSIDE` |
| `noneInside` | `NONEINSIDE` |
| `outside` | `OUTSIDE` |
| `intersects` | `INTERSECTS` |
| `anyEquals` / `allEquals` | `?=` / `*=` |
| `length` | `array::len(campo) = $p` |

```ts
where: {
	tags: { containsAll: ['surreal', 'db'] },
	genres: { anyInside: ['Sci-Fi', 'Drama'] },
	matrix: { length: 3 },
}
```

```surql
WHERE tags CONTAINSALL $p0
  AND genres ANYINSIDE $p1
  AND array::len(matrix) = $p2;
```

### Geometria

| API | SurrealQL |
| --- | --- |
| `intersects` | `campo INTERSECTS $p` |
| `inside` | `campo INSIDE $p` |
| `near` (não-vetorial) | `geo::distance(campo, $p) <= $raio` |

```ts
where: {
	location: {
		intersects: {
			type: 'Polygon',
			coordinates: [[[50, 50], [51, 50], [51, 51], [50, 51], [50, 50]]],
		},
	},
}
```

```surql
WHERE location INTERSECTS $p0;
```

### Records (links de registro)

```ts
where: {
	author: 'users:aeon',                  // equals com record id
	likedBy: { contains: 'users:jane' },   // array de records
	mentions: { containsAny: ['users:a', 'users:b'] },
}
```

```surql
WHERE author = $p0 AND likedBy CONTAINS $p1 AND mentions CONTAINSANY $p2;
```

### Record ranges

```ts
where: {
	id: { inRange: ['users:1', 'users:100'] },   // id >= 'users:1' AND id <= 'users:100'
}
```

```surql
WHERE id >= $p0 AND id <= $p1;
```

> Para ranges de **alvo** (mais eficiente), use o arg `range` do `findMany`
> (`FROM users:1..users:100`), documentado em [03](./03-leitura-select.md).

## Operadores lógicos

```ts
where: {
	AND: [
		{ active: true },
		{ OR: [{ role: 'admin' }, { role: 'owner' }] },
		{ NOT: { email: { endsWith: '@blocked.com' } } },
	],
}
```

```surql
WHERE (active = $p0 AND (role = $p1 OR role = $p2) AND NOT (string::ends_with(email, $p3)));
```

- `NOT` aceita um objeto de filtro inteiro e nega o grupo compilado.
- `AND`/`OR` aninham em qualquer profundidade; a compilação adiciona parênteses corretos.
- Chaves `AND`/`OR`/`NOT` podem conviver com campos no mesmo nível (vira AND implícito).

## Caminhos aninhados e arrays de objetos

```ts
where: {
	'address.city': 'São Paulo',
	'contacts[*].type': 'email',       // array de objetos: qualquer item
	'contacts[0].value': { contains: '@' },
}
```

```surql
WHERE address.city = $p0
  AND contacts[*].type = $p1
  AND contacts[0].value CONTAINS $p2;
```

## Full-text search (`@@` e `@n@`)

Requer analyzer + índice (definidos no seu schema/pela sua tooling de schema).

```ts
const results = await client.books.findMany({
	where: {
		matchesFullText: { query: 'hound night', indexes: [0, 1], operator: 'AND' },
	},
	select: {
		title: true,
		titleScore: surql`search::score(0)`,
		bodyScore: surql`search::score(1)`,
		highlights: surql`search::highlight('<b>', '</b>', text)`,
	},
	orderBy: [surql`search::score(0) DESC`],
});
```

```surql
SELECT title,
       search::score(0) AS titleScore,
       search::score(1) AS bodyScore,
       search::highlight('<b>', '</b>', text) AS highlights
FROM books
WHERE title @0@ 'hound' OR text @1@ 'night'
ORDER BY search::score(0) DESC;
```

Formas suportadas:

| API | SurrealQL |
| --- | --- |
| `matchesFullText: 'termo'` | `campo @@ 'termo'` |
| `matchesFullText: { query, index: 0 }` | `campo @0@ 'termo'` |
| `matchesFullText: { query, indexes: [0, 1], operator: 'AND' }` | `campo @0@ 'termo' AND campo @1@ 'termo'` |

## Busca vetorial (KNN `<|k|>`)

```ts
const similar = await client.books.findMany({
	where: {
		embedding: { near: { vector: [0.1, 0.5, 0.9], k: 3, distance: 'cosine' } },
	},
	select: {
		title: true,
		similarity: surql`vector::similarity::cosine(embedding, ${[0.1, 0.5, 0.9]})`,
	},
	orderBy: [{ similarity: 'desc' }],
});
```

```surql
SELECT title, vector::similarity::cosine(embedding, $p0) AS similarity
FROM books
WHERE embedding <|3,COSINE|> $p0
ORDER BY similarity DESC;
```

- `distance`: `'euclidean' | 'cosine' | 'manhattan' | 'chebyshev' | 'hamming' | 'minkowski' | ...`
  (default: euclidean, compilando `<|k|>`).
- Sem índice HNSW/MTree no campo, o servidor pode recusar/ignorar a otimização — o better-surreal
  emite aviso em `strict` e erro se `requireIndex: true`.

## Fragments crus dentro do `where`

Qualquer valor pode ser um fragmento `surql` — mistura livre de API tipada com SurrealQL. Quando o
fragmento é o valor de um campo, ele é concatenado com `campo <fragmento>`; quando é o `where` inteiro,
substitui a cláusula compilada:

```ts
where: surql`
	age > ${18} AND age < ${65}
	AND (role = 'admin' OR role = 'owner')
	AND time::now() - createdAt < 7d
`;
```

```surql
WHERE age > $p0 AND age < $p1 AND (role = $p2 OR role = $p3)
  AND time::now() - createdAt < 7d;
```

- `where` também aceita `and(...)`/`or(...)` do próprio SDK quando você quer compor fora.
- O `where` cru passa pela **mesma validação** de parâmetros e pelos hooks/plugins.

## Tabela-resumo

| Categoria | Operadores |
| --- | --- |
| Igualdade | `equals`, `notEquals`, `exact`, `isNull`, `isNotNull`, `isNone`, `isNotNone` |
| Comparação | `lt`, `lte`, `gt`, `gte`, `between`, `outside`, `any`, `all` |
| Conjuntos | `in`, `notIn`, `inRange` |
| Strings | `contains`, `startsWith`, `endsWith`, `fuzzy`, `anyFuzzy`, `allFuzzy`, `matches`, `eqInsensitive`, `containsInsensitive` |
| Arrays | `contains`, `containsNot`, `containsAll`, `containsAny`, `containsNone`, `inside`, `notInside`, `allInside`, `anyInside`, `noneInside`, `outside`, `intersects`, `anyEquals`, `allEquals`, `length` |
| Geo | `intersects`, `inside`, `near` |
| Busca | `matchesFullText`, `near` (vetorial) |
| Lógicos | `AND`, `OR`, `NOT`, campo-por-campo como AND |
| Cru | fragmento `surql` |
