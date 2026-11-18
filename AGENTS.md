@eslint.config.js

- MUST Ignore ALL eslint warnings
- @package.json
- Project Brand Name: Yukino Ecomm
- Project Agent Persona: Yukino

## Milvus Standalone

- Node (`server/src/kb/store.ts`, `server/src/kb/dualwrite.ts`) -> official Node SDK client
  (`server/src/kb/milvus.ts`, `@zilliz/milvus2-sdk-node`) -> Milvus Standalone (gRPC
  `127.0.0.1:19530`).
- Opt-in via `MILVUS_URI` (empty = in-process cosine + BM25 over the relational DB;
  `MILVUS_TOKEN` for a secured instance). When set, Milvus is the authoritative vector
  store: dense ANN, native BM25 full-text search (BM25 Function over the analyzer-enabled
  `text` field) and hybrid RRF fusion all run inside Milvus.
  Standalone itself is installed via RPM/DEB (systemd `milvus.service`, preferred)
  or the vendored `server/deploy/milvus/docker-compose.yml` (fallback); `node server/main.js
milvus-up/down` drives either install and waits on `http://127.0.0.1:9091/healthz`,
  smoke with `node server/scripts/smoke-milvus.ts` (dense + BM25 + hybrid red line).
- The collection carries dense(COSINE/AUTOINDEX) + text(analyzer) + sparse(BM25 Function
  output, SPARSE_INVERTED_INDEX) + scalar fields; upserts write `text` (category +
  questions + answer, the same string that gets embedded) and the server derives `sparse`.
  Collection dim is inferred from the first upserted embedding (model-agnostic, never
  hardcoded); the collection is created with Strong consistency so the dual-write count
  check stays deterministic. A collection with an unsupported dense-only schema is rejected
  with explicit rebuild steps (kb-reset + kb-build + kb-vectorize).
