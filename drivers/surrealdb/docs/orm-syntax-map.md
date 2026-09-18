# SurrealDB ORM syntax map — empirical (server 3.2.0)

Every row below was **live-probed** against SurrealDB **3.2.0** (local `surreal` binary, ephemeral
in-memory server), never inferred. This is the ground truth the `/orm` compiler must emit: where the
prototype (`prototipo-querys-tipadas/better-surreal/*`) disagrees, the server wins.

- Executable half: `test/live/orm-syntax.test.ts` (51 probes, skips without the `surreal` binary).
  A server upgrade that changes any behaviour here fails that suite first.
- Related: [`graph-syntax-map.md`](./graph-syntax-map.md) (graph traversal detail, probed on 3.1.4).
- How to re-run: `cd drivers/surrealdb && bun test test/live/orm-syntax.test.ts`.

> ⚠️ **Design-critical divergences from the prototype** are flagged `DIVERGE`. The plan's M0
> milestones and the `/orm` surface must follow this map, not the prototype docs.

---

## 1. DIVERGE — divergences from the prototype (decision-changing)

| Prototype says | Reality on 3.2.0 | ORM decision |
| --- | --- | --- |
| `UPDATE t:id` **cria** o registro se não existir (por isso updates por `WHERE`) | `UPDATE t:id {MERGE,SET,CONTENT,REPLACE}` num id inexistente devolve `[]` e **não cria** | `update` compila alvo direto (`UPDATE t:id …`); `upsert` é o único create-or-update. O workaround `UPDATE … WHERE id = …` é desnecessário |
| `parallel: true` → `PARALLEL` | **parse error** (`Unexpected token PARALLEL`) | remover `parallel` da superfície (ou erro `UnsupportedCapability`) |
| `fuzzy: 'x'` → `~`; `anyFuzzy`/`allFuzzy` → `?~`/`*~` | **parse error** para `~`, `?~`, `*~` | não emitir; fuzzy via `string::similarity::jaro/smithwaterman`, regex via `string::matches` |
| `DEFINE INDEX … SEARCH ANALYZER a BM25 HIGHLIGHTS` | 3.x é `FULLTEXT ANALYZER a BM25 HIGHLIGHTS`; `SEARCH ANALYZER` é parse error | emitir `FULLTEXT`; conferir `defineIndex` no DDL |
| `search::highlight('<b>', '</b>', field)` | aridade é `search::highlight(prefix, suffix, indexRef, field)` | emitir com o `indexRef` |
| Range `FROM users:1..users:100` | **parse error**; a forma válida é `FROM t:1..100` (fim exclusivo) e `FROM t:1..=100` (inclusivo) | `range: { start, end, inclusive? }` → `t:<start>..<end>` / `..=<end>` |
| `where: { 'contacts[*].type': 'email' }` compara igualdade | `contacts[*].type` devolve **array**; `= 'email'` é `false` | igualdade em path-array → `CONTAINS`; scalar membership → `INSIDE` |
| `aggregate({ split, groupBy })` | **`SPLIT` e `GROUP` são mutuamente exclusivos** | `aggregate` rejeita a combinação (`ClauseNotSupported`) |
| `logins = logins + 1` no `ON DUPLICATE KEY UPDATE` | campos nus, `$before`/`$after` são `NONE`; só `$input.*` funciona | incremento contra o estado anterior = subquery correlacionada por id (`(SELECT VALUE f FROM ONLY t:id) + 1`) |
| `LIVE SELECT * FROM users WHERE … DIFF` | `DIFF` vai **logo após `SELECT`** e não aceita projeção: `LIVE SELECT DIFF FROM t …` | lowering próprio; `diff: true` + `select` → `ClauseNotSupportedInLive` |
| `KILL "uuid"` (string) | parse error; aceita `KILL $param` / `KILL u"…"` | `kill()` liga o uuid como parâmetro |
| `.explain()` em writes | `EXPLAIN` só existe para `SELECT` ("only supported with the new execution model") | `.explain()` só em reads |
| `VERSION d'…'` sempre disponível | exige backend versionado; memory server: "does not support versioned queries" | emitir; erro estruturado quando o backend não suporta |
| `FETCH` posicionado livremente | FETCH é a **última** cláusula (depois de WHERE/ORDER/LIMIT) | lowering na ordem correta |
| `[NONE]` e `NULL` idênticos | continuam distintos (`isNone` ≠ `isNull`) | manter ambos |

