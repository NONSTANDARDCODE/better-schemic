# 04 — Comparação com o Drizzle puro

> "Drizzle ORM, but better." — A melhor forma de entender essa frase é colocar a **mesma query nos dois** e
> comparar o que muda. É exatamente isso que a página *Comparison* da documentação oficial faz.

Se raiz desta análise vem de `apps/web/content/docs/comparison.mdx` e de `guides/migrating-from-drizzle.mdx`.

## A mesma query, lado a lado

Objetivo: usuários ativos com posts publicados ordenados, blocos de 20 — com capacidade de construir meta de paginação.

```ts
// ── Drizzle puro ─────────────────────────────────────────────
const rows = await db
	.select({ id: users.id, name: users.name, posts: sql`...` })
	.from(users)
	.innerJoin(posts, eq(posts.authorId, users.id))
	.where(and(eq(users.active, true), eq(posts.published, true)))
	.orderBy(desc(users.id))
	.limit(20)
	.offset(40);

// filtro-relação, agregação, paginação, contagem: tudo à mão,
// com colunas decorando (*join*) e sem metadata de paginação.

// ── better-drizzle ───────────────────────────────────────────
const page = await client.users.paginate({
	where: {
		active: true,
		posts: { some: { published: true } },   // filtro de relação: EXISTS
	},
	orderBy: [{ id: 'desc' }],
	limit: 20,
	skip: 40,
});

// page.data            → as linhas
// page.pagination      → { page, perPage, total, pageCount, hasNext, hasPrevious }
```

O que mudou no código do author, na prática:

| Aspecto | Drizzle puro | better-drizzle |
| --- | --- | --- |
| Filtro de relação | `exists()` manual, alias, subquery | `where: { posts: { some: ... } }` |
| Join | `innerJoin(...)` escrito à mão, dedupe por você | invisível — a relação nasce do `schema` |
| Ordenação | `desc(users.id)` como expr | `orderBy: [{ id: 'desc' }]` tipada |
| Paginação | `.limit().offset()` e o author conta total na unha | `paginate()` devolve `{ data, pagination }` |
| Tipagem de  `where` | `eq(sql`, valores parcialmente `any` | 100% colunas reais do schema |
| Meta de paginação | inexistente — 2 queries + aritmética | `total`, `pageCount`, `hasNext`, `hasPrevious` |

## O que o better-drizzle NÃO muda

Esta lista é tão importante quanto a anterior — é o design central de manter perto do Drizzle:

| Camada | Continua sendo Drizzle |
| --- | --- |
| Schema | as MESMAS tabelas `pgTable`/`sqliteTable`/`mysqlTable` + `relations` |
| Driver | você escolhe `bun-sqlite`, `node-postgres`, `mysql2`, … |
| Migrations | `drizzle-kit` inalterado |
| SQL cru | `client.$raw\`...\`` é literalmente o `sql` do Drizzle |
| Condições | aceita `eq(...)`, `and(...)`, etc. dentro de `where` |
| Dialeto | detectado do client — SQLite/PG/MySQL com o mesmo código |
| Timeout/retry infra | permanece Drizzle |

Ou seja: **não há schema paralelo, não há migration nova, não há lock-in**. Adotar o better-drizzle é *aditar* camada de repositório por cima do que já existe.

## Onde ele "fica em cima" do Drizzle

1. **Point lookups**: `findUnique({ where: { id } })` vira 1 query com `.throw()`, sem arredondar `select *` e filtrar em JS.
2. **Relações**: o loader próprio (1 query por nó de relação, junção por-chave) substitui `db.query.*` — você ganha filtros por pai (`where` dentro do `include`), `_count` e vários níveis sem N+1.
3. **Writes de relação** (`connect`/`disconnect`/`set`) e batches (`skipDuplicates`, `updateEach` = `CASE WHEN`, `upsertMany` = `ON CONFLICT ... DO UPDATE`) que no Drizzle cru são SQLs longos e repetidos.
4. **Transações**: `client.transaction(fn, { retries, isolationLevel, afterCommit })` — no Drizzle você monta o loop de retry e o callback de pós-commit na unha.
5. **Filtros consistentes**: `where` completo com operadores, `mode: 'insensitive'`, JSONB path — o mesmo gesto em qualquer dialeto.
6. **Rigidez**: `lock` (FOR UPDATE/FOR SHARE), `.explain()`, permissionamento de raw, `@better-drizzle/rules` para guardrails em runtime e CI.

