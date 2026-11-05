# claude-codex

Run Claude Code on Codex models through your own Codex (ChatGPT) OAuth login.

Claude Code stays a separately installed client: it keeps the terminal UI,
permissions, tools, MCP, CLAUDE.md and history. For each session `claude-codex`
starts a private local router (a pinned subset of
[claude-code-router](https://github.com/oakimov/claude-code-router)) that
translates the Anthropic Messages API into the Codex Responses API. It does not
install, modify or redistribute Claude Code; plain `claude` keeps working as
before.

This project is not affiliated with Anthropic or OpenAI and grants no model
access — check your account's terms before using it.

## Quick start

```sh
curl -fsSL https://raw.githubusercontent.com/mcar2107/claude-codex/master/install.sh | sh
claude-codex auth login   # opens an OAuth URL, callback on 127.0.0.1:1455
claude-codex doctor       # one real request to check the setup
claude-codex              # start Claude Code on Codex
```

Requirements: macOS or Linux (glibc; Alpine and Windows are not supported) and
Claude Code installed as an executable `claude` in `PATH` (a shell alias is not
enough).

## Installation

### Release binary

The installer picks the newest release (prereleases included) for your OS and
architecture, verifies it against `SHA256SUMS` and installs:

- `claude-codex` into `~/.local/bin`;
- license notices into `${XDG_DATA_HOME:-~/.local/share}/claude-codex`.

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CODEX_VERSION` | install a specific tag, e.g. `v1.1.0` |
| `CLAUDE_CODEX_INSTALL_DIR` | executable directory |
| `CLAUDE_CODEX_SHARE_DIR` | license notices directory |

Manual install: download `claude-codex-<os>-<arch>.tar.gz` and `SHA256SUMS` from
[GitHub Releases](https://github.com/mcar2107/claude-codex/releases), check the hash, unpack and put `claude-codex` in `PATH`. A
browser-downloaded archive on macOS is quarantined:
`xattr -d com.apple.quarantine claude-codex`.

Release binaries are built and tested natively for macOS arm64/x64 and Linux
x64/arm64 and need neither Node nor Bun.

### From source

Requires Bun ≥ 1.4.0.

```sh
bun install
bun run build              # dist/cli.js, run with: bun dist/cli.js
bun run build:standalone   # artifacts/bun-<os>-<arch>/claude-codex
```

The standalone binary is relocatable; keep the license files next to it when
redistributing.

## Commands

| Command | What it does |
| --- | --- |
| `claude-codex [launch] [--model ID] [--effort LEVEL] [args…]` | start a Claude Code session; other arguments go to Claude, `--` stops bridge flag parsing |
| `claude-codex auth login` / `auth status` | OAuth login; status shows presence and expiry only |
| `claude-codex doctor [--model ID] [--effort LEVEL]` | one real non-streaming request upstream |
| `claude-codex settings show\|set\|preset\|reset` | saved starting model and effort |
| `claude-codex models [refresh]` | list candidate models; `refresh` queries the account |
| `claude-codex update [vX.Y.Z]` | self-update the release binary |
| `claude-codex setup --remove` | remove global `/codex-*` commands installed by earlier versions |

`claude-codex -p 'prompt'` and other Claude Code flags pass through as usual.

## Models and effort

### Starting model

Default: `gpt-6.1-sol` / `high`. The starting model and effort come from, in
order of priority:

1. `--model` / `--effort` flags;
2. `CLAUDE_CODEX_MODEL` / `CLAUDE_CODEX_EFFORT`;
3. saved settings.

```sh
claude-codex settings set --model gpt-6.1-sol --effort xhigh
claude-codex settings preset sol        # Sol high (default)
claude-codex settings preset balanced   # Sol medium
claude-codex settings preset fast       # Luna low
claude-codex settings preset max        # Astra max
claude-codex settings reset
```

Flags and environment do not change saved settings. Saved settings are read once
at launch: changing them affects new sessions only.

### Switching inside a session

Use Claude Code's own `/model` and `/effort`. The `/model` picker shows only
Codex models (`GPT-6.1 Sol` etc.). The router takes model and effort from each
request; requests without a Codex model (Claude aliases, background tasks) or
without effort fall back to the session's starting values.

In `/model`, **`s`** switches the current session only, while **Enter** also
saves the model to `~/.claude/settings.json` (`CLAUDE_CONFIG_DIR`). On exit the
bridge restores the previous `model` there if the session replaced it with a
`codex,…` ID, and says so; after a SIGKILL the next launch warns instead.

### Effort levels

| Model | Allowed |
| --- | --- |
| GPT-6, GPT-5.6 | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.5 | `low`, `medium`, `high`, `xhigh` |

An unsupported level is lowered to the nearest supported one (`max` → `xhigh` on
GPT-5.5). `none` and `minimal` are rejected. New `gpt-*` IDs can be saved without
a code change but may need a transport update to work.

### Discovery

```sh
claude-codex models           # local candidates and cached discovery
claude-codex models refresh   # real request to the account
```

Discovered models are added to `/model`. If discovery reports a context window,
a session started on that model sets `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (unless
already set), so the context meter and auto-compaction match the real window;
the value is fixed at launch. A model in the list is not proof of access — only
a real request is.

### Which model actually answered

The model label in Claude and the model's self-description prove nothing. Each
session records its last request:

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

`client` is what Claude Code sent, `upstream` what went to Codex after effort
adjustment, `returnedModel` what Codex reported. Background requests (titles,
summaries) overwrite the file too, so check it right after your message.

## Session commands

Each session loads a session-only plugin, so these work without setup and only
inside claude-codex sessions:

```text
/codex:settings show
/codex:settings preset fast
/codex:settings set --model gpt-6-astra --effort max
/codex:models refresh
```

They change defaults for **new** sessions; use `/model` and `/effort` for the
current one. Nothing is written to the Claude configuration directory.

## Status line

Behind a custom `ANTHROPIC_BASE_URL` Claude Code does not fill `rate_limits` in
the status line JSON. If you have a `statusLine` configured, the bridge wraps it
for the session and adds Codex limits as `rate_limits.five_hour` /
`rate_limits.seven_day` (`used_percentage`, `resets_at`) — the same schema Claude
Code uses for subscriptions. Your command runs unchanged; scripts that ignore
`rate_limits` behave as before.

- The wrapped command is resolved like Claude Code does: `--settings`, then
  `.claude/settings.local.json`, `.claude/settings.json`, user settings. A
  managed-settings `statusLine` is not wrapped.
- Expired windows are dropped; `rate_limits` sent by Claude itself are kept.
- Limits come from `x-codex-primary-*` / `x-codex-secondary-*` response headers.
  These names are not yet confirmed against real Codex responses; if absent,
  nothing is added.

## State and security

State lives in `~/.claude-codex` (override with `CLAUDE_CODEX_STATE_DIR`). Files
are `0600`, directories `0700`.

| Path | Contents |
| --- | --- |
| `codex_auth.json` | OAuth credentials; refresh is atomic and locked across processes |
| `settings.json` | saved model and effort |
| `models.json` | discovery cache |
| `session-*` | per-session router metadata, Claude settings, plugin, status line data, last request (models and effort only, no prompts), last tool argument guard trip (`tool-guard.json`) |

- Each session gets its own router, random loopback port and random API key; the
  key is never written to disk. Only health, models, messages and token count
  endpoints are exposed.
- Exit, SIGINT/SIGTERM/SIGHUP and closing the terminal stop the router and remove
  session metadata. SIGKILL may leave a stale `session-*` folder; delete it only
  if its process is gone.
- Login uses PKCE, expires in five minutes and needs port 1455 free. Headless
  login (callback forwarding) is not supported.
- A new login affects running sessions; finish them before switching accounts.
- Never share OAuth URLs, tokens or state files.

## Update and uninstall

```sh
claude-codex update                 # latest release on the current channel
claude-codex update v1.1.0-dev.1    # specific tag, including downgrade
```

A stable binary follows stable releases, a prerelease binary follows all
releases; without a tag `update` never downgrades. The new binary is verified
against `SHA256SUMS` and run with `--version` before replacing the old one; any
failure keeps the old binary. Restart running sessions afterwards. License
notices are refreshed only if their directory exists.

`claude-codex update` updates the bridge, not Claude Code — use `claude update`.
`dist/cli.js` does not self-update: rebuild from an updated checkout.

To uninstall, remove `~/.local/bin/claude-codex` and
`${XDG_DATA_HOME:-~/.local/share}/claude-codex` (run `claude-codex setup --remove`
first if an earlier version's `setup` was used). State in `~/.claude-codex` is left
alone; delete it yourself to erase credentials locally. That does not revoke the
token on the service side.

## Limitations

- Verified for real (2026-11-03): login and one non-streaming `doctor` request
  with `gpt-6.1-sol` / `xhigh` through the standalone binary.
- Not yet verified for real: streaming and tool execution, model discovery,
  quota/429 handling, expired/revoked token recovery, cross-process refresh
  races, Codex limit headers.
- Auto mode server-side safeguards are off in bridged sessions: the bridge sets
  `CLAUDE_CODE_AUTO_MODE_SERVER=0` for the Claude client, overriding your own
  value, because Codex returns no server verdicts. The client runs its own
  classifier requests instead
  ([classifier billing](https://code.claude.com/docs/en/auto-mode-classifier-billing)).
- Codex sometimes loops on whitespace inside tool call arguments and never
  finishes the response. The router stops such a stream after 256 whitespace
  characters in a row outside JSON strings: if the arguments close with
  brackets, Claude Code gets a finished tool call; otherwise it gets an error
  and the request can be retried. Repetition of other text is not detected.
- Binaries are not signed or notarized.
- Token counting is exact but synchronous; very large requests can briefly
  block the router.

Run your own smoke test before relying on it; mock tests and model labels are
not proof.

## Development

```sh
bun run test                   # offline tests: temp state, fake credentials, mocked upstream
bun scripts/test.ts --standalone
bun run test:e2e               # bundle and standalone against a fake Claude client
bun run lint
bun run build:standalone --target bun-linux-arm64   # also bun-darwin-x64, bun-linux-x64
```

The transport is `oakimov/claude-code-router` at
`5cb26917d02b8ec5d0e849271a204a6b5dbb9ca1` (`v2.1.16`, core `1.0.74`), vendored
unmodified in `vendor/ccr`. Only the Anthropic/OpenAI/Responses/Codex
transformers are linked; CCR's UI, other providers and admin API are not.
Integration is done with source-level aliases in `scripts/build.ts`, not bundle
patching.

**Releases.** Pushing a `v*` tag equal to `v` + `package.json` version runs
`.github/workflows/release.yml`: each target is built and tested on a native
runner (macOS 15 arm64/Intel, Ubuntu 24.04 x64/arm64), packed with license
notices and published with `SHA256SUMS`. Versions with a suffix
(`1.2.0-dev.1`) become prereleases; `workflow_dispatch` builds and tests without
publishing.

```sh
# bump "version" in package.json, commit, then:
git tag v1.2.0 && git push origin v1.2.0
```

## Licenses

The wrapper is MIT (`LICENSE`). Third-party components keep their licenses: see
`THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.txt` and `vendor/ccr/LICENSE`;
release archives and the installer ship them with the binary. The Bun runtime
statically links LGPL-2 components (JavaScriptCore/WebKit, tinycc); since the
full source and build scripts are public, the binary can be rebuilt against a
modified Bun as described in `BUN-LICENSE.md`.
