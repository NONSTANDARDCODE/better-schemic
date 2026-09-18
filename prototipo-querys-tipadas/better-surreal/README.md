# better-surreal

Documento de design da API de ORM **better-surreal**: uma camada de repositórios mínima e type-safe
por cima do **SurrealDB**, no mesmo estilo do [better-drizzle](../analise-better-drizzle/README.md)
("Drizzle ORM, but better") — mas aproveitando tudo o que o SurrealDB tem de nativo: record ids,
grafos, `UPSERT`, `INSERT ... ON DUPLICATE KEY UPDATE`, live queries, changefeeds, full-text e vetores.

> **Premissa central**: schemafull, com o **schema TS já existente no seu projeto**. Estes documentos
> mostram **a API de consulta** (como consumir os tipos e escrever queries, inserts, updates, upserts,
> grafos, etc.), não como definir o schema. O `better-surreal` apenas consome esse artefato tipado no
> bootstrap.

```
npm install better-surreal surrealdb
```

## Quickstart

```ts
import { Surreal } from 'surrealdb';
import { betterSurreal } from 'better-surreal';
import { appSchema } from './schema';          // schema tipado do seu projeto

const db = new Surreal();
await db.connect('wss://localhost:8000/rpc');
await db.use({ namespace: 'app', database: 'main' });
await db.signin({ username: 'root', password: 'root' });

const client = betterSurreal(db, { schema: appSchema });

// leitura tipada
const posts = await client.posts.findMany({
	where: {
		published: true,
		author: { is: { active: true } },      // filtro de relação (record link ou grafo)
	},
	select: { id: true, title: true },
	orderBy: [{ createdAt: 'desc' }],
	limit: 20,
});

// criação
const user = await client.users.create({
	data: { name: 'Aeon', email: 'aeon@surreal.db' },
});

// upsert nativo
await client.users.upsert({
	where: { id: 'users:aeon' },
	create: { id: 'users:aeon', name: 'Aeon', balance: 0 },
	update: { lastSeen: new Date() },
});

// grafo
await client.users.relate('users:aeon', 'likes', 'posts:1', { data: { score: 5 } });

// live
const sub = await client.users.live({ where: { active: true } }, (change) => {
	console.log(change.action, change.value);
});
// ... depois
sub.kill();
```

## Índice

| Arquivo | Conteúdo |
| --- | --- |
| [01-filosofia-e-arquitetura.md](./01-filosofia-e-arquitetura.md) | Princípios, arquitetura interna (compilação para SurrealQL parametrizado), convenções e formas de retorno. |
| [02-client-e-conexao.md](./02-client-e-conexao.md) | `betterSurreal()`, opções, métodos do client, auth, `$withContext`, `info`, `fn`, `api`. |
| [03-leitura-select.md](./03-leitura-select.md) | `findMany`, `findFirst`, `findOne`, `findUnique`, `count`, `exists`, `aggregate` e todas as cláusulas do `SELECT`. |
| [04-filtros-where.md](./04-filtros-where.md) | O objeto `where`: todos os operadores do SurrealQL por tipo, lógicos, ranges, full-text, vetores e fragments. |
| [05-criacao-create-e-insert.md](./05-criacao-create-e-insert.md) | `create`, `createMany`, `insert`, `insertMany`, ids, `ON DUPLICATE KEY UPDATE` e `INSERT IGNORE`. |
| [06-atualizacao-e-upsert.md](./06-atualizacao-e-upsert.md) | `update` (SET/MERGE/CONTENT/REPLACE/PATCH/UNSET), `updateMany`, `upsert`, `upsertMany`. |
| [07-remocao-e-batches.md](./07-remocao-e-batches.md) | `delete`, `deleteMany`, `updateEach`, `RETURN BEFORE/AFTER/DIFF/NONE` e semântica de lotes. |
| [08-relacoes-e-grafos.md](./08-relacoes-e-grafos.md) | Record links (`FETCH`), `RELATE`/`UNRELATE`, traversal `->`/`<-`, recursão `@.{n}`, `->?`, `_count`. |
| [09-paginacao-e-agregacoes.md](./09-paginacao-e-agregacoes.md) | `paginate`, `cursor`, `groupBy`/`groupAll`, `SPLIT` e agregadores. |
| [10-transacoes.md](./10-transacoes.md) | `client.transaction`, commit/cancel, retries em write conflict, `afterCommit`/`afterRollback`. |
| [11-live-queries-e-changefeeds.md](./11-live-queries-e-changefeeds.md) | `live()`, `subscribe`/`kill`, notificações tipadas, `LIVE DIFF`, `changes()` (`SHOW CHANGES`). |
| [12-raw-funcoes-e-apis.md](./12-raw-funcoes-e-apis.md) | `$raw`, `$query`, `$unsafe`, `surql` fragments, `fn.call`, `client.api`, export/import. |
| [13-plugins-hooks-e-erros.md](./13-plugins-hooks-e-erros.md) | `definePlugin`, hooks, plugins oficiais (timestamps, soft-delete, zod, rules, audit) e erros tipados. |
| [14-referencia-e-cookbook.md](./14-referencia-e-cookbook.md) | Cheat-sheet de toda a superfície + receitas mapeadas dos tutoriais (Aeon, geo, full-text, vetorial, banco, recursão). |

