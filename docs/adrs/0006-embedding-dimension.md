# ADR-0006: Fixed 1024-dimension embedding column

**Status:** Accepted
**Date:** 2026-08-29
**Deciders:** Stéphan (solo project)

## Context

The RAG retrieval path stores one vector per chunk in Postgres via `pgvector`
(ADR-0002). A `pgvector` column is declared with a fixed width — `VECTOR(1024)` —
and a vector of any other length is rejected on insert. The width therefore has to
be chosen in the very first migration (COMPASS-14), before a single document has
been ingested.

Two forces pull against each other:

- **`docs/ARCHITECTURE.md` commits that swapping `LlmProvider` is a configuration
  change**, never a code change. Bedrock and OpenRouter adapters sit behind one
  interface precisely so the provider can move.
- **Embedding models do not agree on a width.** Amazon Titan Text Embeddings V2
  emits 1024 (and can be asked for 512 or 256). OpenAI `text-embedding-3-small`
  is natively 1536. Cohere Embed v3 is 1024.

The promise and the storage format are in direct tension, and the tension is not
symmetric across the two things `LlmProvider` abstracts. That asymmetry is the
substance of this decision.

## Decision

**Declare `embeddings.embedding` as `VECTOR(1024)`, sized for Titan Text Embeddings
V2, and accept that changing the embedding model's dimension is a schema migration
plus a full re-embed — not a configuration change.**

Explicitly **reject** adding "every embedding adapter must emit exactly 1024
numbers" as a rule of the `LlmProvider` interface.

Scope the `ARCHITECTURE.md` promise accordingly: **provider swapping is a
configuration change for text generation, and a migration for embeddings.**

## Options Considered

### Option A: Fix at 1024, treat a dimension change as a migration (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — one column type, one index |
| Cost | Zero now; a future dimension change costs a re-embed of the whole corpus |
| Scalability | Fine to the project's ceiling; unrelated to row count |
| Team familiarity | High — an ordinary schema migration |

**Pros:** simplest thing that works; the column is indexable (an approximate
nearest-neighbour index requires a fixed width); honest about the real cost rather
than hiding it behind an abstraction that does not hold.
**Cons:** contradicts a literal reading of the `ARCHITECTURE.md` provider-swap
promise unless that promise is explicitly scoped, which this ADR does.

### Option B: Require every adapter to emit 1024 numbers

| Dimension | Assessment |
|-----------|------------|
| Complexity | Low in the schema, pushed into every adapter |
| Cost | Zero infrastructure cost; paid in retrieval quality |
| Scalability | Same as A |
| Team familiarity | Medium — relies on a per-provider truncation feature |

Several providers can return a shortened vector on request (Titan V2 at 512/256,
OpenAI `text-embedding-3-small` down from 1536), so this is technically achievable
today.

**Pros:** the provider-swap promise would hold literally, with no migration.
**Cons:** silently discards accuracy — a 1536-dimension model shortened to 1024 is
a worse model than it was. It also rules out any provider that cannot shorten, and
buys uniformity this project has no use for: **the choice of embedding model is
deliberate, not incidental.** Constraining every future model to one width to avoid
a migration optimises the wrong thing.

### Option C: Untyped `VECTOR` column, dimension enforced in application code

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — validation moves out of the database |
| Cost | Zero, but retrieval is unusably slow without an index |
| Scalability | Poor |
| Team familiarity | Low |

**Pros:** any model, any width, no migration ever.
**Cons:** **fatal — `pgvector` cannot build an approximate nearest-neighbour index
on a column of unknown width.** Every query degrades to comparing the question
against every stored row. This trades a one-off migration for a permanent
performance ceiling.

### Option D: One table (or one column) per model, each with its own width

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — retrieval must know which table to read |
| Cost | Zero |
| Scalability | Good — each model keeps its native width and its own index |
| Team familiarity | Medium |

**Pros:** dimension becomes a property of the *model* rather than of the table,
which is what it actually is. Two models can coexist at their native widths.
**Cons:** unjustified complexity at one model. It is, however, the correct
destination — see Consequences.

## Trade-off Analysis

The decision turns on one observation: **`LlmProvider` abstracts two operations
with very different relationships to persisted state.**

Text generation is stateless. A question and some context go in, an answer comes
out, nothing is stored. Swapping that model genuinely is a configuration change,
and the architecture's promise holds without qualification.

Embedding is not stateless. Its output is written to a column whose type encodes
the model's width, and it is only meaningful when compared against other vectors
produced *by the same model* — two models' outputs are not comparable even at
identical widths, because each learned its own coordinate system. So swapping the
embedding model always requires re-embedding the entire corpus, whatever the schema
says. **A dimension change adds a migration to a re-embed that was already
unavoidable.** Option B removes the smaller half of that cost and pays for it in
permanent retrieval quality.

That is why B is rejected. It buys back a migration that is not the expensive part,
in exchange for degrading the one component whose quality determines whether
retrieval returns the right passages at all.

The existing `PRIMARY KEY (chunk_id, model)` is often mistaken for a solution here.
It is not. What it buys is the ability to hold **several 1024-dimension models side
by side**, so a re-embed can run to completion while the old vectors continue
serving queries. It does nothing about a change of width.

## Consequences

- **Easier:** the column is indexable, which is what makes retrieval viable at all;
  the schema is the simplest thing that supports the current provider; the real
  cost of an embedding-model change is written down rather than discovered.
- **Harder:** `docs/ARCHITECTURE.md`'s provider-swap claim now needs its
  qualification stated wherever it appears, or it is misleading. A move to a
  1536-dimension model is a planned migration with a re-embed, not a config edit.
- **Revisit at the second embedding model.** Two changes land together at that
  point, and they are the same shape:
  1. The approximate nearest-neighbour index covers `embedding` but not `model`, so
     a query filtered by model post-filters the index results. Once a second model
     populates the table, the index can return a full set of matches belonging to
     the *other* model, which the filter then discards — yielding **fewer results
     than requested, or none, with no error raised**. The fix is a partial index
     per model.
  2. If the second model does not emit 1024, Option D applies: give each model its
     own table and native width.
- **Revisit if the corpus outgrows the instance.** The chosen index (HNSW —
  Hierarchical Navigable Small World, a graph-based approximate nearest-neighbour
  index) is memory-resident by design, and `db.t3.micro` has 1 GB of RAM. That
  ceiling, not query latency, is the first thing expected to bite.

## Action Items

1. [x] `VECTOR(1024)` in the initial schema migration (COMPASS-14).
2. [ ] Qualify the provider-swap claim in `docs/ARCHITECTURE.md`: configuration for
       text generation, migration for embeddings.
3. [ ] Assert the adapter's output width in the `LlmProvider` embedding path, so a
       mismatched model fails at the boundary with a clear message rather than as a
       Postgres insert error (COMPASS-11).
4. [ ] At a second embedding model: partial index per model, and Option D if the
       widths differ.