## Performance: benchmark de paridade

O repo traz uma suíte (`benchmark/`) que mede o better-drizzle **contra o Drizzle cru** na mesma query.
Regra do jogo (da doc *parity.md*): "compare equal work, not equal SQL count" — a feature completa (o que o
dev chamaria de "mesma coisa") não apenas a quantidade de statements.

Resultados (números das docs oficiais; ambiente declarado: AMD Ryzen 5 7520U, Bun 1.3.14, SQLite em memória):

| Operação | Diff de latência vs Drizzle cru |
| --- | --- |
| Point lookup | **−5.6%** (mais rápido) |
| Filtered list | +28.2% |
| Active count | **−17.9%** |
| Exists | +9.7% |
| Offset pagination | **−11.2%** |
| Cursor pagination | **−1.5%** |
| Relation filter | +9.4% |
| Update + reload | **−3.6%** |
| Simple transaction | +12.5% |
| Multi-op transaction | **−0.3%** |
| Read-only transaction | +21.8% |
| Nested savepoint | só o better-drizzle (≈650 µs) |

Memória:

| Cenário | Diff |
| --- | --- |
| Single read | **−85.1%** |
| Mixed read | **−60.2%** |
| Write | **−70.3%** |
| Transaction | +82.4% |

Leitura honesta: leituras e escritas ficam **na mesma ordem de grandeza** (ou mais rápidas, por não pagar o
trabalho de montar SQL 100% cru); transações simples pagam um pequeno overhead; contagens e operações com
`RETURNING` podem variar por dialeto. É "perto o suficiente" — e medido, não adivinhado.

## Quando usar Drizzle puro em vez de better-drizzle

- SQL muito específico do banco (arrays, window funções, `ON CONFLICT` com where complexo): o `where` do better-drizzle aceita `SQL`, então dá para misturar na mesma call.
- Queries read-only de leitura pesada sem contagem: `findMany` com `select` já é 1:1 — o Drizzle puro não muda nada ali.
- Você prefere mesclar com outro query builder: o `client` integra com o Drizzle — `and(eq(...), gte(...))` continua válido dentro de `where`.
- Integração com ferramentas que esperam o `db` Drizzle: `client.transaction(async (tx) => tx.raw...)` entrega o client bound, mas `db` continua acessível em qualquer lugar.

O modelo mental do mantenedor: **comece cru, adote a camada onde o reuso aparece** (lookups, incluições,
paginação, batches) e deixe o SQL especializado cru.

## Migração incremental (de um app Drizzle)

1. Mantenha schema, migrations e `db` exatamente como estão.
2. Adicione `better-drizzle` e faça `const client = better(db, { schema })` no bootstrap.
3. Migre, em ordem de ROI, os padrões repetidos: point lookups → `findUnique(...).throw()`, listas com relação → `findMany({ include })` no lugar de joins manuais, paginação → `paginate()`/`cursor()`.
4. Faça subir guardrails (`rules`/`eslint`) e, se quiser, `timestamps`/`soft-delete` **apenas** quando remover o código manual equivalente.
5. Deixe o SQL especializado e `createRaw`/`updateRaw` no Drizzle cru — não há custo em coexistirem.

## E como ele se compara a ORMs "completos" (Prisma)

| | Prisma | better-drizzle |
| --- | --- | --- |
| Schema | **próprio** (`datasource` + `model`) | o schema Drizzle que você já tem |
| Codegen | gera client (pesado, etapa de build) | zero — tipos inferidos do TS |
| Driver próprio | sim (engine) | não — usa driver/dialeto do Drizzle |
| API | `prisma.user.findMany({ include })` | `client.users.findMany({ include })` |
| Migrations | próprio + deploy step | `drizzle-kit` inalterado |
| Runtime | engine binária | pure TS |
| Lock-in / saída | não triviais | nada — deslogue o wrapper |

Síntese: o better-drizzle pega a **ergonomia de repositório** que fez o Prisma ganhar gente e a **coloca em cima do Drizzle**, mantendo o custo zero de adoção, a tipagem do schema seu e a porta de saída sempre aberta.