---

## 2. Statement shapes (writes)

### 2.1 `CREATE`

| Form | Result | Notes |
| --- | --- | --- |
| `CREATE t CONTENT $p` | `[ {…id gerado…} ]` | id aleatório |
| `CREATE ONLY t CONTENT $p` | **objeto** (não array) | usado por `create({ only: true })` |
| `CREATE t:id CONTENT $p` | `[ {…} ]` | id explícito |
| `CREATE t:id` duplicado | **erro** `Database record \`t:id\` already exists` (`AlreadyExists`) | normalizar → `RecordAlreadyExists` |
| `LET $c = (CREATE ONLY t CONTENT $p); RETURN $c;` | objeto criado | açúcar `create + relate` (`to: '$self'`) |
| `CREATE t CONTENT $p RETURN NONE` | `[]` | payload mínimo |

### 2.2 `INSERT`

| Form | Result | Notes |
| --- | --- | --- |
| `INSERT INTO t $rows` (array) | array de linhas (ids do payload preservados) | 1 statement |
| `INSERT INTO t $rows` id duplicado | **erro** `already exists` | |
| `INSERT IGNORE INTO t $rows` | devolve **só as linhas inseridas** | `count` = inseridos |
| `INSERT … ON DUPLICATE KEY UPDATE f = $input.f` | linhas afetadas | `$input` = registro do INSERT (paths aninhados ok) |
| `INSERT … ON DUPLICATE KEY UPDATE f = (SELECT VALUE f FROM ONLY t:id) + 1` | incremento contra o estado anterior | únicos campos acessíveis antes: a subquery |
| `INSERT … ON DUPLICATE … RETURN AFTER/NONE` | ok | ver `RETURN` abaixo |
| `INSERT … ON DUPLICATE … RETURN BEFORE` | devolve o estado **novo** (não o anterior) | não expor `before` para insert-on-duplicate |
| `INSERT … ON DUPLICATE … RETURN DIFF` | `[{ op: "change", path, value: "@@ … @@" }]` | formato **paged diff**, ≠ do UPDATE |
| `INSERT RELATION INTO edge {…}` | linhas da aresta | caminho nativo para `relateMany`/seed |

### 2.3 `UPSERT`

| Form | Result | Notes |
| --- | --- | --- |
| `UPSERT t:id MERGE $p` | `[ {…} ]`; cria se faltar | `upsert` por id |
| `UPSERT t MERGE $p WHERE cond` | linhas afetadas; **cria quando nada casa** | `upsert` por campo único (validar unicidade no schema) |
| `UPSERT t:id SET $p` | parcial em registro existente (campos ausentes preservados); cria quando falta (exige campos obrigatórios) | `mode: 'set'` seguro |
| `UPSERT ONLY t:id MERGE/SET` | ok (objeto? → array, verificado: array) | |
| `UPSERT t:id CONTENT $p` | substitui o conteúdo | |

### 2.4 `UPDATE`

