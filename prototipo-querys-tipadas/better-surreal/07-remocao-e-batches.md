# 07 — Remoção e operações em lote

## `delete`

```ts
const removed = await client.users.delete({
	where: { id: 'users:aeon' },
	return: 'before',       // 'before' (default) | 'none'
});
// tipo: ThrowingResult<User>
```

```surql
DELETE users:aeon RETURN BEFORE;
```

- Com `id` no `where`, o alvo é direto: `DELETE users:aeon;`.
- Com outros campos: `DELETE FROM users WHERE ... RETURN BEFORE;`.
- `RETURN AFTER` não existe em `DELETE` (o registro não está mais lá); `'after'` é rejeitado com
  `code: 'ReturnNotSupported'`.
- `return: 'none'` economiza payload → o tipo vira `ThrowingResult<null>`.

```ts
await client.users.delete({
	where: { email: { endsWith: '@old.example' } },
	return: 'none',
});
```

```surql
DELETE FROM users WHERE string::ends_with(email, $p0) RETURN NONE;
```

### `deleteMany`

```ts
const result = await client.posts.deleteMany({
	where: { published: false, createdAt: { lt: new Date('2020-01-01') } },
});
// result.count → quantos foram removidos
```

```surql
DELETE FROM posts WHERE published = $p0 AND createdAt < $p1 RETURN BEFORE;
```

- Sem `where`, remove **todos** os registros da tabela — bloqueado por padrão pelo plugin `rules`
  no preset `recommended` (`destructiveWriteWithoutWhere`).
- Para deletar a tabela inteira de forma explícita: `client.posts.deleteMany({ all: true })`.
- `REMOVE TABLE` é responsabilidade da ferramenta de schema (ou `$raw`), não do delegate.

### Cascatas

`DEFINE FIELD ... REFERENCE ON DELETE CASCADE | REJECT | IGNORE` (definido no seu schema) é aplicado
**pelo servidor** — links e arestas que apontam para o registro removido seguem a política do schema.
O better-surreal não emula cascata no client.

## `updateEach` — atualização por registro

Ideal quando cada linha do lote tem seus próprios valores (importações, sincronização, correções
em massa). Compila **um `FOR` + `UPDATE ... WHERE by = ...` por item**, tudo em um round-trip.

```ts
const result = await client.users.updateEach({
	by: 'id',                          // campo alvo (default: 'id')
	data: [
		{ id: 'users:aeon', age: 31 },
		{ id: 'users:landevin', age: 28 },
	],
	mode: 'merge',                     // 'merge' (default) | 'set' | 'patch' | 'content'
	select: { id: true, age: true },
	onEmpty: 'return',                 // 'return' (default) | 'throw'
});
```

```surql
BEGIN TRANSACTION;
FOR $row IN $p0 {
	UPDATE users MERGE $row.fields WHERE id = $row.by;
};
COMMIT TRANSACTION;
-- vars: { p0: [
--   { by: users:aeon,     fields: { age: 31 } },
--   { by: users:landevin, fields: { age: 28 } },
-- ] }
```

- `by` aceita qualquer campo não-único (`email`, `sku`, `externalId`).
- `mode: 'set'` compila `UPDATE users SET campo = $row.fields.campo WHERE by = $row.by`.
- `mode: 'patch'` espera `patches` por item (JSON Patch).
- `onEmpty: 'throw'` lança `ResultNotFound` se algum `by` não casar com registro nenhum; com
  `'return'`, esses itens aparecem em `result.skipped`.
- `return: 'after'` devolve `result.data` na mesma ordem dos inputs.

## Semântica de lotes e atomicidade

Toda operação em lote (`createMany`, `insertMany`, `updateMany`, `updateEach`, `upsertMany`,
`deleteMany`) segue as mesmas regras:

| Regra | Comportamento |
| --- | --- |
| Round-trip | **1** `db.query` com N statements (nunca N queries separadas). |
| Atomicidade | Fora de transação: `BEGIN/COMMIT` implícito (`transaction.mode` controla a forma). Dentro de `client.transaction`: usa a transação corrente, sem aninhar. |
| Erros | Qualquer statement com erro aborta o restante e faz rollback (quando implícito). O erro inclui `statementIndex` e `surql`. |
| Retorno | `BatchResult<T>`: `{ count, data? }`. `count` = registros afetados; `data` só existe quando `return` devolve registros. |
| `return: 'none'` | `data` ausente e payload mínimo — recomendado para lotes grandes. |
| Ordem | `data` segue a ordem de entrada quando o driver preserva; use `orderBy` no `select` para ordem determinística. |

```ts
type BatchResult<T> = {
	count: number;
	data?: T[];
	skipped?: number;      // itens ignorados (ex.: onEmpty: 'return', skipDuplicates)
	statements: number;    // quantos statements foram compilados (telemetria)
};
```

### `skipDuplicates` em batch

Disponível em `createMany` (não em `create`, que falha por definição):

```ts
await client.users.createMany({
	data: seedUsers,
	skipDuplicates: true,       // CREATE só se o id não existir
});
```

```surql
FOR $row IN $p0 {
	LET $existing = (SELECT VALUE id FROM users WHERE id = $row.id LIMIT 1);
	IF array::len($existing) = 0 THEN
		CREATE $row.id CONTENT $row.fields;
	END;
};
```

> Quando os dados já vêm com ids e você quer idempotência, `insertMany({ onDuplicate: 'ignore' })`
> é mais eficiente que `createMany({ skipDuplicates: true })` — single statement + `INSERT IGNORE`.

### Telemetria e hooks

Todos os lotes passam pelos hooks (`beforeCreate/afterCreate`, `beforeDelete/afterDelete`, etc.) e
pelos plugins (`transform` roda **uma vez por lote**, com `op.items[]`). O contador `statements`
permite medir o custo real do lote em hooks de performance.

## `RETURN` por operação — resumo

| Operação | `before` | `after` | `diff` | `none` |
| --- | --- | --- | --- | --- |
| `create` | ✓ (vazio) | ✓ default | ✓ | ✓ |
| `insert` | ✓ (vazio) | ✓ default | ✓ | ✓ |
| `update` | ✓ | ✓ default | ✓ | ✓ |
| `upsert` | ✓ | ✓ default | ✓ | ✓ |
| `delete` | ✓ default | ✗ | ✗ | ✓ |

## Proteções

- `deleteMany`/`updateMany` sem `where` são bloqueados no preset `recommended` do
  [`@better-surreal/rules`](./13-plugins-hooks-e-erros.md); libere com `all: true` explícito.
- `strict: true` no client rejeita campos/tabelas desconhecidos **antes** de compilar.
- `meta.reason` pode ser exigido por hooks de auditoria em mutações:
  `client.users.deleteMany({ where, meta: { reason: 'LGPD: expurgo' } })`.
