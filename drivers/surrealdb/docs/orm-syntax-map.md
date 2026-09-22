# SurrealDB ORM syntax map — empirical (server 3.2.0)

Every row below was **live-probed** against SurrealDB **3.2.0** (local `surreal` binary, ephemeral
in-memory server), never inferred. This is the ground truth the `/orm` compiler must emit: where the
prototype (`prototipo-querys-tipadas/better-surreal/*`) disagrees, the server wins.

- Executable half: `test/live/orm-syntax.test.ts` (89 probes, skips without the `surreal` binary).
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
| `logins = logins + 1` no `ON DUPLICATE KEY UPDATE` | campos nus, `$before`/`$after` são `NONE`; só `$input.*` funciona | incremento contra o estado anterior = subquery correlacionada por id (`(SELECT VALUE f FROM ONLY t:id) + 1`) — e o branch de criação a avalia também, então upsert com expressão usa `LET`/`IF` |
| `SET $obj` (objeto bindado) em `UPDATE`/`UPSERT` | **parse error** (`Unexpected token 'a parameter'`) | emitir `SET f = $p` por campo |
| `FOR $row IN $rows { … }` devolve o resultado de cada iteração | devolve **`NONE`** (live 3.2.4) | `updateEach`/`skipDuplicates` compilam 1 statement por item (mesmo round-trip) |
| `INSERT` de um `id` string `"user:x"` aponta para `user:x` | o id vira o **valor string** (`user:⟨user:x⟩`) | o ORM converte `id` string → `RecordId` antes de bindar |
| `ON DUPLICATE KEY UPDATE` aceita payload parcial | valida a linha do INSERT: payload parcial em SCHEMAFULL **falha** antes do conflito | documentar que `onDuplicate` recebe linhas inseríveis |
| `LIVE SELECT * FROM users WHERE … DIFF` | `DIFF` vai **logo após `SELECT`** e não aceita projeção: `LIVE SELECT DIFF FROM t …` | lowering próprio; `diff: true` + `select` → `ClauseNotSupportedInLive` |
| `KILL "uuid"` (string) | parse error; aceita `KILL $param` / `KILL u"…"` | `kill()` liga o uuid como parâmetro |
| `.explain()` em writes | `EXPLAIN` só existe para `SELECT` ("only supported with the new execution model") | `.explain()` só em reads |
| `VERSION d'…'` sempre disponível | exige backend versionado; memory server: "does not support versioned queries" | emitir; erro estruturado quando o backend não suporta |
| `FETCH` posicionado livremente | FETCH é a **última** cláusula (depois de WHERE/ORDER/LIMIT) | lowering na ordem correta |
| `[NONE]` e `NULL` idênticos | continuam distintos (`isNone` ≠ `isNull`) | manter ambos |
| `include: { likes: true }` → `->likes->post AS likes` devolve registros | traversal cru devolve **record ids**; registros exigem subquery `(SELECT * FROM ->likes->post)` | `include` de grafo sempre por subquery |
| `include: { likes: { where: { score: 4 } } }` → `(SELECT … FROM ->likes->post WHERE score = $p)` | a linha da subquery é o **alvo** (`score` não existe lá); filtro do edge vai em `->(likes WHERE score = $p)` e o do alvo em `->post->(post WHERE …)` | split edge/target pelo dono da coluna |
| `edge` + `target` → `(SELECT …, out.* FROM ->likes->post …)` | `out.*` só existe enquanto a linha é a ARESTA: depois de `->target` a linha é o alvo e `out` é `NONE` → **`[{}]`** (silencioso, com ou sem `WHERE`/`ORDER BY`) | `edge`+`target` para no edge (`FROM ->likes`), projeta `out.*` e filtra o alvo por `WHERE out.<campo>` |
| `<-edge->target` alcança o outro endpoint | o alvo segue a **mesma direção** (`<-edge<-target`); `<-edge->target` devolve `[]` | lowering da direção `in` usa `<-edge<-target` |
| `every` → `count(traversal[WHERE NOT …]) = 0` | `NOT` sem parênteses no filtro de traversal é **parse error**; `count(t) = count(t[WHERE …])` é NONE-safe e equivalente | `every` por igualdade de contagens |
| `_count` de link array usa `count(campo)` | `array::len(campo)` **erra em `NONE`**; `count(campo)` devolve `0` | usar `count(campo)` |
| `FETCH` materializa o link mesmo fora do `select` | `SELECT id FROM post FETCH author` **não devolve** `author`; o link precisa estar na seleção | o compiler adiciona o link à projeção quando `include` é FETCH |
| `orderBy` no include ordena qualquer campo | dentro da subquery o servidor exige o **order idiom** na seleção (projeção `*` cobre) | validar `orderBy` ⊆ projeção do alvo (ou `select: '*'`) |
| `live({ only: true })` → `FROM ONLY` | `LIVE SELECT * FROM ONLY t` é **parse error**; `FROM t:id` dá erro de execução ("Cannot execute LIVE statement using value") | `only`/`value` recusados em live (`ClauseNotSupportedInLive`); live aceita `where`/`select`/`diff`/`fetch` |
| `live({ select })` + `DIFF` no mesmo args | projeção + `DIFF` é parse error; `DIFF` só logo após `SELECT` e sem projeção | `diff: true` é exclusivo de `select` (`ClauseNotSupportedInLive`) |
| `client.kill('uuid')` (string) | `KILL "uuid"` é parse error; `KILL $p` com **string** funciona; `KILL u"…"` funciona enquanto a live existe | `kill()` valida o uuid e binda a string |
| `SHOW CHANGES … SINCE <versionstamp>` pagina a partir do último stamp | `SINCE` é **inclusivo** (repete a entrada do stamp) | paginação avança `último + 1`; documentar |
| `SINCE` aceita param | parse error ("expected a version stamp or a date-time") | inline do literal (`0`, número/bigint ou `d'…'`) |
| `SINCE d'…'` filtra por data | `d'1970-01-01'` devolve tudo; `d'2020-…'`/`d'ontem'` devolvem **`[]`** no backend memory (o stamp interno não alinha com wall-clock) | aceitar `Date`/ISO mas documentar: prefira versionstamp; teste live usa `0`/stamp |
| changefeed rotula CREATE separado | `CREATE` chega como `update: { … }` (não existe chave `create`); com `INCLUDE ORIGINAL`, UPDATE = `{ current, update: [patch] }`, DELETE = `{ delete: { id, original? } }`; `define_table` também aparece; `versionstamp` é **bigint** | normalizar em `ChangeSet` |
| `BEGIN/COMMIT` em chamadas `query()` separadas segura a transação | cada `query()` RPC é a própria transação: o `CREATE` persiste e o `COMMIT` seguinte dá "Cannot COMMIT without starting a transaction" | só `mode: 'sdk'` (`beginTransaction()` do SDK); `mode: 'sql'` falha rápido (`UnsupportedCapability`) |
| Transação sobre HTTP | engine HTTP não tem a feature `Transactions` (SDK lança `UnsupportedFeatureError`) e `LIVE` responde `LiveQueryNotSupported` | normalizar para `UnsupportedCapability`/`LiveQueryUnsupported`; documentar que live/tx exigem WebSocket |
| `beginTransaction` aninhado é erro | o SDK/servidor **permite** (sem savepoint) | o client dobra chamada aninhada na MESMA tx; reentrada pelo client raiz → `TransactionAlreadyActive` |
| Write conflict tem erro dedicado | `kind: "Internal"`, mensagem `Transaction conflict: Write conflict, retry the transaction. This transaction can be retried` | heurística de mensagem já normaliza para `WriteConflict`; retry re-executa o callback |
| `afterCommit` fora de tx | sem escopo transacional | `ValidationError` fail-fast (dívida registrada) |
| `$withContext` com NS/DB "sem estado global" via `USE` | `USE NS … DB …;` no MESMO script escopa as statements seguintes e **não muda a sessão** (a conexão continua no NS/DB anterior) | prefixar `USE NS … DB …;` em toda operação do clone (1 round-trip, zero estado global); `auth` não cabe no prefixo → overload assíncrono que forka a sessão |
| `client.fn.call` via `db.run` | `run`/`api`/`export`/`import`/`auth` usam o NS/DB da **sessão** — um clone por prefixo miraria o DB errado | `fn.call` compila `RETURN fn::x($p…)` (context-aware); `api`/`auth`/`export`/`live` falham rápido (`UnsupportedCapability`) em clone por prefixo |
| `client.import(dump)` via SDK | o `import()` do SDK **quebra sobre WebSocket** (`JSON Parse error: Unexpected identifier "undefined"`) | `import` reexecuta o dump por `query()` (funciona em WS e respeita o contexto) |
| `client.ping()` via `health()` | sobre WebSocket o servidor não tem o método (`NotFoundError: Method not found`) | `ping()` faz um round-trip `RETURN true` (uniforme em WS/HTTP) |
| `client.api.*` lança em erro HTTP | o SDK resolve o envelope `{ status, body, headers, request_id }` **sem rejeitar** em 4xx/5xx | o ORM inspeciona `status >= 400` e lança `DatabaseError` com `status` + `details.body` |
| `raw.timeoutMs` aplica `TIMEOUT` a qualquer raw | `TIMEOUT` só é aceito por SELECT/UPDATE/CREATE/DELETE/INSERT/UPSERT/RELATE (RETURN/LET/SLEEP/INFO/SHOW CHANGES/DEFINE dão parse error) | aplicar só a statement única com verbo compatível; caso contrário deixar intacto (documentado) |

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
| `INSERT … ON DUPLICATE KEY UPDATE f = (SELECT VALUE f FROM ONLY t:id) + 1` | incremento contra o estado anterior | únicos campos acessíveis antes: a subquery — e ela é avaliada **também no branch de criação** (live 3.2.4: `NONE + int` = erro), então upserts com expressão usam `LET`/`IF` |
| `INSERT … ON DUPLICATE … RETURN AFTER/NONE` | ok | ver `RETURN` abaixo |
| `INSERT … ON DUPLICATE … RETURN BEFORE` | devolve o estado **anterior** (live 3.2.4) | exposto pelo ORM |
| `INSERT … ON DUPLICATE … RETURN DIFF` | `[[ { op: "change", path, value: "@@ … @@" } ]]` | formato **paged diff** (aninhado), ≠ do UPDATE |
| `INSERT INTO t $p` com `id` string (`"user:x"`) | id vira a **string** (`user:⟨user:x⟩`), não um record id | o ORM converte para `RecordId` antes de bindar |
| `INSERT … ON DUPLICATE` com payload parcial + tabela SCHEMAFULL | **erro** de coerce no campo ausente | o INSERT precisa ser uma linha inserível (o `ON DUPLICATE` não relaxa a validação) |
| `INSERT RELATION INTO edge {…}` | linhas da aresta | caminho nativo para `relateMany`/seed |