| Form | Result | Notes |
| --- | --- | --- |
| `UPDATE t:id MERGE $p` (inexistente) | `[]` — **não cria** | DIVERGE (2.x criava) |
| `UPDATE t MERGE $p WHERE cond` (sem match) | `[]` | seguro para `updateMany` |
| `UPDATE ONLY t:id SET …` | **objeto** | `only: true` |
| `SET` | atribuição por campo | |
| `MERGE` | merge profundo | default |
| `CONTENT` | substitui o registro; **DEFAULTs não reaplicam** | payload precisa ser completo |
| `REPLACE` | substitui | |
| `PATCH $ops` | JSON Patch; retorna o registro | `{ op, path, value }` |
| `UNSET a, b` | erro em campo obrigatório; ok em `option<…>` | |
| `… TIMEOUT 5s` | aceito | |

`RETURN` (UPDATE):

| `RETURN` | Result |
| --- | --- |
| `NONE` | `[]` |
| `BEFORE` | estado anterior (array) |
| `AFTER` | estado resultante (array) |
| `DIFF` | `[[ { op: "replace", path: "/age", value } ]]` (JSON Patch) |

### 2.5 `DELETE`

| Form | Result |
| --- | --- |
| `DELETE t:id RETURN BEFORE` | `[ registro ]` |
| `DELETE t:id` inexistente | `[]` |
| `DELETE t:id RETURN NONE` | `[]` |
| `DELETE FROM t WHERE cond RETURN BEFORE` | removidos |
| `DELETE t` (tabela) | remove tudo |

### 2.6 `RELATE` / arestas

| Form | Result |
| --- | --- |
| `RELATE a->edge->b SET …` | linha da aresta |
| `RELATE a->edge:named->b` | id de aresta nomeado |
| `LET $c = (CREATE ONLY t CONTENT $p); RELATE a->edge->$c …` | create+relate num round-trip |
| `DELETE edge WHERE in = $a AND out = $b` | `unrelate` |
| `DELETE edge WHERE <filtro>` | `unrelateMany` |
| `INSERT RELATION INTO edge { in, out, … }` | aresta por payload |

### 2.7 Lotes e transações

| Form | Result |
| --- | --- |
| `FOR $row IN $rows { UPDATE t MERGE $row.fields WHERE by = $row.by; }` | `updateEach` (1 statement) |
| `LET $e = (SELECT VALUE id FROM t WHERE uniq = $v LIMIT 1); IF array::len($e) = 0 THEN CREATE … ELSE UPDATE $e[0] … END;` | upsert-por-campo-único sem id |
| `BEGIN TRANSACTION; …; COMMIT TRANSACTION;` | aplica |
| `BEGIN TRANSACTION; …; CANCEL TRANSACTION;` | descarta; o SDK **lança** na coleta das respostas (`Cancelled`) — o executor trata o cancel como erro esperado |

**Atomicidade (verificado com o SDK via `responses()`, 3.2.0):**

| Cenário | Resultado |
| --- | --- |
| Batch `stmts` **sem** transação, statement do meio falha | os demais **persistem** (`CREATE first`, `CREATE dup` falha, `CREATE third` persiste) — cada statement é independente |
| Batch dentro de `BEGIN/COMMIT`, statement falha | **nada persiste**: o statement que falhou retorna o erro real; os statements ANTERIORES são remarcados retroativamente como `Query` + `NotExecuted` ("not executed due to a failed transaction"); o `COMMIT` retorna "Cannot COMMIT: the transaction was aborted due to a prior error" |
| Todas as respostas (incluindo `BEGIN`/`COMMIT`) | 1 resposta por statement, na ordem — o offset dos statements do usuário é estável |

Implicações: `transactional: true` (default de lotes) embrulha em `BEGIN/COMMIT` e é atômico em 1
round-trip; o executor reporta a falha **raiz** (pula `NotExecuted`/`Cancelled`, que normalizam para
`TransactionRollback`). `UPDATE`/`CREATE` sem transação NÃO são atômicos entre si.


---

## 3. SELECT — projeções, cláusulas, `ONLY`, ranges

