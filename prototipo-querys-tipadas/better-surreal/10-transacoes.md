# 10 — Transações

O SurrealDB executa **tudo em transação** por baixo, mas também expõe transações explícitas
(`BEGIN TRANSACTION ... COMMIT/CANCEL TRANSACTION`, ou `beginTransaction()` no SDK v2). O
better-surreal embrulha isso numa API de callback, com o **client inteiro** disponível dentro.

## `client.transaction`

```ts
const transfer = await client.transaction(async (tx) => {
	const from = await tx.accounts.update({
		where: { id: 'accounts:aeon' },
		mode: 'set',
		data: { balance: surql`balance - ${100}` },
		return: 'after',
	}).throw();

	await tx.accounts.update({
		where: { id: 'accounts:landevin' },
		mode: 'set',
		data: { balance: surql`balance + ${100}` },
	});

	return from;
});
```

```surql
BEGIN TRANSACTION;
UPDATE accounts SET balance = balance - $p0 WHERE id = $p1 RETURN AFTER;
UPDATE accounts SET balance = balance + $p2 WHERE id = $p3;
COMMIT TRANSACTION;
```

- O callback recebe `tx`: um client better-surreal **completo** (delegates, `relate`, `$raw`,
  `fn.call`, `live`, plugins e hooks), bound à transação.
- **Sucesso** → `commit()`. **Qualquer exceção** → `cancel()` automático e o erro é propagado
  (sem commit parcial).
- O valor de retorno do callback é o retorno de `client.transaction`.

## Rollback explícito

```ts
await client.transaction(async (tx) => {
	const user = await tx.users.create({ data: { name: 'Aeon' } });

	if (!user.email) {
		tx.rollback('email obrigatório em produção');   // cancela a transação
	}

	return user;
});
```

```ts
class BetterSurrealTransactionRollbackError extends BetterSurrealError {
	code = 'TransactionRollback';
	reason: unknown;
}
```

- `tx.rollback(reason)` lança o sinal interno que o wrapper converte em `cancel()` +
  `BetterSurrealTransactionRollbackError` (parecido com o better-drizzle).
- Capturar? Se você quer tratar o rollback como fluxo normal:

```ts
try {
	await client.transaction(async (tx) => { tx.rollback('validação'); });
} catch (err) {
	if (isTransactionRollback(err)) return { ok: false, reason: err.reason };
	throw err;
}
```

## `afterCommit` e `afterRollback`

Efeitos colaterais só depois do desfecho (enviar e-mail, invalidar cache, publicar evento):

```ts
await client.transaction(async (tx) => {
	const order = await tx.orders.create({ data: orderData });

	await tx.stock.update({
		where: { sku: order.sku },
		data: { reserved: surql`reserved + 1` },
	});

	tx.afterCommit(() => mailer.send('Pedido confirmado', order.id));
	tx.afterRollback(() => metrics.increment('orders.failed'));

	return order;
});
```

- Os callbacks herdam o `meta`/`context` da transação.
- Se um `afterCommit` lançar, o erro não desfaz o commit (é reportado via `onError` hook).
- `client.afterCommit(cb)` no client raiz registra no **escopo corrente** — dentro de `tx`, é o
  mesmo que `tx.afterCommit(cb)`.

## Retries em write conflict

SurrealDB usa transações **otimistas**: sob concorrência, um commit pode falhar com
`write conflict`. Retry é configurável por transação (ou no client):

```ts
const result = await client.transaction(run, {
	retries: {
		attempts: 5,
		on: ['writeConflict'],            // default: só write conflict
		delayMs: (attempt) => attempt * 25,
		jitter: true,
	},
});
```

```ts
// default do client
betterSurreal(db, {
	schema,
	transaction: { retries: { attempts: 3, delayMs: 50 } },
});
```

- O retry **re-executa o callback inteiro** (com rollback do attempt anterior) — por isso o
  callback deve ser puro/reativo: nada de efeitos externos diretos (use `afterCommit`).
- `on` também aceita `'serializationFailure'` (quando o erro se apresenta assim) e
  `'connectionError'`.
- `retry: { on: [...] }` por chamada de operação também existe para casos individuais fora de
  transação multi-statement: `client.users.update({ ..., retry: { attempts: 3 } })`.

## Transações aninhadas

O SurrealDB **não tem savepoints**. O better-surreal é explícito:

```ts
await client.transaction(async (tx) => {
	const a = await tx.users.create({ data: { name: 'A' } });

	// aninhada: roda na MESMA transação (sem savepoint, sem commit parcial)
	await tx.transaction(async (inner) => {
		await inner.tags.create({ data: { userId: a.id, name: 'x' } });
	});

	return a;
});
```

- `tx.transaction()` devolve um client do mesmo escopo; `inner.rollback()` cancela **a transação
  toda** (comportamento real do SurrealDB).
- Tentar `client.transaction()` com o client raiz **dentro** de uma transação em andamento lança
  `TransactionAlreadyActive` — use o `tx` recebido.

## Modo SQL (`BEGIN/COMMIT/CANCEL`)

Para ambientes/versões em que a transação gerenciada do SDK não estiver disponível, ou quando você
quer o controle literal dos statements:

```ts
const client = betterSurreal(db, {
	schema,
	transaction: { mode: 'sql' },     // default: 'sdk'
});

await client.transaction(async (tx) => {
	await tx.users.create({ data: { name: 'Aeon' } });
});
```

```surql
BEGIN TRANSACTION;
CREATE users CONTENT $p0;
COMMIT TRANSACTION;
-- no erro/rollback:
CANCEL TRANSACTION;
```

- `mode: 'sdk'` usa `db.beginTransaction()` + `txn.commit()`/`txn.cancel()`.
- `mode: 'sql'` compila os statements de transação — útil para servidores 2.x sem
  transação gerenciada no SDK, e para debug do SurrealQL gerado.
- Os dois modos são observáveis nos hooks (`beforeTransaction`/`afterTransactionCommit`).

## Opções da transação

```ts
await client.transaction(run, {
	mode: 'sdk' | 'sql',        // override do default
	retries: { ... },           // ver acima
	timeout: '30s',             // TIMEOUT aplicado aos statements
	context: { reason: '...' }, // metadata para hooks/plugins
	isolation: 'snapshot',      // quando suportado (senão ignora com aviso)
	onUnsupported: 'warn' | 'throw' | 'ignore',   // default: 'warn'
});
```

## Erros e garantias

| Situação | O que acontece |
| --- | --- |
| Exceção no callback | `cancel()` + erro propagado (`statementIndex` incluso) |
| `tx.rollback(reason)` | `cancel()` + `BetterSurrealTransactionRollbackError` |
| Write conflict | retry conforme `retries`; esgotou → `WriteConflict` |
| `afterCommit` falha | commit permanece; hook `onError` é chamado |
| `BEGIN`/`COMMIT` não suportado no modo `sdk` | fallback para `'sql'` com aviso (ou erro se `onUnsupported: 'throw'`) |

> Regra de ouro: efeitos fora do banco sempre em `afterCommit`; cálculo e leitura podem ficar dentro.
> O retry re-executa o callback, então nada de `fetch` externo no meio da transação.
