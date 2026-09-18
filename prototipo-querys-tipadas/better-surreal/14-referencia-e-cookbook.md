# 14 — Referência rápida e cookbook

## Cheat-sheet — client

```ts
const client = betterSurreal(db, { schema, plugins?, hooks?, raw?, transaction?, live?, strict? });

client.<table>                          // delegate: users, posts, likes (arestas também)
client.repository('users')              // delegate dinâmico
client.tables                           // string[] do schema
client.extends(fn | obj)                // helpers do projeto
client.transaction(fn, opts?)           // transação (10)
client.live(table, args, cb)            // live dinâmica (11)
client.changes({ table?, since, limit })// SHOW CHANGES (11)
client.fn.call('fn::name', args)        // funções do banco (12)
client.api.get|post|put|patch|delete()  // DEFINE API (12)
client.auth.signin|signup|authenticate|invalidate|record
client.$withContext({ namespace?, database?, auth?, meta? })
client.$raw | $query | $unsafe          // SurrealQL (12)
client.info(level, table?)              // INFO FOR ... (02)
client.version() | ping()               // versão / health (02)
client.export() | import(dump)          // dump/restore (12)
client.afterCommit(cb) | afterRollback(cb)
client.$sdk                             // o Surreal original
```

## Cheat-sheet — delegate

```ts
// LEITURA
findMany(args?)                         // SELECT (03)
findFirst(args?) / findOne(args?)       // SELECT ... LIMIT 1 (03)
findUnique(args)                        // SELECT ... FROM ONLY (03)
count(args?) / exists(args?)            // GROUP ALL / VALUE id LIMIT 1 (03)
aggregate(args)                         // GROUP BY / GROUP ALL (03, 09)
paginate(args) / cursor(args)           // { data, pagination } (09)

// CRIAÇÃO
create({ data, only?, return? })        // CREATE (05)
createMany({ data, skipDuplicates?, return? })
insert({ data, onDuplicate?, return? }) // INSERT [IGNORE|ON DUPLICATE] (05)
insertMany({ data, onDuplicate?, return? })

// ATUALIZAÇÃO
update({ where, data, mode?, unset?, return? })        // (06)
updateMany({ where?, data, mode?, return? })
updateEach({ by, data, mode?, onEmpty?, return? })     // FOR + UPDATE (07)
patch({ where, patches })                              // JSON Patch (06)
upsert({ where, data | (create + update), mode? })     // UPSERT / ON DUPLICATE (06)
upsertMany({ data, update?, conflict?, return? })      // (06)

// REMOÇÃO
delete({ where, return? })              // DELETE (07)
deleteMany({ where?, all?, return? })   // (07)

// GRAFOS
relate(from, edge, to, { data? })       // RELATE (08)
relateMany([{ from, edge, to, data }])
unrelate(from, edge, to) / unrelateMany({ where })
client.likes.*                          // arestas são delegates normais (08)

// LIVE
live(args, cb)                          // LIVE SELECT (11)
```

## Cheat-sheet — args de leitura

| Arg | SurrealQL | Arquivo |
| --- | --- | --- |
| `where` | `WHERE` | 04 |
| `select` | projeções (`SELECT`) | 03 |
| `include` | `FETCH` + traversal + `_count` | 08 |
| `omit` | `OMIT` | 03 |
| `orderBy` | `ORDER BY` | 03 |
| `limit`/`take`, `start`/`skip` | `LIMIT`, `START` | 03 |
| `range` | `FROM users:1..users:100` | 03 |
| `split` | `SPLIT` | 03 |
| `groupBy` / `groupAll` | `GROUP BY` / `GROUP ALL` | 03 |
| `only` | `FROM ONLY` | 03 |
| `value` | `SELECT VALUE` | 03 |
| `with` | `WITH [NO]INDEX` | 03 |
| `timeout` / `parallel` / `version` | `TIMEOUT`, `PARALLEL`, `VERSION` | 03 |
| `explain: true` / `.explain()` | `EXPLAIN` | 03 |
| `meta` | metadata para hooks/plugins | 13 |

## Cheat-sheet — operadores (`where`)

`equals`, `notEquals`, `exact`, `in`, `notIn`, `inRange`, `lt/lte/gt/gte`, `between`, `outside`,
`any`, `all`, `isNone`, `isNotNone`, `isNull`, `isNotNull`, `not`, `contains`, `startsWith`,
`endsWith`, `fuzzy`, `anyFuzzy`, `allFuzzy`, `matches`, `eqInsensitive`, `containsInsensitive`,
`containsNot`, `containsAll`, `containsAny`, `containsNone`, `inside`, `notInside`, `allInside`,
`anyInside`, `noneInside`, `outside`, `intersects`, `anyEquals`, `allEquals`, `length`,
`matchesFullText`, `near`, `AND`, `OR`, `NOT` — detalhes em [04](./04-filtros-where.md).

