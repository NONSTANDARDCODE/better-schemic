# 12 — Raw, funções e APIs do banco

A API tipada cobre o dia a dia — mas SurrealQL é expressivo demais para caber 100%. Estes são os
escape hatches, todos **parametrizados por default**.

## `$raw` — um statement

```ts
const users = await client.$raw<User[]>`
	SELECT * FROM users WHERE email = ${email}
`;
```

```surql
SELECT * FROM users WHERE email = $p0;
-- vars: { p0: 'aeon@surreal.db' }
```

- Tagged template: cada `${...}` vira um parâmetro ligado (`$p0`, `$p1`, ...).
- Também aceita um `BoundQuery`/`surql` do SDK: `client.$raw(surql`SELECT ... WHERE id = ${id}`)`.
- Retorna o resultado do **primeiro statement** (tipado pelo generic).
- Opções: `client.$raw(sql, { timeout: '5s', meta: {...} })`.

## `$query` — vários statements

```ts
const [users, posts, total] = await client.$query<[User[], Post[], { count: number }[]]>`
	SELECT * FROM users LIMIT 10;
	SELECT * FROM posts LIMIT 10;
	SELECT count() FROM posts GROUP ALL;
`;
```

- Sem `throwOnError: false`, qualquer statement com erro lança `BetterSurrealError` com
  `statementIndex` e o SurrealQL/vars do statement problemático.
- Com `{ throwOnError: false }`, você recebe o array cru de `StatementResult<T>`:

```ts
const results = await client.$query<[User[]]>(...sql, { throwOnError: false });
// results: [{ result, status: 'OK' | 'ERR', time, error? }, ...]
```

### LET, IF/ELSE, FOR

```ts
const [result] = await client.$query<[{ count: number }[]]>`
	LET $threshold = ${1000};
	LET $heavy = (SELECT VALUE id FROM customers WHERE orders > $threshold);
	IF array::len($heavy) > 0 THEN
		UPDATE $heavy SET tier = 'vip';
	ELSE
		RETURN 'nada a fazer';
	END;
`;
```

```ts
const [byCity] = await client.$query<unknown[]>`
	FOR $city IN ${['Paris', 'Lisboa', 'São Paulo']} {
		CREATE city_audit CONTENT { city: $city, at: time::now() };
	};
`;
```

## `$unsafe` — string crua (desligado por default)

```ts
const client = betterSurreal(db, { schema, raw: { unsafe: true } });

await client.$unsafe(`SELECT * FROM users WHERE id = "users:aeon";`);
```

- Sem `raw.unsafe: true`, qualquer chamada lança `UnsafeDisabled`.
- O plugin `@better-surreal/rules` no preset `recommended` mantém `noRawUnsafe` ligado mesmo que a
  opção esteja habilitada.
- `$unsafe` ainda aceita parâmetros: `client.$unsafe<Row[]>('SELECT * FROM users WHERE id = $id', { id })`.

## `surql` dentro da API tipada

Fragments podem ser usados em `where`, `select`, `data` e `orderBy` — o melhor dos dois mundos:

```ts
import { surql } from 'surrealdb';

await client.orders.update({
	where: {
		status: 'open',
		createdAt: surql`< time::now() - 30d`,
	},
	mode: 'set',
	data: {
		status: 'expired',
		expiredAt: surql`time::now()`,
	},
});

await client.posts.findMany({
	select: {
		'*': true,
		rank: surql`math::round(score * ${0.7} + comments * ${0.3}, 2)`,
	},
	orderBy: [surql`rank DESC`],
});
```

```surql
UPDATE orders SET status = $p0, expiredAt = time::now()
WHERE status = $p1 AND createdAt < time::now() - 30d;

SELECT *, math::round(score * $p0 + comments * $p1, 2) AS rank
FROM posts ORDER BY rank DESC;
```

## Funções definidas no banco (`fn::`)

Seu schema/tooling pode definir funções no servidor:

```surql
DEFINE FUNCTION fn::customer_tier($total: number) {
	RETURN IF $total > 10000 THEN 'gold'
	       ELSE IF $total > 1000 THEN 'silver'
	       ELSE 'bronze' END;
};
```

```ts
const tier = await client.fn.call<string>('fn::customer_tier', [15000]);
// 'gold'

// dentro de transação: mesma API
await client.transaction(async (tx) => {
	const t = await tx.fn.call<string>('fn::customer_tier', [balance]);
	await tx.customers.update({ where: { id }, data: { tier: t }, mode: 'set' });
});
```

- `client.fn.call(name, args)` aceita função pública (`fn::`) e métodos de módulo.
- Há um atalho tipado quando o schema declara as funções:
  `client.fn.customerTier(15000)`.

## APIs do banco (`DEFINE API`)

Endpoints customizados definidos no servidor:

```surql
DEFINE API "/articles" FOR get THEN {
	RETURN SELECT * FROM article ORDER BY publishedAt DESC;
};

DEFINE API "/articles" FOR post THEN {
	CREATE article CONTENT $request.body;
};
```

```ts
const articles = await client.api.get<Article[]>('/articles', {
	query: { limit: '10' },                    // ?limit=10
	headers: { 'accept-language': 'pt-BR' },
});

await client.api.post('/articles', { body: { title: 'SurrealDB' } });
await client.api.put('/articles/1', { body: { title: 'Novo' } });
await client.api.patch('/articles/1', { body: { published: true } });
await client.api.delete('/articles/1');
```

- `client.api.*` chama o suporte nativo do SDK v2 e passa pela sessão/autenticação corrente.
- `$request.body`, `$request.query`, `$request.headers` são resolvidos no servidor.
- Erros HTTP viram `BetterSurrealError` com `status` (ex.: 400/401/404) e o corpo em `details`.

## Outros utilitários

```ts
await client.$raw`SLEEP 1s;`;                  // espera no servidor (útil em testes)
const info = await client.info('table', 'users');
const version = await client.version();
const dump = await client.export();             // dump binário/texto do banco
await client.import(dump);                      // restore
```

## `$sdk` — o escape final

```ts
const raw = client.$sdk;    // o Surreal original

await raw.query('DEFINE INDEX ...');
await raw.live(new Table('users'));
await raw.close();
```

- Use `$sdk` para o que a API não cobre **e** para migrações/administração.
- Dentro de `tx`, `tx.$sdk` é a transação do SDK (`SurrealTransaction`) — cuidado para não misturar
  contextos.

## Regras de segurança do raw

| Regra | Efeito |
| --- | --- |
| `$raw`/`$query` parametrizados | default; interpolção vira variável ligada |
| `$unsafe` | só com `raw.unsafe: true` **e** fora de `rules.noRawUnsafe` |
| `comment` obrigatório | `raw.requireComment: true` exige `meta.comment` em raw não trivial |
| `timeout` default | `raw.timeoutMs` aplica `TIMEOUT` a raw sem timeout explícito |
| Auditoria | hooks `beforeRaw/afterRaw/onRawError` recebem `surql`, `vars` e duração |