### 2.3 `UPSERT`

| Form | Result | Notes |
| --- | --- | --- |
| `UPSERT t:id MERGE $p` | `[ {…} ]`; cria se faltar | `upsert` por id |
| `UPSERT t MERGE $p WHERE cond` | linhas afetadas; **cria quando nada casa** | `upsert` por campo único (validar unicidade no schema) |
| `UPSERT t:id SET $p` (objeto inteiro) | **parse error** (`Unexpected token 'a parameter'`) — usar `SET f = $p` por campo | o ORM emite per-field |
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
| `FOR $row IN $rows { UPDATE t MERGE $row.fields WHERE by = $row.by; }` | **devolve `NONE`** (nada por iteração) — o ORM NÃO usa `FOR` para `updateEach` |
| `UPDATE t MERGE $f0 WHERE id = $b0; UPDATE t MERGE $f1 WHERE id = $b1;` | 1 resultado por statement, na ordem (`updateEach` per-item: casa → `[row]`, miss → `[]`) |
| `INSERT IGNORE INTO t $p0; INSERT IGNORE INTO t $p1;` | `skipDuplicates` per-item (só as linhas inseridas voltam) |
| `LET $e = (SELECT VALUE id FROM t WHERE uniq = $v LIMIT 1); IF array::len($e) = 0 THEN CREATE … ELSE UPDATE $e[0] … END;` | upsert-por-campo-único sem id (e fallback por id quando o `update` tem expressões) |
| `LET $c = (CREATE ONLY t CONTENT $p); RELATE a->edge->$c SET …; RETURN $c;` | create + relate; `RETURN $c` devolve o **objeto** (não array) |
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

