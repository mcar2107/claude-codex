# claude-codex

Independent Claude Code → Codex OAuth bridge, written in TypeScript (ESM) and
running on Bun. Claude Code remains a separately installed client: it owns
the terminal UI, permissions, tools, MCP, CLAUDE.md and conversation history.
This package supplies a private local transport to Codex; it does not install,
replace or redistribute Claude Code.

**Status: early development.** Standalone binaries are published as
[GitHub prereleases](https://github.com/mcar2107/claude-codex/releases); they
are unsigned and verified only by the checks listed below. No npm package is
published (`private` in `package.json`), and the registry name and public CLI
naming have not been finalized. The original wrapper code is MIT-licensed.
Nothing here promises account access to any model or approval by
Anthropic/OpenAI. Check the service's current account, subscription and usage
terms before using the bridge.

## Requirements and local installation

- macOS or Linux; Windows is not supported or tested.
- Claude Code installed separately as `claude` in `PATH` (an executable, not
  merely a shell alias). Ordinary `claude` is not changed by this package.
- Bundled CLI (`dist/cli.js`): Bun >=1.4.0 in `PATH`.
- Standalone: no separate Node or Bun required. Release binaries are built and
  tested natively for macOS arm64/x64 and Linux x64/arm64 (glibc) with Bun 1.4.4.

### Install a release binary (no Bun)

```sh
curl -fsSL https://raw.githubusercontent.com/mcar2107/claude-codex/master/install.sh | sh
```

The installer picks the newest release (including prereleases) for your OS and
architecture, verifies it against the release `SHA256SUMS`, installs
`claude-codex` into `~/.local/bin` and the license notices into
`~/.local/share/claude-codex`. It does not touch state, settings or Claude
configuration. Options (environment variables):

- `CLAUDE_CODEX_VERSION=v0.1.0`: install a specific release tag.
- `CLAUDE_CODEX_INSTALL_DIR`: executable directory (default `~/.local/bin`).
- `CLAUDE_CODEX_SHARE_DIR`: license notices directory.

Manual install: download `claude-codex-<os>-<arch>.tar.gz` and `SHA256SUMS`
from [GitHub Releases](https://github.com/mcar2107/claude-codex/releases),
check the hash, unpack and put `claude-codex` in `PATH`. Binaries are not
signed or notarized: an archive downloaded by a macOS browser is quarantined,
remove that with `xattr -d com.apple.quarantine claude-codex` (`curl` downloads
are not quarantined). musl-based Linux (Alpine) is not supported.

### Build from the checkout

```sh
bun install
bun run build
bun run build:standalone
bun run test:e2e
```

No npm package is produced. Run the bundle with Bun, or use the standalone
executable (below):

```sh
bun dist/cli.js --help
bun dist/cli.js auth login
bun dist/cli.js doctor
bun dist/cli.js
```

Building does not write settings, tokens, Claude commands or global Claude
configuration.

For standalone, use `artifacts/bun-<os>-<arch>/claude-codex`.
The adjacent license files belong with the binary when redistributing it. You
can relocate it; no project path or runtime assets need to be installed beside
it. Add it to `PATH` if using the optional slash commands.

## Authentication and state

```sh
claude-codex auth status
claude-codex auth login
claude-codex doctor --model gpt-6.1-sol --effort xhigh
```

Login prints an OAuth URL to open in your browser and binds only the loopback
callback at `127.0.0.1:1455`, matching the upstream redirect URI
`http://localhost:1455/auth/callback`. It uses PKCE and an unpredictable state,
expires after five minutes, and can start without any old bridge files. Port
1455 must be free. Headless/browser-remote callback forwarding is not implemented.
Use only your own authorized account; do not share OAuth URLs, tokens or state
files. Status prints presence and expiry only, not token contents. A new login
can change the credentials used by active sessions; finish those sessions
before changing accounts.

User state lives in `~/.claude-codex`, **not in the installed package**. Override
it with an absolute or relative `CLAUDE_CODEX_STATE_DIR` (relative paths resolve
from the current working directory). For example:

```sh
CLAUDE_CODEX_STATE_DIR="$HOME/.claude-codex-test" claude-codex auth login
CLAUDE_CODEX_STATE_DIR="$HOME/.claude-codex-test" claude-codex
```

Files are private (`0600`) and new state/session directories are `0700`:

- `codex_auth.json`: shared OAuth credentials; CCR refresh uses atomic writes
  and a cross-process refresh lock.
- `settings.json`: saved model and reasoning effort, atomically replaced.
- `models.json`: optional account discovery cache, not credentials.
- `session-*`: transient per-session router PID/base URL/start-time metadata.
  Session API keys are random and are not written to this metadata.

Each launch owns its own child router, ephemeral loopback port and API key.
The router binds port zero directly; there is no probe-and-rebind port race.
Exit, SIGINT/SIGTERM and the parent pipe closing stop that session's router.
Normal shutdown removes session metadata. SIGKILL may leave a stale session
folder; no automatic cleanup of unknown session folders is attempted. Never
remove a folder belonging to a live process.

## Model and effort

```sh
claude-codex settings show
claude-codex settings set --model gpt-6.1-sol --effort xhigh
claude-codex settings set --effort high
claude-codex settings preset sol       # Sol high (default)
claude-codex settings preset balanced  # Sol high
claude-codex settings preset fast      # Luna low
claude-codex settings preset max       # Astra max
claude-codex settings reset
claude-codex --model gpt-6-astra --effort high
claude-codex -p 'Your prompt'
```

Defaults are `gpt-6.1-sol` / `high`. Settings are read before **every request**,
including in already-open sessions. Precedence is:

1. Explicit session `--model` / `--effort` flags.
2. `CLAUDE_CODEX_MODEL` / `CLAUDE_CODEX_EFFORT` environment variables.
3. Saved settings, falling back to defaults when no file exists.

Overrides do not modify saved settings. `--` stops bridge flag parsing; use it
only when deliberately passing flags through to Claude. The startup alias in
Claude remains `codex,gpt-6.1-sol`; it is **not verification of the actual upstream
model**. Live settings select the outgoing model. Use `doctor` for a real request
with the active model and to inspect the reported model.

For GPT-6/5.6 this transport permits `low`, `medium`, `high`, `xhigh`, `max`;
`none`/`minimal` are rejected because the pinned Codex transport would clamp them
to `low`. GPT-5.5 permits low/medium/high/xhigh. Older/unknown model handling
follows the bridge's existing validation, not a promise about future services.
Future syntactically valid `gpt-*` IDs can be saved without an allowlist edit,
but may need a transport update (for example, new Responses Lite catalog rules).

```sh
claude-codex models          # local candidates and any cached discovery
claude-codex models refresh  # real account-authenticated discovery request
```

Configured candidates are not an entitlement or access check. Discovery is an
account snapshot; a real request is still definitive. Refresh preserves settings
and the previous cache on failure. It may refresh the OAuth token as needed.

## Optional slash commands

```sh
claude-codex setup
# /codex-settings show
# /codex-model gpt-6.1-sol
# /codex-effort high
claude-codex setup --remove
```

Setup is explicit and installs only these names, under the Claude configuration
commands directory (`CLAUDE_CONFIG_DIR` or `~/.claude`). It refuses to replace or
remove modified/foreign files and is idempotent. Claude sessions launched by the
bridge inherit the selected state directory, so slash commands update the same
state. The CLI must be in `PATH`.

## Transport and builds

The production path bundles a pinned source subset from
`oakimov/claude-code-router` revision
`5cb26917d02b8ec5d0e849271a204a6b5dbb9ca1` (`v2.1.16`, core `1.0.74`).
`src/transport/server.ts` explicitly composes its services and awaits
initialization. `scripts/build.ts` supplies source-level integration aliases as a
`Bun.build` plugin.
No minified bundle regex replacement or private minifier symbol is used by the
new CLI. This is a maintained adapter against a pinned revision, not a guarantee
that upstream source APIs will remain stable.

Only the Anthropic/OpenAI/Responses/Codex transformer registry is linked. CCR's
UI, other providers and admin API are not exposed by this CLI. A request must
have the private session key, and only the local health/models/messages/token
count endpoints are reachable. tiktoken bindings and WASM are embedded in the
JS bundle and consequently in the compiled binary. Token counting remains exact
but runs synchronously instead of using upstream's eval/on-disk-package worker;
large requests can therefore delay the event loop.

```sh
bun run build:standalone
bun run build:standalone --target bun-darwin-x64
bun run build:standalone --target bun-linux-x64
bun run build:standalone --target bun-linux-arm64
```

The build script supports these targets and pins Bun 1.4.4 for matching runtime
notices. Cross-compilation does not prove runtime support. Current evidence:

| Target | Evidence |
| --- | --- |
| macOS arm64 | Native compile, relocated executable, local server/client lifecycle without Node/Bun in PATH; compiled mock transport/OAuth tests; release CI (`macos-15`) |
| macOS x64 | Release CI on `macos-15-intel`: native compile, offline, compiled and e2e tests |
| Linux x64 | Release CI on `ubuntu-24.04`: native compile, offline, compiled and e2e tests |
| Linux arm64 | Release CI on `ubuntu-24.04-arm`: native compile, offline, compiled and e2e tests |
| Windows | Not supported |

macOS signing/notarization is outstanding. No automatic upstream submission is
performed.

### Releases

`.github/workflows/release.yml` runs on a pushed `v*` tag. The tag must equal
`v` + the `package.json` version. Each target is built and tested on its own
native runner (typecheck, offline tests, compiled tests, e2e), packed as
`claude-codex-<os>-<arch>.tar.gz` with the license notices, and published to a
GitHub release together with `SHA256SUMS`. A version with a suffix
(`0.1.0-dev.1`) becomes a prerelease. Manual `workflow_dispatch` runs only
build and test, without publishing.

```sh
# bump "version" in package.json, commit, then:
git tag v0.1.0 && git push origin v0.1.0
```

## Verification and remaining release gates

```sh
bun run test
bun scripts/test.ts --standalone
bun run build:standalone
bun run test:e2e
```

Tests use temporary state, fake credentials and mock upstream responses; no real
token is read. Coverage includes settings/override validation, five model IDs
without restarting the handler, Responses Lite, tool call/result conversion,
incremental SSE, a real loopback client's cancellation of a mocked upstream
stream, provider errors, clean PKCE callback, invalid state, timeout cleanup,
mocked token refresh/deduplication and safe slash setup.
The compiled harness runs those same scenarios with no Node/Bun in PATH.

End-to-end tests run both `dist/cli.js` and the relocated native standalone
executable (the latter without Node/Bun in PATH) against real local child
servers and a **fake external Claude client**: embedded WASM, client exit
status, parallel sessions, termination and session cleanup.

Real smoke verification on 2026-11-03: browser/account login through the native
standalone succeeded, followed by a real `doctor` request using
`gpt-6.1-sol` / `xhigh`. The returned model was `gpt-6.1-sol`, the answer was
exactly `ok`, and doctor passed. This proves that one non-streaming Messages
request traversed the local router and real Codex transport; it does not prove
real streaming/tool execution or access to other model IDs.

Not yet verified: real model discovery, real Claude streaming/tool execution
through this adapter, real quota/429 and expired/revoked-token recovery,
cross-process refresh races, other target OSes, and signing/notarization.
Run account-specific smoke tests before switching production usage. Never infer
success from mock tests or a model label alone.

## Upgrade and uninstall

Re-run the installer (or set `CLAUDE_CODEX_VERSION`), rebuild from an updated
checkout or replace the standalone executable. Settings and tokens stay in the
external state directory. Review model/transport
compatibility before upgrading.

```sh
claude-codex setup --remove   # only if setup was used
```

Then remove the executable and its accompanying notices (installer defaults:
`~/.local/bin/claude-codex` and `~/.local/share/claude-codex`). This does not delete
`~/.claude-codex`. Stop all sessions, back up or revoke
credentials as appropriate, and remove that directory yourself only if you want
to permanently erase local state. Uninstalling is not service-side token revocation.

## Licenses

The wrapper's own code is released under the MIT License (`LICENSE`).
Third-party components keep their own licenses: see `THIRD_PARTY_NOTICES.md`,
generated `THIRD_PARTY_LICENSES.txt` and `vendor/ccr/LICENSE`. CCR's MIT notice
is retained; code-level license comments stay inline in `dist/cli.js`.
The standalone directory additionally contains exact-version Bun notices.
Every release archive ships all of these notices next to the binary, and
`install.sh` copies them to `~/.local/share/claude-codex`. The Bun runtime
statically links LGPL-2 components (JavaScriptCore/WebKit, tinycc); this
repository's full source and build scripts are public, so the binary can be
rebuilt against a modified Bun as described in `BUN-LICENSE.md`.