## Relação com o better-drizzle

| better-drizzle | better-surreal | Por quê |
| --- | --- | --- |
| `better(db, { schema })` | `betterSurreal(db, { schema })` | Mesmo bootstrap fino sobre o driver/SDK. |
| `client.users.findMany({ where, select, take })` | `client.users.findMany({ where, select, limit })` | `limit`/`start` são os nomes do SurrealQL; `take`/`skip` continuam aceitos como alias. |
| `findUnique` → `SELECT ... WHERE id = $1` | `findUnique` → `SELECT * FROM ONLY users:john` | O `ONLY` do SurrealDB devolve um objeto, não array. |
| Relações via `include` + joins | `include` + `FETCH`/traversal de grafo | SurrealDB resolve relações nativamente. |
| `create`/`createMany` (`INSERT`) | `create` (`CREATE`) + `insert` (`INSERT`) | São statements distintos: `CREATE` sempre cria; `INSERT` aceita ids e `ON DUPLICATE`. |
| `upsert` emulado | `UPSERT` nativo (+ `INSERT ... ON DUPLICATE KEY UPDATE`) | SurrealDB tem upsert de primeira classe. |
| `paginate()`/`cursor()` | `paginate()`/`cursor()` | Mesmo envelope `{ data, pagination }`. |
| Plugins/hooks | Plugins/hooks + plugins Surreal (search, vector, soft-delete) | Mesma extensibilidade. |
| Raw `$raw` | `$raw`/`$query`/`$unsafe` + snippets `surql` | Seguro por default, escape hatch quando precisar. |
| — | `live()`, `changes()`, `fn`, `api`, `relate()` | Recursos nativos do SurrealDB expostos na mesma API de repositório. |

## Premissas de tipagem

- O `schema` passado em `betterSurreal()` é o artefato tipado do seu projeto. Dele saem:
  - os **delegates** (`client.users`, `client.posts`, `client.likes` — inclusive tabelas de aresta);
  - os **tipos de linha** (`User`, `Post`, ...) usados nas assinaturas;
  - os **metadados de relação** (campos `record<...>`, tabelas `TYPE RELATION`, alvos de traversal)
    que alimentam `include`, `_count` e os filtros `is`/`some`/`every`/`none`;
  - os **tipos de campo** que restringem os operadores de `where` (string, number, datetime, array,
    geometry, option, record...).
- Nos exemplos destes docs, `User`, `Post`, `Comment`, `Like` etc. são apenas os tipos que o seu
  schema já expõe. Nada aqui exige mudar o schema ou gerar código.

## Convenções gerais

- Um método = um objeto único de argumentos (`{ where, data, select, ... }`).
- Leituras retornam `Row[]`; operações de registro único retornam `ThrowingResult<Row>`
  (`Promise<Row | null>` com `.throw()`); operações em lote retornam `BatchResult<T>`
  (`{ count, data? }`).
- Todo exemplo mostra o **SurrealQL gerado** (parametrizado) para você nunca perder o controle
  do que vai para o banco.
- Segurança por default: tudo parametrizado; `$unsafe` desligado; `$raw` sem string crua.
- Quando o SurrealDB não suportar algo no dialeto/nível de acesso, o erro é estruturado e imediato —
  nunca degrada silenciosamente.