| Form | Result | Notes |
| --- | --- | --- |
| `SELECT id, f, path.sub AS alias` | projeção | paths desconhecidos → `null` (validar no client com `strict`) |
| `SELECT * OMIT f` | remove campos | funciona mesmo com `f` selecionado |
| `SELECT * FROM ONLY t:id` | **objeto** | inexistente → `null`/`undefined` (falsy) |
| `SELECT * FROM ONLY t` (2+ rows) | **erro** (`Expected a single result output`) | `LIMIT 1` resolve (`FROM ONLY t LIMIT 1` → objeto) |
| `SELECT VALUE f` | array de valores | `value: true` |
| `SELECT VALUE id … LIMIT 1` | probe de `exists` | |
| `SELECT count() … GROUP ALL` | `[ { count: n } ]` | `count` |
| `SELECT count() FROM t` (sem GROUP) | **uma linha por registro** | sempre emitir `GROUP ALL` |
| `SELECT … GROUP BY f` | linhas por grupo | |
| `SELECT * … GROUP BY f` / `GROUP ALL` | **erro** (`cannot be aggregated`) | exigir projeção explícita |
| `SELECT count() FROM (SELECT f … GROUP BY f) GROUP ALL` | conta **grupos** | paginação com `groupBy` |
| `SELECT math::sum/avg/min/max(…)` | agregadores | `math::median`/`stddev`/`variance` também; **`math::avg` não existe em 3.x → `math::mean`** (DIVERGE) |
| `SELECT array::group(f), array::distinct(f)` | arrays | `collect`/`distinct` do `aggregate` |
| `SELECT … SPLIT f` | desdobra arrays (1 linha por elemento) | `count()` por linha split = 1 → agregar exige outra forma |
| `SELECT … SPLIT f GROUP BY f` / `GROUP ALL` | **erro** (`mutually exclusive`) | DIVERGE |
| `SELECT id, (expr) AS alias … ORDER BY alias DESC` | ordena por alias/expressão | |
| `SELECT … ORDER BY (expr)` | **parse error** | só identificador/alias; use `AS alias` |
| `SELECT … ORDER BY a DESC, b ASC` | ok | |
| `SELECT … LIMIT n START m` / `LIMIT $l START $s` | ok (binds aceitos) | `limit`/`start` |
| `SELECT … WITH INDEX a, b` | ok (lista) | `WITH INDEX` **antes** do WHERE |
| `SELECT … TIMEOUT 5s` | ok | `TIMEOUT` **depois** de `LIMIT/START`; `TIMEOUT … LIMIT` = parse error |
| `SELECT … WITH INDEX idx` / `WITH NOINDEX` | ok | `WITH` antes de `WHERE`; depois = parse error |
| `SELECT … PARALLEL` | **parse error** | DIVERGE |
| `SELECT … FROM t:2..4` | `[t:2, t:3]` (fim exclusivo) | suffix, não `t:2..t:4` |
| `SELECT … FROM t:2..=4` | `[t:2, t:3, t:4]` | inclusivo |
| `SELECT … FROM t:abc..=xyz` | ok com ids string; `⟨a-b⟩` quando preciso | |
| `SELECT … FROM t:2..t:4` | **parse error** | DIVERGE |
| `SELECT * FROM ONLY t:id FETCH link` | FETCH depois de ONLY | |
| `EXPLAIN SELECT …` | plano em string | só `SELECT`; `EXPLAIN UPDATE` é erro |
| `SELECT … VERSION d'…'` | erro em backend memory ("does not support versioned queries") | emissão condicionada ao suporte |
| `SELECT … VERSION d'…' TIMEOUT 5s` | ok (ordem) | `VERSION` **antes** de `TIMEOUT` |

**Ordem das cláusulas (3.2.4, verificada):**

```surql
SELECT [VALUE] <projeção> FROM <alvo>
  [WITH INDEX … | WITH NOINDEX]
  [WHERE …]
  [SPLIT …]
  [GROUP BY … | GROUP ALL]
  [ORDER BY …]
  [LIMIT …]
  [START …]
  [VERSION d'…']
  [TIMEOUT …]
  [FETCH …]            -- M3
```