### 5.1 `include` — lowering verificado (M3)

Formas que o compiler emite (direção `out`; `in` espelha as setas para `<-edge<-target` e usa `in.*`):

| Forma do `include` | Statement |
| --- | --- |
| link `true` | `SELECT * … FETCH author` (link entra na seleção se explícita) |
| link `{ select }` | `author.id AS author_id, author.name AS author_name` + remontagem no client (sem FETCH) |
| link `{ include }` aninhado | `FETCH author.profile` |
| aresta `true` | `(SELECT * FROM ->likes->post) AS likes` |
| aresta `{ select }` | `(SELECT id, title FROM ->likes->post) AS likes` |
| aresta `{ where }` | `FROM ->(likes WHERE <edge>) ->(post WHERE <target>)`; `orderBy`/`limit`/`start` na subquery |
| aresta `{ edge: true }` | `(SELECT * FROM ->likes) AS likes` |
| aresta `{ edge, target }` | `(SELECT <edge…>, out.* FROM ->likes)` → remonta `{ edge, target }` no client |
| aresta `edge`+`target`+`where` | `(SELECT <edge…>, out.* FROM ->(likes WHERE <edge>) WHERE <out.target…>)` |
| direção `in` | `(SELECT … FROM <-likes<-user)`; `edge`+`target` materializa `in.*` e filtra `WHERE in.<campo>` |
| direção `both` (target) | `(SELECT id, title FROM <->likes<->post)` — o alvo segue a mesma direção |
| direção `both` (edge) | `(SELECT * FROM <->likes)`; `edge`+`target` em `both` é **recusado** (não há alias único de alvo) |
| aresta wildcard | `(SELECT * FROM ->?)` / `<-?` / `<->?`; filtro do edge `->(? WHERE score > 4)` |
| `_count` (aresta) | `count(->likes) AS _count_likes` / `count(->likes[WHERE score > 4])` / `count(->likes->(post WHERE …))` |
| `_count` (link array) | `count(friends) AS _count_friends` / `count(friends[WHERE name = 'Alice'])` |

