# 06 — Atualização e upsert

Aqui estão `update`, `updateMany`, `upsert` e `upsertMany` — o coração das mutações. O SurrealDB é
rico nesse departamento: `SET`, `MERGE`, `CONTENT`, `REPLACE`, `PATCH`, `UNSET`, `UPSERT`,
`INSERT ... ON DUPLICATE KEY UPDATE` e `IF/ELSE`. A API expõe todos com um único objeto de args.

> **Cuidado importante do SurrealDB**: `UPDATE <record id>` **cria** o registro se ele não existir.
> Para manter a semântica "update só atualiza", o better-surreal compila updates com `WHERE`
> (`UPDATE users MERGE $data WHERE id = users:john;`), que devolve array vazio quando nada casa —
> e `update` retorna `null` (ou `.throw()`). Quem quer criar-ou-atualizar usa `upsert`.

## `update`

```ts
const user = await client.users.update({
	where: { id: 'users:aeon' },
	data: { lastSeen: new Date(), active: true },
	mode: 'merge',        // 'merge' (default) | 'set' | 'content' | 'replace'
	return: 'after',
});
// tipo: ThrowingResult<UpdatedUser>
```

### Modos

| `mode` | SurrealQL | Semântica |
| --- | --- | --- |
| `'merge'` (default) | `UPDATE ... MERGE $data` | merge profundo (objetos aninhados mesclam) |
| `'set'` | `UPDATE ... SET campo = $p` | seta apenas os campos passados (sem merge profundo) |
| `'content'` | `UPDATE ... CONTENT $data` | substitui o conteúdo inteiro (preserva o id) |
| `'replace'` | `UPDATE ... REPLACE $data` | substitui o registro inteiro |
| `'patch'` | `UPDATE ... PATCH $ops` | JSON Patch (array de operações) |

```ts
// merge (default): só os campos enviados mudam; objetos mesclam
await client.users.update({
	where: { id: 'users:aeon' },
	data: { address: { city: 'Paris' } },     // mantém address.country se existir
});
```

```surql
UPDATE users MERGE $p0 WHERE id = $p1;
-- vars: { p0: { address: { city: 'Paris' } }, p1: users:aeon }
```

```ts
// set: atribuição direta por campo
await client.users.update({
	where: { id: 'users:aeon' },
	mode: 'set',
	data: { active: false, age: 31 },
});
```

```surql
UPDATE users SET active = $p0, age = $p1 WHERE id = $p2;
```

```ts
// content: substitui o conteúdo preservando o id
await client.users.update({
	where: { id: 'users:aeon' },
	mode: 'content',
	data: { name: 'Aeon', email: 'aeon@surreal.db', active: true },
});
```

```surql
UPDATE users CONTENT $p0 WHERE id = $p1;
```

### `where` que não é id

```ts
await client.users.updateMany({
	where: { email: { endsWith: '@inactive.example' } },
	data: { active: false },
});
```

```surql
UPDATE users MERGE $p0 WHERE string::ends_with(email, $p1);
```

### `unset` — remover campos

```ts
await client.users.update({
	where: { id: 'users:aeon' },
	unset: ['temporaryToken', 'resetCode'],
});
```

```surql
UPDATE users UNSET temporaryToken, resetCode WHERE id = $p0;
```

- `unset` pode ser combinado com `data`: o better-surreal emite `SET/MERGE` + `UNSET` como **dois
  statements no mesmo round-trip** (o SurrealQL não garante `SET` e `UNSET` no mesmo statement):

```ts
await client.users.update({
	where: { id: 'users:aeon' },
	data: { active: true },
	unset: ['banReason'],
});
```

```surql
BEGIN TRANSACTION;
UPDATE users SET active = $p0 WHERE id = $p1;
UPDATE users UNSET banReason WHERE id = $p1;
COMMIT TRANSACTION;
```

### `patch` — JSON Patch

```ts
await client.users.patch({
	where: { id: 'users:aeon' },
	patches: [
		{ op: 'replace', path: '/address/city', value: 'Lisboa' },
		{ op: 'add', path: '/tags/-', value: 'surreal' },
		{ op: 'remove', path: '/temporaryToken' },
	],
});
```

```surql
UPDATE users PATCH $p0 WHERE id = $p1;
-- vars: { p0: [ { op: 'replace', path: '/address/city', value: 'Lisboa' }, ... ] }
```

- `patch` também aceita `mode: 'patch'` no `update` (equivalente).
- `RETURN DIFF` combina perfeitamente com patch para auditar o que mudou.

## `updateMany`

```ts
const result = await client.users.updateMany({
	where: { active: false, lastSeen: { lt: new Date('2023-01-01') } },
	data: { archived: true },
	mode: 'merge',
	return: 'after',
});
// result.count → quantos atualizou
// result.data  → registros (com RETURN AFTER)
```

```surql
UPDATE users MERGE $p0 WHERE active = $p1 AND lastSeen < $p2 RETURN AFTER;
```

- `where` opcional; **sem `where` atualiza a tabela inteira** — o plugin `rules` pode exigir
  confirmação explícita nesse caso (`destructiveWriteWithoutWhere`).
- Sem `return` (ou `'none'`), devolve `BatchResult` só com `count`.

## Expressões e lógica no update

Valores podem ser fragments `surql` — incrementos, `IF/ELSE`, funções de tempo, etc.:

```ts
await client.accounts.update({
	where: { id: 'accounts:aeon' },
	mode: 'set',
	data: {
		balance: surql`balance - ${100}`,
		lastTransferAt: surql`time::now()`,
		tier: surql`IF balance - ${100} > 10000 THEN 'gold' ELSE 'silver' END`,
	},
});
```

