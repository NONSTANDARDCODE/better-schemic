# 08 — Relações e grafos

O SurrealDB tem **três formas nativas** de relacionar dados, e o better-surreal expõe as três:

| Estilo | Como é no schema | Como carregar | Como filtrar |
| --- | --- | --- | --- |
| **Record link** | campo `record<users>` | `include: { author: true }` → `FETCH` | `{ author: { is: {...} } }` |
| **Grafo (aresta)** | tabela `TYPE RELATION IN ... OUT ...` | `include: { likes: true }` → traversal `->` | `{ likes: { some: {...} } }` |
| **Relacional (semi-join)** | tabela de junção comum | subquery explícita via `$raw`, ou `include` com chave | `where` sobre o link |

O que o better-drizzle faz com joins + batch loader, aqui o SurrealDB faz com `FETCH` e traversal —
tudo **em um único `SELECT`**, sem N+1 por construção.

## Record links: `include` → `FETCH`

```ts
const posts = await client.posts.findMany({
	include: { author: true },          // author é record<users>
	limit: 20,
});
```

```surql
SELECT * FROM posts LIMIT $p0 FETCH author;
-- author vira o registro completo: { id: users:aeon, name: 'Aeon', ... }
```

Projeção dentro do link (sem `FETCH` completo):

```ts
const posts = await client.posts.findMany({
	include: { author: { select: { id: true, name: true } } },
});
```

```surql
SELECT *, author.id AS author_id, author.name AS author_name FROM posts;
// o better-surreal remonta `author: { id, name }` no client
```

`include` aninhado:

```ts
await client.comments.findMany({
	include: {
		author: { include: { profile: true } },   // link dentro de link
		post: { select: { id: true, title: true } },
	},
});
```

```surql
SELECT *, author.*, author.profile.*, post.id AS post_id, post.title AS post_title
FROM comments FETCH author.profile;
```

## Grafos: `include` → traversal

```ts
const users = await client.users.findMany({
	include: {
		likes: true,                       // aresta likes: users -> posts
	},
	limit: 10,
});
```

```surql
SELECT *, ->likes->posts AS likes FROM users LIMIT $p0;
-- likes: [ { id: posts:1, title: ... }, ... ]  (registros alvo)
```

Variações:

```ts
// registros da aresta (com os campos da própria aresta: score, createdAt...)
include: { likes: { edge: true } }
// -> ->likes AS likes

// filtrar, limitar e projetar a relação (subquery por pai)
include: {
	likes: {
		where: { score: { gte: 4 } },
		select: { id: true, title: true },
		orderBy: [{ createdAt: 'desc' }],
		limit: 3,
	},
}
```

```surql
SELECT *,
	(SELECT id, title FROM ->likes->posts WHERE score >= $p0 ORDER BY createdAt DESC LIMIT $p1) AS likes
FROM users;
```

- `include` aceita `where`, `select`, `orderBy`, `limit`, `start`, `include` (aninhado) e `edge`.
- Aresta + alvo em um só objeto:

```ts
include: {
	likes: {
		edge: { select: { score: true, createdAt: true } },
		target: { select: { id: true, title: true } },
	},
}
```

```surql
SELECT *,
	(SELECT id, in, out, score, createdAt, out.* FROM ->likes) AS likes
FROM users;
```

## `_count` — contagens de relação

```ts
const users = await client.users.findMany({
	include: {
		_count: {
			select: {
				posts: true,                                // authored
				likes: { where: { score: { gte: 4 } } },    // filtrado
			},
		},
	},
});
```

```surql
SELECT *,
	count(->posts) AS _count_posts,
	count(->likes[WHERE score >= $p0]) AS _count_likes
FROM users;
```

- O better-surreal remonta `_count: { posts: 12, likes: 3 }` no cliente.
- Contagens são **subqueries correlacionadas** no mesmo `SELECT` — sem round-trips extras.
- Para links (record), `_count` de um campo-array usa `count(array)`; de link único não faz sentido.

## Filtros de relação no `where`

```ts
await client.users.findMany({
	where: {
		posts: { some: { published: true } },                 // tem algum post publicado
		likes: { none: { score: { lt: 3 } } },                // nenhuma curtida ruim
		profile: { is: { verified: true } },                  // record link satisfaz
		followers: { every: { active: true } },               // todos os seguidores ativos
	},
});
```

```surql
WHERE count(->posts[WHERE published = $p0]) > 0
  AND count(->likes[WHERE score < $p1]) = 0
  AND profile.verified = $p2
  AND count(->followers[WHERE active != $p3]) = 0;
```

| Operador | Semântica | Compilação |
| --- | --- | --- |
| `some` | existe ≥ 1 relacionado que casa | `count(traversal[WHERE ...]) > 0` |
| `none` | nenhum relacionado casa | `count(traversal[WHERE ...]) = 0` |
| `every` | todos os relacionados casam | `count(traversal[WHERE NOT ...]) = 0` |
| `is` | link satisfaz o filtro | `campo.caminho = $p` / sub-filtro |
| `isNot` | link não satisfaz | negação |

Em tabelas de aresta, `some`/`every`/`none` também funcionam com o **link de destino**:
`{ likes: { some: { target: { published: true } } } }`.

## Traversal direto em `select` e `where`

Quando você quer o grafo como dado (não como include), use fragments ou os açúcares:

```ts
const users = await client.users.findMany({
	select: {
		id: true,
		likedPosts: surql`->likes->posts.title`,          // array de títulos
		likedCount: surql`count(->likes)`,
		everything: surql`<->?`,                          // qualquer aresta, ambos sentidos
	},
	where: surql`count(->likes) > ${2}`,
});
```

```surql
SELECT id,
       ->likes->posts.title AS likedPosts,
       count(->likes) AS likedCount,
       <->? AS everything
FROM users
WHERE count(->likes) > $p0;
```

### Operadores de grafo

| Sintaxe | Significado |
| --- | --- |
| `->edge->table` | segue a aresta no sentido `in → out` |
| `<-edge<-table` | segue a aresta no sentido `out → in` |
| `<->edge<->table` | ambos os sentidos |
| `->?` / `<-?` | **qualquer** aresta (wildcard) |
| `->?->?` | dois saltos por qualquer aresta |
| `->edge->(users\|posts)` | alvo polimórfico |
| `->edge->table.field` | campo do registro alvo |
| `->edge->table.*` | todos os campos do alvo |

### Nós (vertices) e arestas no `include` polimórfico

```ts
include: {
	relations: {
		wildcard: true,                    // ->?
		target: { select: { id: true, name: true } },
		edge: { select: { id: true, in: true, out: true } },
	},
}
```

```surql
SELECT *, (SELECT id, in, out, out.* FROM ->?) AS relations FROM users;
```

## Recursão: `@.{n}` e `@.{n+m}`

```ts
await client.people.findMany({
	where: { id: 'person:aeon' },
	select: {
		name: true,
		children: surql`@.{1}->parent_of->person`,
		grandchildren: surql`@.{2}->parent_of->person`,
		descendants: surql`@.{1,10}->parent_of->person`,
		fullTree: surql`@.{1+collect}->parent_of->person`,
	},
});
```

```surql
SELECT name,
       @.{1}->parent_of->person AS children,
       @.{2}->parent_of->person AS grandchildren,
       @.{1,10}->parent_of->person AS descendants,
       @.{1+collect}->parent_of->person AS fullTree
FROM person WHERE id = person:aeon;
```

- `@.{n}` = profundidade fixa; `@.{n,m}` = faixa; `@.{n+collect}` = até o fim, achatado.
- Alternativa em path: `@.{2+collect}.connected_to` (usado no tutorial de grafos).

## `relate` e `unrelate`

Criar arestas:

```ts
const like = await client.users.relate(
	'users:aeon',       // in
	'likes',            // tabela de aresta
	'posts:1',          // out
	{ data: { score: 5, createdAt: new Date() } },
);
```

```surql
RELATE users:aeon->likes->posts:1 SET score = $p0, createdAt = $p1;
-- retorna: [ { id: likes:⟨...⟩, in: users:aeon, out: posts:1, score: 5, ... } ]
```

Arestas com id nomeado:

```ts
await client.users.relate('users:aeon', 'parent_of:first_relation', 'users:landevin');
```

```surql
RELATE users:aeon->parent_of:first_relation->users:landevin;
```

Em lote (um statement, transação implícita):

```ts
await client.users.relateMany([
	{ from: 'users:aeon', edge: 'likes', to: 'posts:1', data: { score: 5 } },
	{ from: 'users:jane', edge: 'likes', to: 'posts:1', data: { score: 3 } },
]);
```

```surql
BEGIN TRANSACTION;
RELATE users:aeon->likes->posts:1 SET score = $p0;
RELATE users:jane->likes->posts:1 SET score = $p1;
COMMIT TRANSACTION;
```

Remover arestas:

```ts
await client.users.unrelate('users:aeon', 'likes', 'posts:1');
// DELETE likes WHERE in = users:aeon AND out = posts:1;

await client.users.unrelateMany({ where: { score: { lt: 3 } } });
// DELETE likes WHERE score < $p0;  (arestas por filtro)
```

### Delegate da aresta

Tabelas de aresta também são delegates normais:

```ts
await client.likes.create({
	data: { in: 'users:aeon', out: 'posts:1', score: 5 },
});

await client.likes.findMany({
	where: { out: 'posts:1', score: { gte: 4 } },
	include: { in: true },              // FETCH do usuário
});
```

```surql
CREATE likes CONTENT $p0;
SELECT * FROM likes WHERE out = $p0 AND score >= $p1 FETCH in;
```

## `include` vs `FETCH` vs semi-join — quando usar

| Você quer... | Use |
| --- | --- |
| Trazer o registro linkado completo | `include: { author: true }` (`FETCH`) |
| Trazer um subconjunto do link | `include: { author: { select: {...} } }` |
| Trazer alvos de grafo | `include: { likes: true }` (`->`) |
| Trazer os **dados da aresta** | `include: { likes: { edge: true } }` |
| Contar relações | `include: { _count: { select: {...} } }` |
| Filtrar por relação | `where: { likes: { some: {...} } }` |
| Relatório de grafo complexo | `select`/`$raw` com traversal e `@.{...}` |

## Links com `REFERENCE ON DELETE`

Se o seu schema define `REFERENCE ON DELETE CASCADE | REJECT | IGNORE`, o servidor cuida da
integridade ao deletar. O better-surreal documenta no `info('table')` a política de cada campo, e o
plugin `rules` pode avisar quando um `delete` vai disparar cascade (`meta.warnCascade: true`).
