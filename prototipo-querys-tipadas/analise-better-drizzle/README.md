# Análise do better-drizzle

Documentação produzida a partir do site oficial (better-drizzle.com/docs — conteúdo espelhado em
`apps/web/content/docs/` no repo) e do código-fonte do repositório clonado em
`/home/gulybyte/Documentos/pr/better-drizzle`.

**better-drizzle** é uma camada fina de *repositórios* por cima do **Drizzle ORM** — "Drizzle ORM, but better".
`npm install better-drizzle drizzle-orm` · versão atual: `0.1.1` · Apache-2.0 · mantido por almeidazs, patrocinado pela Neon.

## Índice

| Arquivo | Conteúdo |
| --- | --- |
| [01-como-funciona.md](./01-como-funciona.md) | Como o better-drizzle funciona por dentro: arquitetura, bootstrap, runtime, compilador de `where`, loader de relações, plugins, hooks, transações, raw SQL, `.explain()` e erros. |
| [02-api-referencia.md](./02-api-referencia.md) | A API em si: `better()`, opções, métodos do client, delegate por tabela (reads, writes, paginação), filtros, relações, batch, raw, transações, locks, `@better-drizzle/*` e matriz de suporte. |
| [03-estilo-da-api.md](./03-estilo-da-api.md) | O estilo da API: filosofia, convenções de nomenclatura, formas dos argumentos, padrões de resultado, segurança-por-default e o design idiomático do repositório. |
| [04-comparacao-com-drizzle.md](./04-comparacao-com-drizzle.md) | Comparação direta com o Drizzle puro: a mesma query nos dois, o que muda e o que fica intacto, performance (benchmarks) e quando usar cada um. |

## TL;DR

```ts
import { better } from 'better-drizzle';
import { drizzle } from 'drizzle-orm/bun-sqlite';

const db = drizzle(sqlite, { schema });   // client Drizzle normal
const client = better(db, { schema });    // uma vez, no bootstrap

const posts = await client.posts.findMany({
	where: {
		published: true,
		author: { is: { active: true } },   // filtro de relação tipado
	},
	select: { id: true, title: true },
	orderBy: [{ id: 'desc' }],
	take: 20,
});
```

- Um **delegate por tabela** (`client.users`, `client.posts`, …) com `findMany`, `findFirst`, `findOne`, `findUnique`, `count`, `exists`, `paginate`, `cursor`, `create`, `createMany`, `update`, `updateMany`, `updateEach`, `delete`, `deleteMany`, `upsert`, `upsertMany`.
- Tudo tipado a partir do **schema Drizzle existente** (tabelas + `relations`) — sem codegen, sem schema próprio.
- Relações via `include`/`select` com loader próprio (não `db.query`) e filtros aninhados `some`/`every`/`none`/`is`/`isNot`.
- Paginação offset (`paginate()`) e por cursor (`cursor()`), ambas retornando `{ data, pagination }`.
- Hooks (observar) + plugins (mutar), transações com savepoints/retries/`afterCommit`, raw SQL seguro por default, `.throw()` e `.explain()` em reads.
- Dialeto detectado do client Drizzle: SQLite, PostgreSQL e MySQL com o mesmo client.

> Fonte principal: repo `better-drizzle` (branch `main`, commits até `214dd19`). As citações literais de API/benchmarks vêm da documentação oficial do repo (`apps/web/content/docs/*.mdx`, `README.md`, `examples/`).