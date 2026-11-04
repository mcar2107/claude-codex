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
`$XDG_DATA_HOME/claude-codex` (`~/.local/share/claude-codex` when
`XDG_DATA_HOME` is unset). It does not touch state, settings or Claude
configuration. Options (environment variables):

- `CLAUDE_CODEX_VERSION=v0.1.0`: install a specific release tag.
- `CLAUDE_CODEX_INSTALL_DIR`: executable directory (default `~/.local/bin`).
- `CLAUDE_CODEX_SHARE_DIR`: license notices directory (default
  `${XDG_DATA_HOME:-~/.local/share}/claude-codex`).

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
it.

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
- `session-*`: transient per-session router PID/base URL/start-time metadata,
  the session's Claude settings file, plugin, `claude-codex` launcher, status
  line wrapper data, latest Codex limit snapshot and last request record
  (models and effort only, no prompts). Session API keys are
  random and are not written to any of these files.

Each launch owns its own child router, ephemeral loopback port and API key.
The router binds port zero directly; there is no probe-and-rebind port race.
Exit, SIGINT/SIGTERM/SIGHUP (closing the terminal tab) and the parent pipe
closing stop that session's router; the signal is passed on to Claude.
Normal shutdown removes session metadata. SIGKILL may leave a stale session
folder; no automatic cleanup of unknown session folders is attempted. Never
remove a folder belonging to a live process.

## Model and effort

```sh
claude-codex settings show
claude-codex settings set --model gpt-6.1-sol --effort xhigh
claude-codex settings set --effort high
claude-codex settings preset sol       # Sol high (default)
claude-codex settings preset balanced  # Sol medium
claude-codex settings preset fast      # Luna low
claude-codex settings preset max       # Astra max
claude-codex settings reset
claude-codex --model gpt-6-astra --effort high
claude-codex -p 'Your prompt'
```

Defaults are `gpt-6.1-sol` / `high`. Saved settings, flags and environment pick
the **starting** model and effort of a session. Precedence is:

1. Explicit session `--model` / `--effort` flags.
2. `CLAUDE_CODEX_MODEL` / `CLAUDE_CODEX_EFFORT` environment variables.
3. Saved settings, falling back to defaults when no file exists.

Overrides do not modify saved settings. `--` stops bridge flag parsing; use it
only when deliberately passing flags through to Claude.

Inside a session, switch with Claude Code's own `/model` and `/effort`. The
`/model` picker lists only Codex models (`codex,gpt-…`, labeled `GPT-6.1 Sol`
and so on; Claude's built-in rows are hidden), passed to Claude through a
session-only `--settings` file. The router takes the model and effort from each
request; a request without a Codex model (a Claude alias, a background task)
uses the session's starting model, and a request without effort uses its
starting level. An effort the model does not support is lowered to the nearest
supported level (for example `max` → `xhigh` on GPT-5.5). Saved settings are
read once when a session starts: changing them (`claude-codex settings`,
`/codex:settings`) sets the default for new sessions and does not affect open
ones.

In `/model`, **Enter** saves the choice as Claude Code's default in
`~/.claude/settings.json` (`CLAUDE_CONFIG_DIR`), while **`s`** switches only the
current session. Plain `claude` would then start with a Codex model, so on exit
the bridge restores the previous `model` value when the session replaced it with
a `codex,…` ID, and prints what it changed. Any other edit of that file is left
alone. A session killed with SIGKILL cannot restore it; the next launch warns
when that file already holds a Codex model. `/effort` levels are saved by
Claude Code per model ID, so they do not affect Claude models.

The model label in Claude, and what the model says about itself, are **not
verification of the actual upstream model**. To check what a running session
really sends, read its last request record from another terminal:

```sh
cat ~/.claude-codex/session-*/last-request.json
```

```json
{
  "at": "2026-11-04T15:39:12.000Z",
  "client": { "model": "codex,gpt-6-luna", "effort": "low" },
  "upstream": { "model": "gpt-6-luna", "effort": "low" },
  "returnedModel": "gpt-6-luna"
}
```

`client` is what Claude Code sent, `upstream` is what the bridge sent to Codex
after choosing the model and lowering the effort, and `returnedModel` is
`response.model` from the first event of the Codex stream. Background requests
(titles, summaries) also update the file, so look at it right after your own
message. Use `doctor` for a one-off real request with the starting model.

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
Discovered models are added to the `/model` picker. When discovery reports a
model's context window, a session started on that model sets
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` (unless already set), so Claude Code's context
percentage and auto-compaction use the real window; otherwise Claude Code
assumes 200k. The value is fixed at launch and does not follow `/model`.

## Session commands

Every session loads a session-only plugin (`--plugin-dir`) from its private
session directory, so these commands are available without any setup and exist
only inside claude-codex sessions:

```text
/codex:settings show
/codex:settings preset fast
/codex:settings set --model gpt-6-astra --effort max
/codex:models refresh
```

They change the saved defaults for new sessions; switch the current session
with `/model` and `/effort`. A `claude-codex` launcher for the session is put
first in the client's `PATH`, so the commands work even when the bridge itself
is not in `PATH`. Nothing is written to the Claude configuration directory.

Earlier versions installed global `/codex-settings`, `/codex-model` and
`/codex-effort` commands with `claude-codex setup`. Remove them with
`claude-codex setup --remove`; it refuses to delete modified or foreign files.

## Status line

Claude Code fills `rate_limits` in the status line JSON only for claude.ai
subscription and Claude apps gateway sign-ins; behind a custom
`ANTHROPIC_BASE_URL` it ignores rate limit headers. The bridge therefore keeps
the latest Codex limits from the upstream response headers in the session
directory and, when a `statusLine` command is configured, wraps it for this
session: the wrapper adds `rate_limits.five_hour` / `rate_limits.seven_day`
(`used_percentage`, `resets_at`) in the same schema Claude Code uses for
subscriptions and runs your command unchanged with that JSON. Scripts that do
not read `rate_limits` behave exactly as before; with no `statusLine`, nothing
is wrapped. Windows that already reset are dropped, and `rate_limits` sent by
Claude itself are never overwritten.

The wrapped command is the one Claude Code would use: from `--settings`, then
`.claude/settings.local.json` and `.claude/settings.json` in the current
directory, then user settings. A `statusLine` in managed settings is not
wrapped, since it takes precedence over the session flag anyway. Your own
`--settings` (JSON or file) is merged into the session settings file.

Codex limits are read from `x-codex-primary-*` / `x-codex-secondary-*`
response headers (`used-percent`, `window-minutes`, `reset-at` or
`reset-after-seconds`); 300-minute and 10080-minute windows map to `five_hour`
and `seven_day`. These header names have not yet been confirmed against a real
Codex response; when they are absent, no `rate_limits` are added.

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
mocked token refresh/deduplication, client-selected model/effort, Codex limit
snapshots and the status line wrapper, session plugin and settings, restoring
a Codex `model` in user settings, and safe removal of legacy slash commands.
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
claude-codex setup --remove   # only if an earlier version's setup was used
```

Then remove the executable and its accompanying notices (installer defaults:
`~/.local/bin/claude-codex` and `${XDG_DATA_HOME:-~/.local/share}/claude-codex`). This does not delete
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
`install.sh` copies them to `${XDG_DATA_HOME:-~/.local/share}/claude-codex`. The Bun runtime
statically links LGPL-2 components (JavaScriptCore/WebKit, tinycc); this
repository's full source and build scripts are public, so the binary can be
rebuilt against a modified Bun as described in `BUN-LICENSE.md`.
