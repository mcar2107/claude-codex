# Third-party notices

## Claude Code Router

- Upstream: https://github.com/oakimov/claude-code-router
- Revision: `5cb26917d02b8ec5d0e849271a204a6b5dbb9ca1` (`v2.1.16`).
- Core version: `@caeliq/llms@1.0.74`; shared/CLI version: `2.1.16`.
- License: MIT, Copyright (c) 2026 Oleksiy Akimov.
- Complete license: `vendor/ccr/LICENSE` (standalone directory: `CCR-LICENSE`).
- Provenance, integration boundaries and rebuild details: `vendor/ccr/PROVENANCE.md`.

The new CLI bundles selected source modules rather than modifying the published
minified CLI.
No third-party author is represented as endorsing this wrapper.

## Bundled libraries and runtime

`THIRD_PARTY_LICENSES.txt` is generated from the dependency packages actually used
by Bun.build. It includes package versions and complete available LICENSE/NOTICE
texts. Code-level license comments are kept inline in `dist/cli.js`. Standalone
directories include the license collection and CCR license alongside the binary.

Standalone executables include the Bun runtime. The standalone build is pinned
to Bun 1.4.4 and includes `BUN-LICENSE.md`, copied from that exact runtime tag:
https://github.com/oven-sh/bun/blob/bun-v1.4.4/LICENSE.md. Verify redistribution
requirements, including licenses of runtime components referenced there, before
a public release. No wrapper flag for displaying Bun licenses is claimed.

## External clients and service

Claude Code is installed separately and is not included or installed by this
package. Codex/ChatGPT is an external service subject to its own account, access,
usage and subscription terms. This is an independent bridge, not an official
Anthropic or OpenAI client. Access to an OAuth client ID or model name is not a
grant of service access or redistribution rights.
