# 02 — Client e conexão

## Bootstrap

### Já conectado (recomendado)

```ts
import { Surreal } from 'surrealdb';
import { betterSurreal } from 'better-surreal';

const db = new Surreal();
await db.connect('wss://localhost:8000/rpc');
await db.use({ namespace: 'app', database: 'main' });
await db.signin({ username: 'root', password: 'root' });

const client = betterSurreal(db, { schema: appSchema });
```

`betterSurreal()` é síncrono e não abre conexão: ele apenas constrói o runtime tipado sobre a conexão
existente. Você continua dono do ciclo de vida (`db.connect`, `db.close`).

### Conveniência (conecta e autentica)

```ts
import { createBetterSurreal } from 'better-surreal';

const client = await createBetterSurreal({
	url: 'wss://localhost:8000/rpc',
	namespace: 'app',
	database: 'main',
	auth: { username: 'root', password: 'root' },   // ou { access, variables } p/ record access
	schema: appSchema,
	connectTimeoutMs: 5_000,
});

await client.disconnect(); // fecha a conexão HTTP/WS gerenciada
```

`createBetterSurreal` é só açúcar: cria o `Surreal`, conecta, faz `use`, autentica (se `auth`) e
chama `betterSurreal`. Qualquer opção extra de `betterSurreal` pode ser passada junto.

## Opções

```ts
betterSurreal(db, {
	schema,               // obrigatório: artefato tipado do seu projeto
	plugins: [],          // plugins, na ordem de execução
	hooks: {},            // hooks de observação
	raw: {
		unsafe: false,          // libera $unsafe (default: false)
		requireComment: false,  // exige comment opcional em raw? (default: false)
		timeoutMs: undefined,   // aplica TIMEOUT default em raw
	},
	transaction: {
		mode: 'sdk',            // 'sdk' (beginTransaction) | 'sql' (BEGIN/COMMIT/CANCEL)
		retries: { attempts: 0 }, // defaults de retry para write conflict
	},
	live: {
		checkFeature: true,     // valida Features.LiveQueries antes de assinar
		reconnect: true,        // re-assina live queries gerenciadas após reconexão
	},
	strict: true,             // nomes de tabela/campo desconhecidos = erro em runtime
});
```

## Métodos do client

| Membro | Descrição |
| --- | --- |
| `client.<table>` | delegate da tabela/aresta (`client.users`, `client.likes`). |
| `client.repository('users')` | resolve delegate dinamicamente (útil em código genérico). |
| `client.tables` | lista de nomes de tabelas conhecidas pelo schema. |
| `client.extends(fn \| obj)` | adiciona helpers ao client; reaplicado em `$withContext` e transações. |
| `client.transaction(fn, opts?)` | transação (ver [10-transacoes](./10-transacoes.md)). |
| `client.live(table, args, cb)` | live query dinâmica (delegate: `client.users.live(...)`). |
| `client.changes(args)` | `SHOW CHANGES` do changefeed (ver [11](./11-live-queries-e-changefeeds.md)). |
| `client.fn.call(name, args?)` | executa função definida no banco (`fn::...`). |
| `client.api` | invoca `DEFINE API` do banco (`.get/.post/.put/.patch/.delete`). |
| `client.auth` | `signin`, `signup`, `authenticate`, `invalidate`, `record`. |
| `client.$withContext(ctx)` | clona o client com namespace/database (e metadata) padrão. |
| `client.$raw` / `$query` / `$unsafe` | SurrealQL parametrizado (ver [12](./12-raw-funcoes-e-apis.md)). |
| `client.info(level, table?)` | `INFO FOR ROOT/NS/DB/TABLE`. |
| `client.version()` / `client.ping()` | versão do servidor / health check. |
| `client.export()` / `client.import(data)` | dump/restore (passthrough do SDK). |
| `client.afterCommit(cb)` / `afterRollback(cb)` | callbacks do escopo de transação corrente. |
| `client.$sdk` | o `Surreal` original, para qualquer coisa fora da API. |

## `$withContext` — namespace/database por escopo

`USE NS/DB` é parte do contexto da conexão no SurrealDB. O `$withContext` cria um **clone** do client
que prefixa `USE NS ... DB ...` (e sessão, quando aplicável) em cada operação, permitindo rotear
consultas para outros namespaces/databases sem trocar o estado global da conexão.