`SELECT * OMIT f` funciona mesmo com `f` obrigatório e com `f` projetado
(`SELECT name, age OMIT age` → `{ name }`).

### 3.1 Projeções por caminho (formas verificadas)

| Forma | Resultado |
| --- | --- |
| `SELECT address.city FROM t` | `{ address: { city } }` (aninha pelo caminho) |
| `SELECT contacts[*].type FROM t` | `{ contacts: { type: [ … ] } }` (array) |
| `SELECT contacts.type FROM t` | `{ contacts: { type: [ … ] } }` (array — o ancestral é array) |
| `SELECT contacts[0].value FROM t` | `{ contacts: { value } }` (escalar — índice fixo) |
| `SELECT contacts[*].type AS t FROM t` | `{ t: [ … ] }` (alias achata) |
| `SELECT *, (expr) AS x FROM t` | linha completa + `x` (flat) |
| `SELECT VALUE contacts[*].type FROM t` | `[ [ … ] ]` (valor direto) |

### 3.2 `FETCH` (links)

| Form | Result |
| --- | --- |
| `SELECT * FROM t ORDER BY id FETCH author` | `author` materializado (objeto completo) |
| `SELECT * FROM t WHERE … LIMIT n FETCH author` | idem, respeitando o limite |
| `FETCH a.b` | aninhado (link dentro de link) materializado |
| `FETCH a, b` | múltiplos (não-links são ignorados sem erro) |
| `FETCH` antes de `ORDER BY` | **parse error** — FETCH é a última cláusula |
| `SELECT id, author.name AS an … FETCH author` | alias preservado; FETCH não sobrescreve |
| `SELECT id, author.id AS author_id, author.name AS author_name` (sem FETCH) | projeção achatada — base da remontagem de `include: { author: { select } }` |

### 3.3 Paginação / cursor

| Form | Result |
| --- | --- |
| `SELECT … ORDER BY id ASC LIMIT n` + `SELECT count() … GROUP ALL` | 2 statements no mesmo `query` (`paginate`) |
| `WHERE (age < $c0 OR (age = $c0 AND id > $c1)) ORDER BY age DESC, id ASC LIMIT n` | cursor por tupla |
| `id > $c` / `id < $c` | cursor por record id (`before` reordena no client) |

---

## 4. WHERE — operadores verificados

### 4.1 Igualdade / comparação / presença

| Operador | Forma emitida | Verificado |
| --- | --- | --- |
| valor puro | `f = $p` | ✓ |
| `exact` | `f == $p` | ✓ |
| `isNull`/`isNotNull` | `f = NULL` / `f != NULL` | ✓ |
| `isNone`/`isNotNone` | `f = NONE` / `f != NONE` | ✓ |
| `lt/lte/gt/gte` | `< <= > >=` | ✓ |
| `between` | `f >= $a AND f <= $b` | ✓ |
| `outside` | `f < $a OR f > $b` | ✓ |
| `in`/`notIn` | `f IN $set` / `f NOT IN $set` | ✓ |
| `inRange` | `f >= $a AND f <= $b` | ✓ |

### 4.2 Strings

| Operador | Forma emitida | Verificado |
| --- | --- | --- |
| `contains` | `f CONTAINS $p` | ✓ |
| `startsWith` / `endsWith` | `string::starts_with(f, $p)` / `string::ends_with(f, $p)` | ✓ |
| `matches` | `string::matches(f, /regex/)` | ✓ |
| `eqInsensitive` / `containsInsensitive` | `string::lowercase(f) = string::lowercase($p)` / `… CONTAINS …` | ✓ |
| `matchesFullText` | `f @@ $q` / `f @0@ $q` | ✓ (precisa de índice FULLTEXT) |
| `fuzzy` / `anyFuzzy` / `allFuzzy` | **não emitir** (`~`/`?~`/`*~` = parse error) | DIVERGE — usar `string::similarity::*` |