---

# Cookbook — dos tutoriais para a API

Receitas baseadas nos exemplos vistos na Tour, no Fundamentals e no livro *Surreal Renaissance*.

## 1. Aeon movie database (grafos + FETCH + recursão)

```ts
// criar pessoas e filmes
const criados = await client.person.createMany({ data: [
	{ name: 'Aeon', born: new Date('1950-01-01') },
	{ name: 'Landevin' },
]});
const person = criados.data![0].id;

// RELATE person->acted_in->movie com dados na aresta
await client.person.relate(person, 'acted_in', movieId, {
	data: { role: 'Protagonista', year: 1999 },
});

// consultar: filme + elenco + nota, tudo em 1 SELECT
const filme = await client.movie.findUnique({
	where: { id: movieId },
	include: {
		cast: {
			edge: { select: { role: true, year: true } },
			target: { select: { id: true, name: true } },
			orderBy: [{ year: 'asc' }],
		},
		_count: { select: { reviews: true } },
	},
});

// filmografia de uma pessoa (traversal + filtro por score)
const filmes = await client.person.findMany({
	where: { id: person },
	select: {
		name: true,
		films: surql`->acted_in->movie.title`,
		top: surql`->acted_in[WHERE score > 8]->movie.title`,
	},
});
```

```surql
RELATE person:aeon->acted_in->movie:1 SET role = $p0, year = $p1;

SELECT *,
	(SELECT role, year, out.id AS id, out.name AS name FROM ->acted_in ORDER BY year ASC) AS cast,
	count(->reviews) AS _count_reviews
FROM ONLY movie:1;

SELECT name,
       ->acted_in->movie.title AS films,
       ->acted_in[WHERE score > 8]->movie.title AS top
FROM person:aeon;
```

## 2. Banco — transação + UPSERT + incremento

```ts
await client.transaction(async (tx) => {
	const from = await tx.account.update({
		where: { id: 'account:aeon' },
		mode: 'set',
		data: { balance: surql`balance - ${amount}` },
		return: 'after',
	}).throw();

	await tx.transfer.create({
		data: {
			from: from.id,
			to: 'account:landevin',
			amount,
			at: surql`time::now()`,
		},
	});

	await tx.account.upsert({
		where: { id: 'account:landevin' },
		create: { id: 'account:landevin', balance: amount, logins: 0 },
		update: { balance: surql`balance + ${amount}`, logins: surql`logins + 1` },
	});
});
```

```surql
BEGIN TRANSACTION;
UPDATE account SET balance = balance - $p0 WHERE id = $p1 RETURN AFTER;
CREATE transfer CONTENT $p2;
INSERT INTO account [$create] ON DUPLICATE KEY UPDATE balance = balance + $p3, logins = logins + 1;
COMMIT TRANSACTION;
```

## 3. Geo — proximidade com `geo::distance`

```ts
const perto = await client.place.findMany({
	where: surql`geo::distance(location, ${centro}) < ${5000}`,
	select: {
		name: true,
		distance: surql`geo::distance(location, ${centro})`,
	},
	orderBy: [{ distance: 'asc' }],
	limit: 10,
});

const naArea = await client.place.findMany({
	where: { location: { intersects: poligonoGeojson } },
});
```

```surql
SELECT name, geo::distance(location, $p0) AS distance
FROM place
WHERE geo::distance(location, $p0) < $p1
ORDER BY distance ASC LIMIT $p2;

SELECT * FROM place WHERE location INTERSECTS $p3;
```

## 4. Full-text — BM25 + highlights

```ts
const hits = await client.book.findMany({
	where: { matchesFullText: { query: 'hound night', indexes: [0, 1], operator: 'AND' } },
	select: {
		title: true,
		score: surql`search::score(0)`,
		snippet: surql`search::highlight('<b>', '</b>', text)`,
	},
	orderBy: [surql`search::score(0) DESC`],
	limit: 5,
});
```

```surql
SELECT title, search::score(0) AS score,
       search::highlight('<b>', '</b>', text) AS snippet
FROM book
WHERE title @0@ 'hound' AND text @1@ 'night'
ORDER BY search::score(0) DESC LIMIT $p0;
```

## 5. Vetorial — KNN + similaridade

```ts
const recomendados = await client.book.findMany({
	where: { embeddings: { near: { vector: queryVec, k: 3, distance: 'cosine' } } },
	select: { title: true, similarity: surql`vector::similarity::cosine(embeddings, ${queryVec})` },
	orderBy: [{ similarity: 'desc' }],
});
```

```surql
SELECT title, vector::similarity::cosine(embeddings, $p0) AS similarity
FROM book
WHERE embeddings <|3,COSINE|> $p0
ORDER BY similarity DESC;
```

## 6. Recursão — árvore genealógica / organograma