```ts
const tenantA = client.$withContext({
	namespace: 'tenant_a',
	database: 'app',
	meta: { tenantId: 'a' },
});

await tenantA.invoices.findMany({ where: { status: 'open' } });

// SurrealQL gerado (mesmo round-trip):
// USE NS tenant_a DB app; SELECT * FROM invoices WHERE status = $p0;
```

- O contexto pode ser sobrescrito por chamada: `tenantA.invoices.findMany({ context: { database: 'analytics' } })`.
- `client.$withContext({ auth: token })` também funciona: o clone usa um **token próprio** para
  autenticação (sessão isolada), útil em multi-tenant com record access.
- O merge de metadata é: defaults do `$withContext` → `meta` da chamada vence.

## Autenticação

```ts
// system user (root / namespace / database)
await client.auth.signin({ username: 'editor', password: 'editor' });

// record access (DEFINE ACCESS ... TYPE RECORD)
await client.auth.signin({
	access: 'account',
	variables: { email: 'aeon@surreal.db', pass: 'senha' },
});

await client.auth.signup({
	access: 'account',
	variables: { email: 'new@surreal.db', pass: 'senha', name: 'New' },
});

await client.auth.authenticate(token);   // troca de token manual
await client.auth.invalidate();          // encerra a sessão
const me = await client.auth.record();   // registro autenticado (record access)
```

- O token (JWT/record) é mantido pelo SDK e reutilizado nas reconexões.
- `$withContext({ auth })` permite sessões alternativas no mesmo processo.
- Permissões (`DEFINE TABLE ... PERMISSIONS FOR select, create, ...`) e record access são aplicados
  **pelo servidor** — a API não contorna isso; erros de permissão chegam como
  `BetterSurrealError` com `code: 'PermissionDenied'`.

## Informações e saúde

```ts
const dbInfo    = await client.info('db');            // INFO FOR DB;
const tableInfo = await client.info('table', 'users');// INFO FOR TABLE users;
const nsInfo    = await client.info('ns');            // INFO FOR NS;
const rootInfo  = await client.info('root');          // INFO FOR ROOT;

const version = await client.version();               // "3.x.y"
const ok      = await client.ping();                  // true/false (health check)
```

Tipagem: `client.info('table', 'users')` devolve a estrutura do schema com os tipos conhecidos
(`fields`, `indexes`, `events`, `lives`, `tables`...), útil para ferramentas de introspecção.

## Funções e APIs do banco

```ts
// DEFINE FUNCTION fn::greet($name: string) { RETURN 'Olá ' + $name; };
const msg = await client.fn.call<string>('fn::greet', ['Aeon']);

// DEFINE API "/articles" FOR get THEN { ... };
const articles = await client.api.get<Article[]>('/articles', {
	query: { limit: '10' },
	headers: { 'accept-language': 'pt-BR' },
});

await client.api.post('/articles', { body: { title: 'SurrealDB' } });
```

`client.fn.call` executa via `db.run(name, args)` e `client.api.*` via o suporte nativo do SDK v2.
Ambos herdam o contexto de sessão/transação corrente (`tx.fn.call(...)` funciona dentro de transações).

## Raw e escape hatches

```ts
const rows = await client.$raw<{ id: string }>`
	SELECT id FROM users WHERE email = ${email}
`;

const [users, posts] = await client.$query<[User[], Post[]]>`
	SELECT * FROM users LIMIT 10;
	SELECT * FROM posts LIMIT 10;
`;

const client2 = betterSurreal(db, { schema: appSchema, raw: { unsafe: true } });
await client2.$unsafe(`LIVE SELECT * FROM users;`);
```

Detalhes completos em [12-raw-funcoes-e-apis.md](./12-raw-funcoes-e-apis.md).

## `extends` — helpers do projeto

```ts
const client = betterSurreal(db, { schema }).extends({
	helpers: {
		async findActiveUsers(this: BetterClient) {
			return this.users.findMany({ where: { active: true } });
		},
	},
});

await client.helpers.findActiveUsers();
```

Conflitos de nome com a API existente falham no bootstrap (fail-fast). O objeto é reaplicado em
transações e clones de `$withContext` — os helpers sempre enxergam o client correto.
