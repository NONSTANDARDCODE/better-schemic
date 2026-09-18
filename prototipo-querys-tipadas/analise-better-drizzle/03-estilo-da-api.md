# 03 — O estilo da API

## Filosofia

> "**Minimal**" e "**type-safe**" não são palavras de marketing aqui — são a essência estética do projeto.
> "better-drizzle is a minimal, type-safe wrapper around Drizzle ORM" (README).

O estilo do better-drizzle pode ser resumido em cinco escolhas de design:

1. **Reuso total do schema do Drizzle** — tabelas + `relations` são a fonte de verdade. Nada de schema próprio, nada de codegen.
2. **Delegate por tabela** — cada tabela ganha um objeto dedicado com o mesmo conjunto de métodos; o desenvolvedor nunca digita o nome da tabela nas calls.
3. **Um objeto de args, não um DSL** — cada método recebe um único argumento de objeto (`{ where, data, select, orderBy, ... }`) em vez de dezenas de parâmetros posicionais.
4. **Segurança por default, expressividade por escape hatch** — raw cru é opt-in, locks exigem transação, dialeto sem suporte falha rápido. Quando você *quer* o Drizzle puro, ele está a uma chamada.
5. **Onde cabem, os nomes e novas formas são os que você já conhece** — a API espelha uma camada familiar de repositório/Prisma, para que a curva de aprendizado seja "run faster, already known".

## Convenções de nomenclatura e formas

| Convenção | Exemplos |
| --- | --- |
| Métodos de leitura: `find*` + `count`/`exists` | `findMany`, `findFirst`, `findOne`, `findUnique` |
| Métodos de escrita: verbos diretos | `create`, `createMany`, `update`, `updateMany`, `updateEach`, `delete`, `deleteMany`, `upsert`, `upsertMany` |
| Plural = vários; singular = um | `findMany`/`findFirst`/`findOne`/`findUnique`, `create`/`createMany` |
| `Many` retorna array/batch; demais retornam linha | `Row[]`, `BatchResult{count,data?}`, `ThrowingResult<T>` |
| Sufixos `By...` só quando não há `where` | `restoreById` (soft-delete) |
| Tabela no nome do delegate, nunca repetida nos args | `client.users.findMany({...})`, não `findUsers({ table: 'users' })` |
| Verbos no infinitivo → particípio no hook | `beforeCreate`, `afterQuery`, `onError` |

## O gesto central: um objeto de args para tudo

Todos os métodos (reads e writes) seguem o mesmo contorno:

```ts
method({ where, data, select, include, orderBy, take, skip, cursor, meta })
```

- Campos ausentes são opcionais — o comportamento default é o "menos surpreendente" (ler tudo, escrever um).
- `where` com múltiplas chaves é **AND** por construção (sem álgebra surpresa); `OR`/`NOT`/`AND` são os escapes explícitos.
- `data` detalha objetos; `select`/`include` são "projeção declarativa" — mesma estética dos queries.
- `meta` (per-call), `context` (via `$withContext`) e `$withState` mantêm o metadata fluindo pela mesma chamada — hooks, plugins e transactions enxergam a mesma estrutura.

## Resultado: tipado, honesto e com `.throw()`

- Nulabilidade **explicita**: quando um resultado pode não existir, o tipo é `T | null`, *nunca* `T` falso.
- `ThrowingResult<T>` = `Promise<T | null>.throw([factory])` — quem quer o control-flow strict de "não achou = lança" não escreve if.
- `BatchResult` separa contagem (`count`) de linhas retornadas (`data?`), deixando transparente quando o driver não tem `RETURNING`.
- Filtros de `orderBy`/`take` são *arrays/objetos* (nunca strings mágicas que quebram com rename): tipados contra colunas reais do schema.
- Tudo infere da tabela — zero campos "string any" para as colunas, zero casts.

## Relações: `include` com um sub-`where`

O estilo relacional mistura dois mundos que normalmente ficam separados:

- **Carregar** relações: `include`/`_count` (formato já familiar do Prisma, mas sem codegen);
- **Filtrar por** relação: `some/every/none/is/isNot` no `where`, compilados para `EXISTS`/`NOT EXISTS` (formato de condições, não de joins).

Contraste de estilo com o Drizzle puro:

| Drizzle cru | better-drizzle |
| --- | --- |
| Você monta o join à mão e deduz as linhas | `include: { posts: { where: { published: true } } }` |
| `db.query.posts.findMany({ with: { author: true } })` | `client.users.findUnique({ include: { posts: true } })` |
| Contagens exigem subqueries manuais | `include: { _count: { select: { posts: true } } }` |
| Filters de relação exigem `exists()` manual | `where: { posts: { some: { published: true } } }` |

## Paginação com payload oficial

Offset e cursor compartilham o mesmo envelope `{ data, pagination }`:

- `paginate()` → `pagination: { type: 'offset', page, perPage, total, pageCount, hasNext, hasPrevious }`;
- `cursor()` → `pagination: { type: 'cursor', hasNext, hasPrevious, nextCursor, previousCursor }`.

Uma forma única, sem um `{ page, perPage, itens }` inventado por chamada — anti-padrão típico de quem paginava dezenas de microserviços às cegas.

## Segurança-por-default no gesto da API

| Padrão | Resultado |
| --- | --- |
| `$raw` / `$executeRaw` seguros, `$rawUnsafe` desligado | valor padrão de `raw.allowUnsafe=false` |
| Locks de leitura fora de transação | `LOCK_REQUIRES_TRANSACTION` com `transactionsOnly` |
| Recurso sem suporte no dialeto | erro estruturado (`BetterDrizzleError` com `code`) — nunca roda errado |
| `upsertMany` sem suporte nativo | falha rápido em vez de loop por `upsert` |
| `action: [noRawUnsafe, destructiveWriteWithoutWhere…]` do `@better-drizzle/rules` | guardrails adicionais opt-in |
| Writes relacionais fora de transação | transação implícita com rollback em erro de FK |

## Estilo do código-fonte (para quem vai contribuir)

- **Objetos criados com `Object.create(null)`** para maps de delegates/registros — evita colisões com `__proto__`/`constructor` em nomes de tabela.
- **Fast paths em lugar de pipeline universal**: se não há plugins/hooks com trabalho para o kind, o código vai direto à operação real (visível em `delegate.ts` e `operations.ts`). Overhead mínimo é *feature*, não acidente.
- **Nomeado e flat**: módulos pequenos, um papel por arquivo (`client/`, `query/`, `types/`), funções exportadas separadamente — fácil de seguir.
- **Mudanças obedecem o estilo do repo**: exemplo em `examples/`, docs em `apps/web/content/docs/`, sempre um teste.

## O estilo geral "da API ORM" de camadas

Olhando de ponta a ponta, o better-drizzle admite a seguinte arquitetura no seu código:

```ts
// 1. infra
const db = drizzle(sqlite, { schema });
const client = better(db, { schema });

// 2. domínio (formas de serviço com delegate + include)
export async function getVerifiedUser(email: string) {
	return client.users.findUnique({
		where: { email, verified: true },
		include: { sessions: { orderBy: { createdAt: 'desc' }, take: 5 } },
	}).throw(() => new NotFoundException('User not found'));
}

// 3. transação + pós-commit
const id = await client.transaction(async (tx) => {
	const row = await tx.posts.create({ data: { title, authorId }, select: { id: true } });
	tx.afterCommit(() => cache.invalidate('posts'));
	return row.id;
}, { retries: { attempts: 3 } });

// 4. escape hatches
client.$raw`select pg_sleep(0.1) from (select 1) t`;
```

Traduzindo: infra Drizzle + camada melhor + transações no client + raw quando o SQL mandar — tudo com a mesma tipagem do schema.