### 4.3 Arrays / sets — semântica exata

| Operador | Forma | Semântica verificada |
| --- | --- | --- |
| `contains` | `f CONTAINS $x` | elemento presente |
| `containsNot` | `f CONTAINSNOT $x` | ausente |
| `containsAll` | `f CONTAINSALL $set` | todos os `$set` presentes em `f` |
| `containsAny` | `f CONTAINSANY $set` | algum presente |
| `containsNone` | `f CONTAINSNONE $set` | nenhum presente |
| `inside` | `f INSIDE $set` | **scalar** dentro de `$set` (array ≠ elemento → `false`) |
| `allInside` | `f ALLINSIDE $set` | `f` ⊆ `$set` |
| `anyInside` | `f ANYINSIDE $set` | algum elemento de `f` em `$set` |
| `noneInside` | `f NONEINSIDE $set` | nenhum elemento de `f` em `$set` |
| `notInside` | `f NOTINSIDE $set` | negação de `INSIDE` |
| `outside` | `f OUTSIDE $set` | negação de `INSIDE` |
| `intersects` | `f INTERSECTS $set` | `false` para arrays comuns — usar `ANYINSIDE`; usar só para geometria |
| `anyEquals` | `f ?= $x` | algum elemento `= $x` |
| `allEquals` | `f *= $x` | todos os elementos `= $x`; **array vazio → `true`** (vacuous truth) |
| `length` | `array::len(f) = $p` | ✓ |

### 4.4 Paths / lógicos / records / geo / vetor

| Forma | Resultado verificado |
| --- | --- |
| `'address.city'` | projeção direta ✓ |
| `'contacts[0].value'` | índice funciona ✓ |
| `'contacts[*].type'` | devolve **array** — igualdade precisa de `CONTAINS`/`INSIDE` |
| `AND`/`OR`/`NOT` aninhados | ✓ (parênteses explícitos) |
| record value `f = $recordId` | ✓ |
| `geometry INTERSECTS $geo` / `INSIDE $geo` | ✓ |
| `geo::distance(f, $p) <= $r` | ✓ |
| KNN `embedding <|k, metric|> $q` | ✓ com índice HNSW (ver §6) |
| fragmento `surql` | interpola com binds ✓ |
| subquery correlacionada | `$parent.id` dentro de `(SELECT …)` ✓ |

---

## 5. Grafo (complemento ao `graph-syntax-map.md`, reconfirmado em 3.2.0)

| Forma | Resultado |
| --- | --- |
| `SELECT ->edge AS e`, `<-edge AS i`, `(<->edge) AS b` | arrays de arestas |
| `SELECT ->edge->target AS t` | array de targets |
| `SELECT ->edge->target.field` | valores do campo |
| `SELECT ->? AS any`, `<->?` (record-anchored) | arestas de qualquer tipo |
| `SELECT <->edge<->target` (record-anchored) | ambos os sentidos (não em projeção) |
| `count(->edge)`, `count(->edge[WHERE …])` | contagens |
| `->(edge WHERE …)->target`, `->edge->(target WHERE …)` | filtros por edge/alvo |
| `(SELECT id, title FROM ->(likes WHERE score > 4)->post ORDER BY title LIMIT 2) AS liked` | include por pai **com o filtro no edge** |
| `(SELECT id, out.* FROM ->likes) AS likes` | edge + target no mesmo objeto |
| `@.{1..2}->edge->target` / `rec.{1..2}(->edge->target)` | recursão devolve **record ids**; projetar dentro do body → erro |
| `$parent.id` | correlação com o registro externo |

---

## 6. Full-text e vetorial