Fatos de lowering que a tabela acima depende (todos live-probed em 3.2.x):

- A subquery de alvo devolve **registros completos**; o traversal cru devolveria record ids.
- `FETCH` **não sobrescreve** alias projetado (`author.id AS author_id` sobrevive) e não devolve
  link fora da seleção.
- `out.*` (**edge**+**target**) exige que a subquery pare no edge (`FROM ->(edge WHERE …)`); seguir
  para o alvo (`->target`) faz `out` ser `NONE` e a linha virar `{}` — o filtro do alvo vai em
  `WHERE out.<campo>`.
- `ORDER BY` dentro da subquery exige o campo na seleção; projeção `*` cobre qualquer campo.
- `count(<->likes)`, `count(<->?)` e `<->edge<->target` funcionam para direção `both`; já `?.*` é
  **parse error** (por isso `edge`+`target` + `both` não tem lowering).
- Filtro de edge wildcard: `->(? WHERE score > 4)` filtra a linha da aresta; `->?[WHERE …]` também
  filtra o array (o compiler emite a forma com parênteses).

### 5.2 `where` relacional — lowering verificado (M3)

| Operador | Forma emitida |
| --- | --- |
| link `one` `is` | `<link>.<campo> = $p` (filtro aninhado compilado com prefixo do link) |
| link `one` `isNot` | `NOT (<link>.<campo> = $p …)` — verdadeiro quando o link é `NONE` |
| aresta `some` | `count(<traversal>[WHERE …]) > 0` |
| aresta `none` | `count(<traversal>[WHERE …]) = 0` |
| aresta `every` | `count(<traversal>) = count(<traversal>[WHERE …])` (vacuamente verdadeiro em 0) |
| link array `some`/`none` | `count(<campo>[WHERE …]) > 0` / `= 0` |
| link array `every` | `count(<campo>) = count(<campo>[WHERE …])` |