```surql
UPDATE accounts
SET balance = balance - $p0,
    lastTransferAt = time::now(),
    tier = IF balance - $p0 > 10000 THEN 'gold' ELSE 'silver' END
WHERE id = $p1;
```

## `upsert`

O `UPSERT` nativo cria se não existir e atualiza se existir — **sem erro de duplicado**.

### Mesmo payload para criar e atualizar

```ts
const user = await client.users.upsert({
	where: { id: 'users:aeon' },
	data: { name: 'Aeon', active: true, lastSeen: new Date() },
});
```

```surql
UPSERT users:aeon MERGE $p0;
-- (com mode: 'content') UPSERT users:aeon CONTENT $p0;
```

### Payloads distintos: `create` + `update`

Quando o registro **não existe**, usa `create`; quando existe, aplica `update`. A compilação usa
`INSERT ... ON DUPLICATE KEY UPDATE` (quando o alvo é o id) — um único statement:

```ts
await client.users.upsert({
	where: { id: 'users:aeon' },
	create: { id: 'users:aeon', name: 'Aeon', balance: 0, createdAt: surql`time::now()` },
	update: { lastSeen: surql`time::now()`, logins: surql`logins + 1` },
});
```

```surql
INSERT INTO users $create
ON DUPLICATE KEY UPDATE lastSeen = $update.lastSeen, logins = logins + 1;
-- vars: { create: { id: users:aeon, name: 'Aeon', balance: 0, createdAt: ... }, update: {...} }
```

> No `ON DUPLICATE KEY UPDATE`, `$input` referencia o registro do `INSERT` e `$update` o payload de
> atualização; campos sem prefixo referenciam o próprio registro (`logins + 1`).

### Alvo por campo único (sem id)

Quando o alvo é um campo único (ex.: `email`), o better-surreal compila `LET` + `IF/ELSE` para
distinguir criar de atualizar com precisão:

```ts
await client.users.upsert({
	where: { email: 'aeon@surreal.db' },
	create: { email: 'aeon@surreal.db', name: 'Aeon', createdAt: surql`time::now()` },
	update: { lastSeen: surql`time::now()` },
});
```

```surql
LET $existing = (SELECT VALUE id FROM users WHERE email = $p0 LIMIT 1);
IF array::len($existing) = 0 THEN
	CREATE users CONTENT $create;
ELSE
	UPDATE $existing[0] MERGE $update;
END;
-- vars: { p0: 'aeon@surreal.db', create: {...}, update: {...} }
```

- `where` aceita exatamente **um** campo (composto = erro `UniqueTargetRequired`).
- Também funciona com `mode: 'content' | 'set' | 'replace'` no branch de update.

## `upsertMany`

```ts
const result = await client.upsertMany({
	data: [
		{ id: 'users:aeon', name: 'Aeon', balance: 10 },
		{ id: 'users:landevin', name: 'Landevin', balance: 20 },
	],
	update: 'all',        // ou mapeamento, ver abaixo
	return: 'after',
});
```

```surql
INSERT INTO users $p0
ON DUPLICATE KEY UPDATE name = $input.name, balance = $input.balance;
```

- **Com ids nos dados**: compila `INSERT ... ON DUPLICATE KEY UPDATE` (1 statement, idempotente,
  rápido). `update: 'all'` atualiza todos os campos presentes; ou um mapa explícito
  (`{ syncedAt: surql`time::now()` }`).
- **Sem ids**: cada item vira um `UPSERT` no mesmo lote (transação implícita) — exige um
  `conflict: 'email'` por item para resolver o alvo:

```ts
await client.upsertMany({
	data: externalUsers,             // sem id, com email
	conflict: 'email',
	update: { lastSeen: surql`time::now()` },
});
```

```surql
BEGIN TRANSACTION;
LET $e0 = (SELECT VALUE id FROM users WHERE email = $d0.email LIMIT 1);
IF array::len($e0) = 0 THEN CREATE users CONTENT $d0 ELSE UPDATE $e0[0] MERGE $update END;
-- ... repetido para $d1, $d2 ...
COMMIT TRANSACTION;
```

Para volumes grandes, prefira gerar ids determinísticos no seu código (`users:<slug>`)
e usar o caminho de 1 statement.

## `RETURN` em updates/upserts

| `return` | SurrealQL | Observação |
| --- | --- | --- |
| `'after'` (default) | omitido | registros resultantes |
| `'before'` | `RETURN BEFORE` | estado anterior (útil para undo/auditoria) |
| `'diff'` | `RETURN DIFF` | JSON Patch do delta |
| `'none'` | `RETURN NONE` | nada volta (payload mínimo) |

```ts
const antes = await client.users.update({
	where: { id: 'users:aeon' },
	data: { role: 'admin' },
	return: 'before',
});
```

## Cláusulas extras

`update`, `updateMany`, `upsert` e `upsertMany` aceitam `timeout`, `parallel`, `version` e `only`:

```ts
await client.users.update({
	where: { id: 'users:aeon' },
	data: { active: true },
	only: true,               // UPDATE ONLY users:aeon ...
	timeout: '2s',
});
```

```surql
UPDATE ONLY users:aeon MERGE $p0 TIMEOUT 2s;
```

## Erros comuns

| Situação | `code` |
| --- | --- |
| update sem match (id inexistente) | `null` ou `ResultNotFound` com `.throw()` |
| `where` composto em `upsert`/`findUnique` | `UniqueTargetRequired` |
| violação de `ASSERT`/tipo no `MERGE`/`CONTENT` | `AssertionFailed` |
| write conflict concorrente | `WriteConflict` (retry pela transação) |
| update sem `where` em `updateMany` sob `rules` | `UnsafeMutation` |