```surql
-- full-text (3.x spelling)
DEFINE ANALYZER ascii TOKENIZERS blank,class FILTERS lowercase,ascii;
DEFINE INDEX idx_ft ON post FIELDS title FULLTEXT ANALYZER ascii BM25 HIGHLIGHTS;
SELECT id FROM post WHERE title @@ 'hello';
SELECT id, search::score(0) AS score FROM post WHERE title @0@ 'hello' ORDER BY score DESC;
SELECT search::highlight('<b>', '</b>', 0, title) AS hl FROM post WHERE title @@ 'hello';
```

| Item | Verificado |
| --- | --- |
| `SEARCH ANALYZER` (2.x) | **parse error** → usar `FULLTEXT ANALYZER` |
| `@@` (todos os índices) e `@n@` (índice `n`) | ✓ |
| `search::score(n)` | número; ordena por alias ✓ |
| `search::highlight(prefix, suffix, indexRef, field)` | **4 argumentos**; 2–3 → erro |

```surql
DEFINE TABLE vec SCHEMALESS;
DEFINE FIELD embedding ON vec TYPE array<float>;
DEFINE INDEX idx_vec ON vec FIELDS embedding HNSW DIMENSION 3 DIST COSINE;
SELECT id, vector::distance::knn() AS dist FROM vec WHERE embedding <|3, COSINE|> $q;
SELECT vector::similarity::cosine(embedding, $q) AS sim FROM vec;
```

---

## 7. Live queries e changefeeds

| Forma | Resultado |
| --- | --- |
| `LIVE SELECT * FROM t [WHERE …] [FETCH …]` | devolve **uuid** da live query |
| `LIVE SELECT DIFF FROM t [WHERE …] [FETCH …]` | ✓ — `DIFF` após `SELECT`, **sem projeção** |
| `LIVE SELECT * FROM t … DIFF` | parse error (DIFF fora de posição) |
| `LIVE SELECT DIFF * FROM t` / `LIVE SELECT DIFF f FROM t` | parse error (projeção com DIFF) |
| `LIVE SELECT` dentro de transação | não suportado (verificar no client) |
| `KILL $q` (param) ou `KILL u"…"` | encerra; `KILL "uuid"` é parse error |
| `SHOW CHANGES FOR TABLE t SINCE 0 LIMIT n` | `[ { versionstamp, changes: [ { update/delete/create/define_table: … } ] } ]` |
| `SHOW CHANGES FOR DATABASE SINCE d'…' LIMIT n` | idem no nível do database |

---

## 8. Erros do SDK → códigos do ORM (amostras reais)

| Erro do servidor | Texto observado | Código `BetterSchemicError` |
| --- | --- | --- |
| id duplicado | ``Database record `user:u1` already exists`` (`AlreadyExists`) | `RecordAlreadyExists` |
| assert/tipo | ``Couldn't coerce value for field `password` of `user:u1`: Expected `string` but found `NONE` `` | `AssertionFailed` / `ValidationError` |
| transação cancelada | `The query was not executed due to a cancelled transaction` (`Cancelled`) | `TransactionRollback` |
| `EXPLAIN` inválido | `Invalid statement: EXPLAIN is only supported with the new execution model` | `ParseError` / `UnsupportedCapability` |
| `VERSION` sem suporte | `…The underlying datastore does not support versioned queries` | `UnsupportedCapability` |
| parse | `Parse error: Unexpected token …` | `ParseError` |

Nota: em scripts multi-statement, o SDK pode **lançar** (não só responder por statement) em
`AlreadyExists`/`Cancelled` durante a coleta — o executor usa `responses()` e normaliza os dois casos.

---

## 9. Implicações diretas no plano (`PLANO-QUERYS-TIPADAS.md`)