```ts
const arvore = await client.person.findUnique({
	where: { id: 'person:aeon' },
	select: {
		name: true,
		children: surql`@.{1}->parent_of->person.{ id, name }`,
		grandchildren: surql`@.{2}->parent_of->person.{ id, name }`,
		allDescendants: surql`@.{1+collect}->parent_of->person.id`,
	},
});
```

```surql
SELECT name,
       @.{1}->parent_of->person.{ id, name } AS children,
       @.{2}->parent_of->person.{ id, name } AS grandchildren,
       @.{1+collect}->parent_of->person.id AS allDescendants
FROM ONLY person:aeon;
```

## 7. `DEFINE API` — endpoint de artigos

```ts
const artigos = await client.api.get<Article[]>('/articles', {
	query: { limit: '10' },
});
```

```surql
DEFINE API "/articles" FOR get THEN {
	RETURN SELECT * FROM article ORDER BY publishedAt DESC LIMIT $request.query.limit;
};
```

## 8. Multi-tenant com record access

```ts
const tenant = client.$withContext({
	namespace: 'tenant_acme',
	database: 'app',
	auth: token,                 // token da sessão do usuário
	meta: { tenantId: 'acme' },
});

const me = await tenant.auth.record();      // registro autenticado (record access)

const meus = await tenant.invoice.findMany({
	where: { owner: me.id },                  // permissões aplicadas pelo servidor
});
```

```surql
USE NS tenant_acme DB app;
SELECT * FROM invoice WHERE owner = $auth;
-- com DEFINE TABLE invoice PERMISSIONS FOR select WHERE owner = $auth
```

## 9. Changefeed — auditoria e reconciliação

```ts
const mudancas = await client.changes({ table: 'person', since: 0, limit: 50 });

for (const lote of mudancas) {
	for (const c of lote.changes) {
		await client.audit.create({
			data: { record: c.recordId, action: c.action, versionstamp: lote.versionstamp },
		});
	}
}
```

```surql
SHOW CHANGES FOR TABLE person SINCE 0 LIMIT 50;
CREATE audit CONTENT { record: $p0, action: $p1, versionstamp: $p2 };
```

## 10. CRUD schemaless → schemafull (asserts)

```ts
await client.users.create({
	data: {
		email: 'aeon@surreal.db',       // ASSERT string::is_email($value) no schema
		age: 30,                        // ASSERT $value > 0 AND $value < 150
		createdAt: surql`time::now()`,
	},
});
```

```surql
CREATE users CONTENT $p0;
-- se $p0.age = -1 → AssertionFailed (BetterSurrealError)
```

---

## Cobertura dos tutoriais

| Recurso dos tutoriais | Onde está na API |
| --- | --- |
| `CREATE`/`ONLY`/ids não-ASCII/field order | 05 |
| `INSERT` + JSON, `INSERT IGNORE`, `ON DUPLICATE` | 05 |
| `UPDATE` (`SET/MERGE/CONTENT/PATCH/UNSET`), `RETURN DIFF` | 06 |
| `UPSERT` nativo | 06 |
| `DELETE`, `RETURN BEFORE` | 07 |
| `FOR` loops | 07 (`updateEach`), 12 (`$query`) |
| Grafos: `RELATE`, `->`, `<-`, `<->`, `->?` | 08 |
| Record links + `FETCH` | 08 |
| Semi-joins/relacional | 08 |
| Recursão `@.{n}`, `@.{n+collect}` | 08 |
| `SELECT`: `*`, `OMIT`, aliases, casts, `VALUE`, `ONLY` | 03 |
| Cláusulas: `SPLIT`, `GROUP BY/ALL`, `ORDER`, `LIMIT/START`, `TIMEOUT`, `PARALLEL`, `VERSION`, `WITH INDEX` | 03, 09 |
| Full-text (`DEFINE ANALYZER`, BM25, `@@`/`@n@`, `search::`) | 04, 14 |
| Vetorial (`HNSW`, `<|k|>`, `vector::similarity`) | 04, 14 |
| Geo (`geometry`, `geo::distance`, `INTERSECTS`) | 04, 14 |
| Transações (`BEGIN/COMMIT/CANCEL`, parse issues) | 10 |
| Live queries (`LIVE SELECT`, `DIFF`) | 11 |
| Changefeeds (`CHANGEFEED`, `SHOW CHANGES`) | 11 |
| Auth (system users, `DEFINE ACCESS`, record access) | 02, 13 |
| Permissões/capabilities | 02, 13 |
| `DEFINE FUNCTION` → `fn::` | 12 |
| `DEFINE API` | 12, 14 |
| `IF/ELSE`, `LET`, `RETURN` | 06, 12 |
| `ASSERT`/literal types/`DEFAULT`/`VALUE` | 05, 13 |
| Índices (unique, search, MTree, HNSW) | 03 (`with`), 04, 14 |