### 5.3 Traversal/recursão via `select` + `surql` (M3.5)

Sem superfície nova: `select` já aceita fragments, então o açúcar é uma receita documentada (o
compiler não tenta parsear `@.{…}` — quem escreve o fragment sabe a profundidade/edge):

```ts
client.users.findMany({
  select: {
    name: true,
    descendants: surql`@.{1..10}->parent_of->person`.as<RecordId[]>(),
    liked: surql`->likes->posts.title`.as<string[]>(),
    likedCount: surql`count(->likes)`.as<number>(),
  },
});
```

- `@.{n}` / `@{n,m}` / `@.{n+collect}` só existem na posição de projeção (`SELECT`); o fragment
  `user:alice.{1..2}(->likes->post)` ancora em um record explícito.
- O body devolve **record ids** — projetar campos dentro do body é erro de runtime
  (`Expected a record ID during recursive graph traversal`); projete fora.
- Em `/query` a alternativa procedural é `block()`.

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

## 7. Live queries e changefeeds (M4)

**LIVE SELECT — formas (server 3.2.0):**

| Forma | Resultado |
| --- | --- |
| `LIVE SELECT * FROM t [WHERE …] [FETCH …]` | devolve o **uuid** (`Uuid` do SDK, `type: "live"`) |
| `LIVE SELECT id, name FROM t [WHERE …]` | ✓ — projeção normal; uuid |
| `LIVE SELECT DIFF FROM t [WHERE …] [FETCH …]` | ✓ — `DIFF` logo após `SELECT`, **sem projeção** |
| `LIVE SELECT * FROM t … DIFF` / `LIVE SELECT f FROM t … DIFF` | parse error (DIFF fora de posição / com projeção) |
| `LIVE SELECT VALUE f FROM t` | parse ok, uuid — mas **nenhuma notificação é emitida** (3.2.0) |
| `LIVE SELECT * FROM ONLY t` | parse error |
| `LIVE SELECT * FROM t:id` | erro de execução: `Cannot execute LIVE statement using value: t:id` |
| `ORDER BY` / `LIMIT` / `GROUP ALL` em live | parse error |
| `LIVE SELECT` dentro de `BEGIN … COMMIT` | o servidor aceita; o ORM recusa no client (`LiveInTransaction`) |
| `KILL "uuid"` | parse error |
| `KILL $p` com string **ou** `KILL u"…"` | encerra (enquanto a live existe); o uuid é validado e bindado pelo ORM |
| HTTP (`http://`) | `LIVE` responde `Configuration`/`LiveQueryNotSupported` → `LiveQueryUnsupported` |

**Notificações** (via `db.liveOf(uuid)`, `LiveMessage` do SDK):

```ts
{ queryId: Uuid, action: "CREATE" | "UPDATE" | "DELETE" | "KILLED", recordId: RecordId, value }
```

- Sem `DIFF`, `value` é o registro (ou o último estado em DELETE). Com `DIFF`, `value` é o array
  de patch ops (`{ op: "replace" | "change", path, value }`) — DELETE vira `[{ op: "replace", path: "", value: undefined }]`.