1. **`update` simplificado**: alvo direto (`UPDATE t:id …`), sem workaround de `WHERE`; `updateMany` sem match → `[]` (nunca cria).
2. **`upsert` por campo único**: `UPSERT t MERGE $p WHERE uniq = $v` (cria quando nada casa) é o lowering preferencial; `LET`+`IF/ELSE` fica como fallback.
3. **Remover `parallel`** da superfície de leitura (ou marcar `UnsupportedCapability`).
4. **Remover fuzzy `~`/`?~`/`*~`**; expor `string::similarity::*` via `fn.*`/fragments.
5. **Full-text**: usar `FULLTEXT ANALYZER`; `search::highlight` com 4 args; `matchesFullText` aceita `index`/`indexes`.
6. **`aggregate`**: `SPLIT` e `groupBy` exclusivos (`ClauseNotSupported`); `count` de grupos via subquery.
7. **Path-array igualdade** vira `CONTAINS` (ou `INSIDE` para scalar membership) — não `=`.
8. **`range`** → `t:<start>..<end>` / `t:<start>..=<end>`.
9. **Cursor** por tupla confirmado; `before` reordena no client.
10. **`ON DUPLICATE`**: `$input` apenas; incremento via subquery; `RETURN BEFORE` não confiável e `RETURN DIFF` tem shape próprio.
11. **Live**: `LIVE SELECT DIFF FROM …` sem projeção; `kill(uuid)` com bind; uuid é string/Uuid do SDK.
12. **`.explain()`** só em leitura; `VERSION` e `PARALLEL` sujeitos a capability/backend.
13. **`FROM ONLY t:missing`** → falsy (não erro) — `findUnique` devolve `null`.
14. **`INSERT RELATION INTO`** disponível para arestas em lote.
15. **Catálogo `fn.ts`**: `search.highlight` está tipado com 3 args (`f3<string, string, number, string>`) mas o servidor exige 4 (`prefix, suffix, indexRef, field`) — corrigir no M5.2 (ou no próximo toque em `fn.ts`) e cobrir com o teste live (hoje `fn-catalog.test.ts` marca `search.highlight: null`).
16. **`only` (findMany)**: `FROM ONLY <tabela>` só vale com **exatamente um** resultado (senão erro). O compiler emite `FROM ONLY`; use `limit`/`where` para garantir a unicidade (`findUnique`/`findFirst` cobrem os casos comuns).
17. **Ordem de cláusulas**: `WITH` → `WHERE` → `SPLIT` → `GROUP` → `ORDER BY` → `LIMIT` → `START` → `VERSION` → `TIMEOUT` (o compiler emite nessa ordem; o servidor rejeita outras).
18. **`count()`/agregadores sem `GROUP ALL`**: `count()` vira uma linha por registro; `math::*` exige array. `aggregate`/`count` sempre emitem `GROUP ALL`/`GROUP BY`.
19. **`ORDER BY`**: só identificador/alias — expressão entre parênteses é parse error; use `SELECT (expr) AS alias … ORDER BY alias`.
20. **Projeção por caminho**: o servidor aninha pelo caminho (`contacts[*].type` → `{ contacts: { type: [ … ] } }`); alias achata (`AS t` → `{ t: [ … ] }`). O decoder espelha essa forma.
21. **`SELECT *` + `GROUP`**: inválido ("cannot be aggregated") — `groupBy`/`groupAll` exigem projeção explícita (o compiler falha com `ValidationError` apontando `aggregate()`).
22. **Ranges de record**: `t:1..=2` / `t:abc..=xyz` (sufixo de id, nunca `t:1..t:2`); ids não-identificadores são escapados (`⟨a-b⟩`).
23. **`math::avg` não existe em 3.x** (parse error; a sugestão do servidor é `math::log`) — o ORM mantém a API `{ avg: 'campo' }` e emite `math::mean(campo)`. `math::median/stddev/variance` existem.
24. **`GROUP BY` exige a chave na projeção** (`Missing group idiom … in statement selection`): `aggregate` valida que cada `groupBy` aparece no `select` (quando a projeção é estaticamente analisável) e ensina a corrigir.
