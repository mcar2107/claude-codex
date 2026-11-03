# claude-codex

Independent Claude Code → Codex OAuth bridge, written in JavaScript/TypeScript
and running on Bun. Claude Code remains a separately installed client: it owns
the terminal UI, permissions, tools, MCP, CLAUDE.md and conversation history.
This package supplies a private local transport to Codex; it does not install,
replace or redistribute Claude Code.

**Status: local distribution candidate, not a public release.** The package is
`private`, version `0.1.0-dev.0`, with `UNLICENSED` original wrapper code until a
project license is selected. Registry name availability, scope, repository,
release account and public CLI naming have not been finalized. Nothing here
promises account access to any model or approval by Anthropic/OpenAI. Check the
service's current account, subscription and usage terms before using the bridge.

## Requirements and local installation

- macOS or Linux; Windows is not supported or tested.
- Claude Code installed separately as `claude` in `PATH` (an executable, not
  merely a shell alias). Ordinary `claude` is not changed by this package.
- npm CLI: Node >=22 for npm tooling and Bun >=1.4.0 in `PATH`.
- Standalone: no separate Node or Bun required. Current native validation is
  macOS arm64, built with Bun 1.4.4; other platforms are unverified.

From the checkout:

```sh
npm ci --ignore-scripts
bun run build
bun run build:standalone
bun run test:package
```

`test:package` produces and checks `artifacts/claude-codex-0.1.0-dev.0.tgz`.
Install the local archive explicitly (this writes the normal npm installation):

```sh
npm install -g ./artifacts/claude-codex-0.1.0-dev.0.tgz
claude-codex --help
claude-codex auth login
claude-codex doctor
claude-codex
```

There is no `postinstall` hook. Installation does not write settings, tokens,
Claude commands or global Claude configuration. The new CLI does not replace
`ccr` or existing `claude-gpt*` commands. No npm registry publication is needed.

For standalone, use `artifacts/bun-darwin-arm64/claude-codex` on the tested host.
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
files. Status prints presence and expiry only, not token contents.

User state lives in `~/.claude-codex`, **not in the installed package**. Override
it with an absolute or relative `CLAUDE_CODEX_STATE_DIR` (relative paths resolve
from the current working directory). `CLAUDE_GPT_STATE_DIR` remains a fallback;
the new variable takes precedence. For example:

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

### Explicit migration

The new CLI never automatically imports credentials. To copy from an old bridge:

```sh
claude-codex migrate --from /absolute/path/to/old-project/.runtime
# Or the original bridge's ~/.claude-code-router directory:
claude-codex migrate --from "$HOME/.claude-code-router"
```

Only supported settings and `codex_auth.json` / `codex-auth.json` are imported.
Bundles, logs, backups and other config are not copied. Existing destination
settings or credentials are never overwritten. Source files are unchanged.
Prefer a fresh login when switching clients. Do not run two different bridges
that independently refresh copies of the same OAuth refresh token; rotation can
invalidate the other copy. A new login can also change the credentials used by
active sessions; finish those sessions before changing accounts.

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
2. `CLAUDE_GPT_MODEL` / `CLAUDE_GPT_EFFORT` environment variables.
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
remove modified/foreign files and is idempotent. Existing `/gpt-*` commands are
not changed. Claude sessions launched by the bridge inherit the selected state
directory, so slash commands update the same state. The CLI must be in `PATH`.
No legacy alias replacement is part of the new setup.

## Transport and builds

The production path bundles a pinned source subset from
`oakimov/claude-code-router` revision
`5cb26917d02b8ec5d0e849271a204a6b5dbb9ca1` (`v2.1.16`, core `1.0.74`).
`src/transport/server.ts` explicitly composes its services and awaits
initialization. `scripts/build.cjs` supplies source-level integration aliases.
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
| macOS arm64 | Native compile, relocated executable, local server/client lifecycle without Node/Bun in PATH; compiled mock transport/OAuth tests |
| macOS x64 | Build target defined; not compiled or run here |
| Linux x64 | Build target defined; not compiled or run here |
| Linux arm64 | Build target defined; not compiled or run here |
| Windows | Not supported |

macOS signing/notarization and Linux runtime testing are outstanding before
public release. No automatic upstream submission or public release is performed.

## Verification and remaining release gates

```sh
bun run test
bun scripts/test.cjs --standalone
bun run build:standalone
bun run test:package
bun run test:legacy
```

Tests use temporary state, fake credentials and mock upstream responses; no real
token is read. Coverage includes settings/override validation, five model IDs
without restarting the handler, Responses Lite, tool call/result conversion,
incremental SSE, a real loopback client's cancellation of a mocked upstream
stream, provider errors, clean PKCE callback, invalid state, timeout cleanup,
mocked token refresh/deduplication, migration conflicts and safe slash setup.
The compiled harness runs those same scenarios with no Node/Bun in PATH.

Package tests check both `npm pack --dry-run` and the actual `.tgz` against an
exact file allowlist, install it with no dev dependencies, launch real local
child servers and a **fake external Claude client**, exercise embedded WASM,
parallel sessions and termination, and compare state bytes after reinstalling
the same package. This establishes reinstall preservation, not all future-version
migrations. They also test the relocated native product executable without
Node/Bun in PATH. Generated test harnesses and build metadata are excluded from
the archive, as are `.runtime`, tokens, backups, logs and local launchers.

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

Install a replacement local tarball using the normal npm command. Settings and
tokens stay in the external state directory; do not run migration again over an
existing destination. Review model/transport compatibility before upgrading.

```sh
claude-codex setup --remove   # only if setup was used
npm uninstall -g claude-codex
```

Standalone users can remove the executable and its accompanying notices instead.
Neither method deletes `~/.claude-codex`. Stop all sessions, back up or revoke
credentials as appropriate, and remove that directory yourself only if you want
to permanently erase local state. Uninstalling is not service-side token revocation.

## Legacy local installation / rollback

The original `bridge.cjs`, `lib.cjs`, `settings.cjs`, `live-settings.cjs`,
`prepare.cjs`, `install.cjs` and `bin/claude-gpt*` remain for compatibility and
are not shipped in the new tarball. They continue using `.runtime` and the
original patched transport. The old project path `~/Projects/claude-sol-router`
remains a compatibility symlink; do not remove it while external launchers or
active sessions still reference it.

No existing global launcher, slash command, OAuth file or legacy bundle was
replaced while preparing the new package. Packaging metadata/README backups are
stored privately under `.runtime/packaging-backup-*`. Legacy `install.cjs` is a
historical migration utility, **not** the installer for this package; do not run
it to install the new CLI. Its existing rollback manifest is still available for
the previous local installation.

## Licenses

See `LICENSE`, `THIRD_PARTY_NOTICES.md`, generated `THIRD_PARTY_LICENSES.txt`,
`dist/cli.cjs.LEGAL.txt` and `vendor/ccr/LICENSE`. CCR's MIT notice is retained.
The standalone directory additionally contains exact-version Bun notices.
Select the wrapper's own license and review redistribution requirements before
public release; this local candidate deliberately does not guess that decision.
