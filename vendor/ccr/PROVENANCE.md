# CCR source provenance

Upstream: https://github.com/oakimov/claude-code-router

Exact revision: `5cb26917d02b8ec5d0e849271a204a6b5dbb9ca1`, tag `v2.1.16`.
Registry metadata `npm view @caeliq/claude-code-router@2.1.16 gitHead` and the
upstream tag both resolved to that commit when acquired on 2026-11-03.
Core package version at that revision: `1.0.74`. License: MIT; see `LICENSE`.

Source was obtained from the GitHub commit archive. `original-sha256.json`
records original byte hashes of copied files, excluding upstream tests. No
minified source manipulation or symbol-name interception is used by the new CLI.

## Adapter rather than edits to upstream code

`scripts/build.cjs` resolves these explicit source-level integration boundaries:

- `@caeliq/ccr-shared`: `src/transport/shared.ts`, which re-exports the original
  Codex/model-alias utilities and supplies the wrapper's state directory,
  Claude projects directory and local rate-limit constants.
- `@/transformer`: `src/transport/registry.ts`, linking only the Anthropic,
  OpenAI, Responses and Codex transformers. Other providers, UI and CCR CLI
  are not part of the product interface.
- `tiktoken`: `src/transport/tiktoken.cjs`, initializing the original bindings
  with the exact dependency's WASM embedded in the JS bundle. There is no
  runtime asset search, download or dynamic package installation.
- Router's token-count worker boundary: `src/transport/token-count.ts` uses
  upstream character estimates but performs exact token counting synchronously.
  Upstream's eval worker would require an on-disk package at runtime. This
  trades main-thread latency for portability on large requests; no worker
  offloading is claimed.

`src/transport/server.ts` composes Fastify with the original ConfigService,
TransformerService, ProviderService, TokenizerService and API route handler.
Initialization is explicitly awaited before providers/routes are registered.
Configuration is supplied in memory; the wrapper does not invoke CCR's CLI,
read its home config, register UI/admin endpoints as public product features,
or load the settings plugin from an absolute path. HTTP access is limited to
an authenticated loopback session and a small endpoint allowlist.

Session lifecycle, health metadata, clean PKCE OAuth login, model discovery and
user settings are wrapper responsibilities. OAuth refresh and message/tool/SSE
conversion remain upstream CCR implementations. The original upstream may change
its internal source APIs: this is a maintained pinned adapter, not a claim that
these source imports are stable across CCR versions. Review and rerun all tests
before moving the revision.

## Rebuild

From the project checkout: `npm ci --ignore-scripts`, then `bun run build`.
The npm artifact contains the resulting bundle and licenses, not the source
checkout, development tools or private runtime state. The legacy published CCR
package remains a pinned dev dependency only for the unchanged local regression
checks; the new launcher never executes it.
