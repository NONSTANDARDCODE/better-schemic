# 11 — Live queries e changefeeds

O SurrealDB pode **empurrar mudanças** para o cliente (live queries) e **registrar histórico** de
mutações (changefeeds). O better-surreal expõe os dois com tipos e ciclo de vida gerenciado.

## `live()` — assinatura de mudanças

```ts
const sub = await client.users.live(
	{ where: { active: true }, diff: true, fetch: ['avatar'] },
	(change) => {
		switch (change.action) {
			case 'CREATE': return cache.add(change.value);
			case 'UPDATE': return cache.replace(change.value);
			case 'DELETE': return cache.remove(change.recordId);
		}
	},
);

// ... depois
sub.kill();
```

```surql
LIVE SELECT * FROM users WHERE active = $p0 DIFF FETCH avatar;
-- retorna o uuid da live query
-- eventos chegam como: { action: 'CREATE' | 'UPDATE' | 'DELETE', result, recordId }
```

```ts
type LiveNotification<Row> = {
	action: 'CREATE' | 'UPDATE' | 'DELETE';
	value: Row | null;             // null em DELETE (com diff: false)
	recordId: string;              // 'users:aeon'
	diff?: JsonPatchOperation[];   // presente com diff: true
	uuid: string;                  // uuid da live query
	result?: unknown;              // payload cru quando não modelado
};

type LiveSubscription<Row> = {
	uuid: string;
	kill(): Promise<void>;
	[Symbol.asyncIterator](): AsyncIterator<LiveNotification<Row>>;
};
```

### Iteração assíncrona

```ts
const sub = await client.users.live({ where: { active: true } });

for await (const change of sub) {
	console.log(change.action, change.recordId);
}
```

### Forma dinâmica

```ts
const sub = await client.live('users', { where: { role: 'admin' } }, handler);
```

Útil para nomes de tabela dinâmicos (`client.repository('users')` também tem `.live`).

## Requisitos e ciclo de vida

| Requisito | Detalhe |
| --- | --- |
| Transporte | **WebSocket** (`ws://`/`wss://`). Em HTTP a API lança `LiveQueryUnsupported`. |
| Feature check | Com `live: { checkFeature: true }` (default), usa `Features.LiveQueries` do SDK. |
| Reconexão | Com `live: { reconnect: true }` (default), assinaturas criadas pelo better-surreal são **re-assinadas** após reconexão e o handler recebe um evento `{ action: 'RECONNECTED' }` (extensão do better-surreal, fora do padrão do SDK). |
| `kill()` | Encerra a live query no servidor e libera listeners. Idempotente. |
| Escopo | `tx.live()` dentro de transação **não** é suportado (`code: 'LiveInTransaction'`). |

## Opções do `live`

```ts
await client.posts.live({
	where: { published: true },
	select: { id: true, title: true },
	diff: true,                 // LIVE SELECT ... DIFF
	fetch: ['author'],          // LIVE SELECT ... FETCH author
	only: false,
	meta: { channel: 'posts' },
}, handler);
```

```surql
LIVE SELECT id, title FROM posts WHERE published = $p0 DIFF FETCH author;
```

- `where`, `select`, `fetch`, `diff` compilam direto no `LIVE SELECT`.
- `orderBy`/`limit`/`group` não fazem sentido em live queries → rejeitados
  (`code: 'ClauseNotSupportedInLive'`).

## Gerenciadas vs não gerenciadas

| | Gerenciada (`client.live(table)`) | Não gerenciada (`$raw` + `liveOf`) |
| --- | --- | --- |
| Usa | `LIVE SELECT * FROM table` | qualquer `LIVE SELECT` |
| `where` custom | não | sim |
| Re-assina após reconexão | sim | não (você re-assina) |
| API | `client.users.live({ where }, cb)` usa a forma **não gerenciada** internamente para suportar `where`; ainda assim re-assina quando `reconnect: true` | — |

Para reatar a uma live query existente:

```ts
const sub = await client.liveOf(uuid, handler);
await client.kill(uuid);      // encerra no servidor
```

## `changes()` — changefeeds (`SHOW CHANGES`)

Changefeeds são definidos **no schema** (`DEFINE TABLE person CHANGEFEED 3d [INCLUDE ORIGINAL];`).
O better-surreal apenas lê o histórico:

```ts
const changes = await client.changes({
	table: 'person',
	since: 0,                    // versionstamp ou Date/ISO
	limit: 10,
});
```

```surql
SHOW CHANGES FOR TABLE person SINCE 0 LIMIT 10;
```

```ts
const dbChanges = await client.changes({
	since: '2025-06-01T00:00:00Z',
	limit: 100,
});
```

```surql
SHOW CHANGES FOR DATABASE SINCE d'2025-06-01T00:00:00Z' LIMIT 100;
```

Resultado (normalizado a partir do formato do servidor) — um array com uma entrada por
`versionstamp`:

```ts
type ChangeSet<Row> = {
	versionstamp: number | bigint;
	changes: Array<{
		action: 'CREATE' | 'UPDATE' | 'DELETE';
		recordId: string;
		value?: Row;          // presente com INCLUDE ORIGINAL ou em CREATE
		before?: Row;         // com INCLUDE ORIGINAL
		diff?: JsonPatchOperation[];
	}>;
};
```

- `since: 0` = desde o início do changefeed (o changefeed precisa ter sido definido **antes**).
- `INCLUDE ORIGINAL` no `DEFINE TABLE` faz o servidor enviar o valor anterior em `before`.
- Sem `table`, usa `SHOW CHANGES FOR DATABASE`.
- Paginação por `versionstamp`: use o último `versionstamp` recebido como `since` da próxima página.

## Live + changes: padrões úteis

```ts
// Cache local sempre quente + reconciliação pelo changefeed após reconexão
const sub = await client.users.live({ where: { active: true }, diff: true }, (c) => {
	applyToCache(c);
});

// Após uma reconexão do SDK (evento de conexão do Surreal), reconcilie o cache:
const desde = cache.lastVersionstamp;
const lote = await client.changes({ table: 'users', since: desde, limit: 1000 });
reconcile(cache, lote);
```

```ts
// Auditoria em tempo real
const sub = await client.accounts.live({ diff: true }, async (c) => {
	await client.auditLog.insert({
		data: {
			action: c.action,
			record: c.recordId,
			diff: c.diff ?? null,
			at: surql`time::now()`,
		},
	});
});
```

> Live queries não substituem transações nem garantem *exactly-once*: trate notificações como
> "revalide isto" e leia o estado atual quando a consistência importar.