- `FETCH` materializa o link no `value` (mesma semântica do `SELECT … FETCH`).
- Um registro que **deixa de casar** com o `WHERE` **não** emite notificação (sem "DELETE de saída
  do filtro") — apenas mutações que continuam casando.

**Changefeeds (`SHOW CHANGES`):**

| Forma | Resultado |
| --- | --- |
| `SHOW CHANGES FOR TABLE t SINCE 0 LIMIT n` | `[ { versionstamp: bigint, changes: [...] } ]` |
| `SHOW CHANGES FOR DATABASE SINCE 0 LIMIT n` | idem, agregando todos os changefeeds do database |
| Entradas observadas | `define_table`; `update` (CREATE **e** UPDATE sem original, com o registro inteiro); `{ current, update: [patch] }` (UPDATE com `INCLUDE ORIGINAL`); `delete: { id, original? }` |
| `SINCE` é inclusivo | `SINCE <stamp>` reentrega a entrada daquele stamp — paginar com `stamp + 1` |
| `SINCE $p` | parse error ("expected a version stamp or a date-time") — literal apenas |
| `SINCE d'…'` | `d'1970-01-01'` devolve tudo; datas "recentes" devolvem `[]` no backend memory (stamp interno ≠ wall-clock) — prefira versionstamp |

**Transações (M4.1):**

| Forma | Resultado |
| --- | --- |
| `db.beginTransaction()` + `tx.query` + `tx.commit()`/`tx.cancel()` | ✓ no engine WebSocket (única forma de transação multi-call) |
| `BEGIN`/`COMMIT` em chamadas `query()` separadas | não segura: cada RPC é a própria transação (`Cannot COMMIT without starting a transaction`) |
| `beginTransaction` aninhado | permitido pelo SDK/servidor (sem savepoint) — o client dobra na mesma tx |
| `commit()` após `cancel()` | lança `Transaction not found` |
| `cancel()` após statement falho | ok (não lança) |
| Write conflict (2 tx, mesmo registro) | `kind: "Internal"` + `Transaction conflict: Write conflict, retry the transaction…` → `WriteConflict` |
| HTTP (`http://`) | engine sem a feature `Transactions` (`UnsupportedFeatureError`) → não suportado |

---

## 10. Contexto, raw e admin (M5)

**Contexto por `USE` (server 3.2.0):**

| Forma | Resultado |
| --- | --- |
| `USE NS tenant_a DB app; SELECT * FROM t;` (mesmo script) | a statement seguinte roda no NS/DB do `USE`; `USE` devolve uma linha `{ namespace, database }` |
| sessão após o script | **inalterada** (`db.namespace`/`db.database` continuam os anteriores) — sem vazamento de estado global |
| `USE NS tenant_a;` (sem DB) | **mantém** o DB corrente (a resposta traz `{ namespace, database }`); com nenhum DB selecionado, a próxima statement falha (`DatabaseEmpty`) |
| `USE NS ⟨tenant b⟩ DB ⟨my db⟩;` | ✓ — identificadores escapados com `⟨…⟩` são aceitos (o ORM usa `escapeIdent`) |
| `USE` dentro de `BEGIN … COMMIT` | aceito pelo servidor (o ORM não emite `USE` dentro de transação sem contexto) |

**Raw / funções / admin:**

| Forma | Resultado |
| --- | --- |
| `TIMEOUT` por verbo | aceito por `SELECT`/`UPDATE`/`CREATE`/`DELETE`/`INSERT`/`UPSERT`/`RELATE`; **parse error** em `RETURN`/`LET`/`SLEEP`/`INFO`/`SHOW CHANGES`/`DEFINE` |
| `RETURN fn::x($p0, $p1)` | ✓ — função via query (context-aware); `db.run("fn::x", […])` é preso à sessão |
| `INFO FOR ROOT` / `NS` / `DB` / `TABLE t` | objetos com `namespaces`/`databases`/`tables`/`fields`/`indexes`/`events`/`lives`/`functions`/`apis`/… |
| `DEFINE API '/x' FOR get THEN {…} FOR post THEN {…};` | multi-método em **um** `DEFINE API`; cada `THEN` devolve `{ status, body, headers? }` |
| `db.api().get('/x')` | resolve `{ status, body, headers, request_id }` (não rejeita em 4xx/5xx) |
| `db.version()` | `{ version: "surrealdb-3.2.0" }` |
| `db.health()` | sobre WebSocket: `NotFoundError: Method not found` |
| `db.import(dump)` (SDK) | sobre WebSocket: quebra (`JSON Parse error`); `db.query(dump)` funciona |
| `db.run`/`export`/`import`/`api`/`auth` | presos à SESSÃO (NS/DB da conexão), não ao contexto do clone |

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
10. **`ON DUPLICATE`**: `$input` apenas para valores do payload; incremento via subquery (avaliada também no branch de criação → upsert com expressão usa `LET`/`IF`); `RETURN BEFORE` devolve o estado anterior (3.2.4) e `RETURN DIFF` tem shape aninhado próprio.
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
25. **Writes (M2)**: alvos singulares = `id` ou índice UNIQUE (`UniqueTargetRequired`); `update` nunca cria (`[]` → `null`); `delete` só `before`/`none`; `deleteMany` exige `all: true` sem `where`; `updateEach`/`skipDuplicates` = 1 statement por item (e `skipDuplicates` exige `id` explícito); `upsertMany.conflict` exige índice UNIQUE; `RETURN DIFF` é achatado no decode (`[[ops]]` → `ops`) e **somado entre os statements** do batch (`update` data+unset, `createMany`, …); `INSERT/upsert RETURN BEFORE` devolve o estado anterior — o tipo é `App | null`; `id` string vira `RecordId` no payload.
26. **Records no `where`**: string `"tabela:id"` em coluna de record (inclusive `id`) é convertida para `RecordId` pelo compiler — sem isso o valor viraria string e não casaria nada (silent no-match).
27. **`include` de link**: `FETCH` é a última cláusula, o link precisa estar na seleção (o compiler o adiciona quando necessário), alias projetado sobrevive ao FETCH, e o filtro do include é o split edge/target (`->(edge WHERE …)->(target WHERE …)`).
28. **`include` de aresta**: registros do alvo só via subquery; direção `in` inverte as duas setas (`<-edge<-target`) e materializa `in.*`; `edge`+`target` usa `out.*`+`WHERE out.<campo>` e é remontado como `{ edge, target }` no client. Direção `both`: `<->edge<->target` funciona para o alvo e `<->edge` para as arestas, mas `edge`+`target` é recusado (não existe um alias único de alvo; `?.*` é parse error).
29. **`include._count`**: `count(->edge)`/`count(<-edge)`/`count(->edge[WHERE …])` para arestas e `count(campo)`/`count(campo[WHERE …])` para links array (`array::len` erra em `NONE`); remontado como `_count: { <chave>: n }`.
30. **`where` relacional**: `is`/`isNot` para link `one` (negação verdadeira em `NONE`), `some`/`none`/`every` para arestas e links array; `every` por igualdade de contagens; `NOT` em filtro de traversal exige parênteses.
31. **`include` de grafo recusa** `value`/`groupBy`/`groupAll`/`split` e `orderBy` fora da projeção do alvo (o servidor exige o order idiom).
32. **Link projetado sem `id`**: o compiler sempre projeta o `id` do link (leaf de presença, escondido do resultado) — sem ele um link ausente seria indistinguível de um objeto de campos nulos. Link ausente decodifica `null`; array ausente, `[]`.
33. **Filtro de edge wildcard**: `->(? WHERE score > 4)` (forma emitida) e `->?[WHERE score > 4]` filtram; a forma chaveada `->?` sem filtro devolve as arestas.
34. **`where` relacional em writes**: `updateMany`/`deleteMany`/`unrelateMany` compilam o MESMO lowering dos reads (o `SchemaIndex` flui para o compiler de escrita). `update`/`delete`/`patch`/`upsert` singulares continuam exigindo `id` ou índice UNIQUE.
35. **Live args**: `where`/`select`/`fetch`/`diff` compilam para `LIVE SELECT`; `diff` é exclusivo de `select`; `only`/`value`/`orderBy`/`limit`/`group`/`split`/`include` respondem `ClauseNotSupportedInLive`; live em tx responde `LiveInTransaction`; HTTP responde `LiveQueryUnsupported`.
36. **Live lifecycle**: a live é compilada por NÓS (binds preservados) e as notificações vêm de `liveOf(uuid)`; `kill()` é idempotente; `RECONNECTED` é extensão do ORM no evento `connected` (re-executa a LIVE e reassina); KILL pelo ORM usa `KILL $p` com a string validada.
37. **Notificações**: `recordId` preserva `RecordId` (consistente com as rows decodificadas); `diff: true` entrega os patch ops em `diff`; um registro que sai do filtro não emite nada (documentado).
38. **Changefeeds**: `changes()` emite `SHOW CHANGES FOR TABLE|DATABASE SINCE <literal> LIMIT n` com o `since` inline (versionstamp/número/bigint ou `d'…'`) e normaliza `update` (CREATE/UPDATE), `{current, update}`, `delete` e `define_table`; paginação por `versionstamp + 1` (SINCE é inclusivo); prefira versionstamp a datas.
39. **Transações**: só `mode: 'sdk'` (`beginTransaction`/`commit`/`cancel` do SDK) — `mode: 'sql'` falha rápido com `UnsupportedCapability` (BEGIN não sobrevive entre RPCs); batch wrappers pulam o `BEGIN` implícito dentro da tx; aninhada = mesma tx; reentrada pelo client raiz → `TransactionAlreadyActive`; write conflict é retryável (`WriteConflict`); `timeout` é deadline client-side com `cancel`.
40. **HTTP vs WebSocket**: live e transação exigem o engine WebSocket; sobre HTTP os erros normalizam para `LiveQueryUnsupported`/`UnsupportedCapability`.
41. **Contexto (`$withContext`)**: `USE NS … DB …;` prefixado na MESMA operação escopa sem tocar a sessão; o lado faltante (NS ou DB) herda da sessão (`conn.namespace`/`database`) e a ausência de ambos é `ValidationError`; o override por chamada (`context: { database }`) vence o clone. Operações presas à sessão (`api`/`auth`/`export`/`live`) falham rápido com `UnsupportedCapability` num clone por prefixo; `$withContext({ auth })` forka uma sessão (Promise) para escopar essas operações.
42. **Raw**: `$raw` (1 statement) e `$query` (N) parametrizam `${…}` via `renderValue` (fragmento compõe, valor binda); `$query({ throwOnError: false })` devolve `StatementResult[]`; `$unsafe` exige `raw.unsafe: true` (`UnsafeDisabled`); `raw.requireComment` exige `meta.comment` em script de escrita; `raw.timeoutMs` só aplica a statement única com verbo compatível.
43. **`fn`/`api`/`auth`/admin**: `fn.call` compila `RETURN fn::x($p…)` (nome validado, nunca spliced) + atalho tipado por `defineFunction` (args NOMEADOS → posicionais); `api.*` desembrulha `body` e lança `DatabaseError` com `status`/`details` em `>= 400`; `auth.*` é passthrough da sessão (`record()` sem record access → `NotAuthenticated`); `info` compila `INFO FOR …`, `ping` faz `RETURN true`, `import` reexecuta o dump por `query()`.
44. **`extends`**: helpers são reaplicados em clones (`$withContext`/`forkSession`) e no client de transação; colisão de nome com a superfície do client = `PluginError` fail-fast.
