# `@compass/llm`

The `LlmProvider` seam. Every call to a language model in Compass goes through the
interfaces in `src/types.ts` — no application code imports a vendor SDK.

## Why two interfaces, not one

`CompletionProvider` and `EmbeddingProvider` are separate because the two
operations have different relationships to persisted state (ADR-0006):

| | Completions | Embeddings |
|---|---|---|
| State | Stateless — text in, text out | Written to a fixed-width `VECTOR(1024)` column |
| Swapping the model costs | A config change | A schema migration **and** a full re-embed |
| Comparable across models | n/a | No — each model has its own coordinate system |

A single fused interface would assert a symmetry that does not exist, and would make
"Bedrock for embeddings, something else for completions" inexpressible.

## Configuration

| Variable | Values | Default |
|---|---|---|
| `LLM_EMBEDDING_PROVIDER` | `bedrock` \| `fake` | `bedrock` |
| `LLM_COMPLETION_PROVIDER` | `bedrock` \| `fake` | `bedrock` |
| `LLM_EMBEDDING_MODEL` | model id | `amazon.titan-embed-text-v2:0` |
| `LLM_COMPLETION_MODEL` | inference profile id | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |

An unrecognised provider name is an error, not a fallback: defaulting to the fake
would let a typo in a deployed environment fill the database with meaningless
vectors while every row count and health check stayed green.

## Bedrock notes

- **Titan** is `ON_DEMAND`, so the bare model id is correct. `dimensions: 1024` and
  `normalize: true` are sent explicitly — the first states ADR-0006's width at the
  call site, the second is what makes cosine distance well behaved.
- **Claude is `INFERENCE_PROFILE`-only** in `eu-west-1`. The bare
  `anthropic.claude-*` id fails validation; use the `eu.`-prefixed profile id.
  `global.` profiles also exist but route outside the EU.
- Completions additionally require the **Anthropic use-case details form** to have
  been submitted for the account, in the Bedrock console. Until then a `Converse`
  call returns `ResourceNotFoundException: Model use case details have not been
  submitted`.
- IAM: invoking through an inference profile needs `bedrock:InvokeModel` on the
  **profile ARN and on the underlying foundation-model ARNs in every region the
  profile can route to**. Granting the profile alone reads as missing access.

## The fake is not a test fixture

With one real vendor, `FakeEmbeddingProvider` / `FakeCompletionProvider` are the
*second implementation* of each interface, and therefore the only thing that shows
the seam holds rather than asserting it. The fake embedder is a hashed bag of words,
unit-normalised — deliberately not random noise, so that "related texts are nearer
than unrelated ones" is a meaningful assertion against it and against Titan, with no
special-casing. It models lexical similarity, not semantic similarity, which is
exactly why it is a test double and not a retrieval strategy.

## Tests

One contract suite (`test/contract/provider-contract.ts`) is parameterised over
implementations, so adding a provider means adding it to a list rather than writing
a second test file that can drift.

```bash
npm run test -w @compass/llm              # unit tier: fake only, no network, runs in CI
RUN_LIVE_LLM_TESTS=1 \
  npm run test:integration -w @compass/llm  # same contract against real Bedrock
```

The live tier is opt-in so CI neither spends money nor needs credentials.

**Vendor containment check** — this must list only files under `src/bedrock/`:

```bash
grep -rl "@aws-sdk/client-bedrock" packages/llm/src
```

## Known local trap

`.env` sets `AWS_PROFILE=compass-dev`. If that profile does not exist in `~/.aws`,
anything that loads `.env` — every `vitest.config.ts` does — fails with
`CredentialsProviderError`, while a plain `aws` command in your shell works, because
the shell never loads `.env`.
