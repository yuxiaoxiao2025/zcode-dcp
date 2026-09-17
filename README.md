# zcode-dcp

**Dynamic Context Pruning for ZCode** — a ZCode-native plugin port of
[`@tarquinen/opencode-dcp` v3.1.15](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
(AGPL-3.0-or-later).

It prunes obsolete tool outputs from the model context via a local proxy
(`127.0.0.1:8367`), reducing token spend on long sessions while leaving
session history and the UI untouched.

[![test](https://github.com/yuxiaoxiao2025/zcode-dcp/actions/workflows/test.yml/badge.svg)](https://github.com/yuxiaoxiao2025/zcode-dcp/actions/workflows/test.yml)

---

## What

zcode-dcp runs a small local HTTP daemon that sits between a ZCode custom
provider and your real model endpoint. The proxy only edits the
`messages` array of outbound requests (deduplication, purge of error
outputs, summary replacement, nudge injection). Everything else — every
other request field, every response byte, SSE streams, `usage`, response
headers — is forwarded byte-for-byte.

Your session log and the UI's conversation history are never modified.
Only the request body the model actually receives is trimmed.

---

## How it works

```
┌──────────┐  custom provider   ┌──────────────┐  upstream   ┌────────────┐
│  ZCode   │ ────────────────▶  │  local proxy │ ──────────▶ │  upstream  │
│  client  │  http://127.0.0.1  │  127.0.0.1:  │  HTTPS      │  Anthropic │
│          │       :8367        │      8367    │             │  endpoint  │
└──────────┘                    └──────────────┘             └────────────┘
                                       │
                                       ▼
                          edit messages[] only
                          (dedup / purge-errors /
                           summary-replace / nudge)
                          forward everything else
                          byte-for-byte
```

Pruning strategies (ported 1:1 from DCP v3.1.15):

- **Deduplication** — for the same tool + same parameters, only the most
  recent output is kept; older duplicates are replaced with a placeholder.
- **PurgeErrors** — tool outputs that returned an error are pruned after
  N turns (default 4), while the error message itself stays.
- **Summary replacement** — when the model calls the `compress` MCP tool,
  its own summary is substituted for the compressed span.
- **Nudge injection** — when context approaches the configured limit,
  the proxy injects a nudge message guiding the model to compress.

Protected tools (`TodoWrite`, `Agent`, `Skill`, `Write`, `Edit`, …) are
never pruned.

---

## Install

The repo root **is** the plugin (marketplace manifest at
`.claude-plugin/marketplace.json`, plugin source `./`). Two ways to install:

### Option 1 — git marketplace (recommended, no clone needed)

1. **Add the marketplace.** Settings → Plugins → Add plugin marketplace →
   pick **Git repository** → enter `https://github.com/yuxiaoxiao2025/zcode-dcp`.
2. **Install and enable** `zcode-dcp`.

### Option 2 — local directory (offline machines / your own fork)

1. **Clone this repo** anywhere (or download the zip and extract it).
2. Create a `marketplace.json` in its own folder, replacing
   `<absolute-path-to-your-clone>` with the real path:

   ```json
   {
     "name": "zcode-dcp-local",
     "plugins": [
       {
         "name": "zcode-dcp",
         "source": { "source": "directory", "path": "<absolute-path-to-your-clone>" },
         "description": "Dynamic Context Pruning for ZCode (local copy)",
         "version": "0.1.4"
       }
     ]
   }
   ```

   > The `path` must be **absolute** — the ZCode client does not support
   > relative traversal in directory sources.
3. Settings → Plugins → Add plugin marketplace → pick **Local directory** →
   select that folder. Install and enable `zcode-dcp`.

### After installing (both options)

1. **Restart ZCode or open a new session.** Plugin hooks and the MCP
   server are snapshotted per session.
2. **Confirm the proxy is up.** In a new session, run `/dcp-stats`. It
   should return statistics. (If it reports `daemon unreachable`, restart
   ZCode, or run `node <plugin root>/hooks/session-start.mjs`.)
3. **Read the admin token.** The plugin data directory lives under
   `~/.zcode/cli/plugins/data/` (look for the `zcode-dcp`-related
   folder). `cat` the `admin-token` file inside it.
4. **Add the proxy as a ZCode custom provider — must be done through the
   UI.** Hand-editing `~/.zcode/v2/config.json` or `cli/config.json`
   does **not** take effect: the UI only honors its own registry, and
   `config.json` is a one-way export bridge.
   - Settings → Model Settings → Add Provider
   - Name: anything you like (e.g. `DCP Proxy`)
   - Protocol: **Anthropic**
   - Endpoint: `http://127.0.0.1:8367`
   - API Key: paste the `admin-token` contents (**must not be empty**)
   - Model ID: `GLM-5.3` (or any model ID your upstream supports)
   - Enable the provider
5. **Switch the model selector** to that provider's model.
6. **Verify.** Run a task with repeated file reads, then `/dcp-stats`
   again to see the savings.

> The UI provider you add in step 4 points to the local proxy
> (`http://127.0.0.1:8367`). The proxy's `upstream.baseUrl` /
> `upstream.apiKey` (configured below in `dcp.jsonc`) point to your real
> model endpoint. These are two different things.

---

## Configure

| Scope   | Path                              | Purpose                                                                 |
|---------|-----------------------------------|-------------------------------------------------------------------------|
| User    | `~/.zcode/dcp/dcp.jsonc`          | Default config (created on first run or by the setup guide)             |
| Project | `<workspace>/.zcode/dcp.jsonc`    | Project-level overrides; merged as a **union of arrays** with the user file |

Set `$schema` in your config to the bundled `dcp.schema.json` for IDE
autocompletion:

```jsonc
{
  "$schema": "./dcp.schema.json",
  "upstream": {
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "apiKey": "your-real-provider-key"
  },
  "proxy": {
    "port": 8367
  },
  "debug": false
}
```

Config changes take effect in **new sessions**.

> **Important — configure `upstream` before step 5.** With an empty
> `upstream` the proxy returns **502** for every request, so the proxy
> provider you add in step 5 will appear connected but model calls will
> fail until `dcp.jsonc` has `baseUrl` + `apiKey`.

### Key ZCode-only sections

- `proxy.port` — TCP port the local daemon listens on (loopback only;
  default `8367`).
- `proxy.idleTimeoutMin` — minutes of inactivity before the daemon
  self-terminates (`0` = run forever).
- `proxy.adminTokenFile` — filename inside the plugin data directory
  holding the bearer token (default `admin-token`).
- `upstream.baseUrl`, `upstream.apiKey` — real model endpoint and key
  the proxy forwards to. **Empty by default** — must be configured.
- `contextWindow` — explicit context-window token size for the upstream
  model; otherwise the proxy uses the upstream provider's advertised
  window.

Everything else (`strategies`, `compress`, `manualMode`,
`protectedFilePatterns`, …) is carried over from the upstream DCP
schema. See `dcp.schema.json` at the repo root for the full reference.

---

## Usage

### Slash commands

| Command                | Effect                                                              |
|------------------------|---------------------------------------------------------------------|
| `/dcp-compress [focus]` | Manually trigger a compression (optionally with a focus string).    |
| `/dcp-stats`            | Real sent / saved tokens, per-strategy hits, cache hit rate.        |
| `/dcp-context`          | Estimated composition of the assembled context.                     |
| `/dcp-sweep [N]`        | Immediately sweep tool outputs (all, or the last N).                |
| `/dcp-manual on\|off`   | Toggle manual mode for automatic strategies.                        |
| `/dcp-decompress [n]`   | Decompress a previously compressed block (no arg = list them).      |
| `/dcp-recompress [n]`   | Re-apply a previously decompressed block.                           |
| `/dcp-setup`            | Print the install / provider-setup walkthrough.                     |

### Model-driven tools

The plugin exposes an MCP server (`dcp`) with two kinds of tools:

- **`compress`** — when context exceeds the configured threshold, the
  model itself writes a summary and calls `compress`; on subsequent
  requests the proxy replaces the compressed span with that summary.
- **Stats / state tools** (`dcp_stats` and friends) — the model can
  query savings, per-strategy hits, and proxy state at any time.

### Reasoning tier

Reasoning parameters (`thinking`, `effort`, …) are forwarded as-is on
the request body and applied by your upstream. The highest tier works
exactly as it would with a direct connection to the upstream.

### HTTP proxy exemption check

If ZCode has an HTTP proxy configured globally, make sure it exempts
`127.0.0.1` loopback traffic. Otherwise the model traffic gets routed
through the external proxy and the local daemon becomes unreachable.
(If you have no system HTTP proxy, this does not apply.)

---

## Statistics — three counters

The proxy preserves three independent signals:

1. **Real usage / cache hit rate.** Taken from the upstream response
   `usage` block, which the proxy forwards byte-for-byte. **Updates
   normally and reflects the real post-pruning spend.**
2. **Context capacity (main number + per-category breakdown — MCP
   tools / system tools / messages / skills / system prompt).** ZCode
   estimates these locally from the assembled request it was about to
   send. **The number still updates, but it represents the
   *pre-pruning* assembled size — what you actually send upstream is
   smaller.**
3. **Remaining quota (5-hour / weekly / tool-call quotas).** Accounted
   on the provider's billing side; does not pass through the proxy at
   all and is therefore unaffected.

To see the **real sent vs saved** breakdown including per-strategy hits,
run `/dcp-stats` at any time.

---

## Known limitations

Listed honestly, with the reason for each:

1. **`tee` is blind to gzip-compressed SSE.** If your upstream responds
   with `Content-Encoding: gzip` (rare; most providers send uncompressed
   SSE), the tee cannot parse it and `usage` / cache-hit stats stop
   updating. Forwarding itself still works.
2. **Recent-`usage` memory resets on proxy restart.** Nudge thresholds
   that depend on the most recent upstream `usage` briefly lose that
   signal until the next request lands (the daemon holds this in
   memory).
3. **Manual commands can target the wrong window when two sessions are
   open concurrently.** `/dcp-sweep`, `/dcp-manual`, `/dcp-decompress`
   and `/dcp-recompress` may operate on the other window's session id.
   *Automatic* pruning (dedup / purge / nudges) is unaffected — it is
   derived from request history.
4. **`sentTokens` estimate excludes tool definitions.** ZCode's local
   context counter does not count the bytes of the tool definitions
   themselves. For "tokens actually billed" always trust upstream
   `usage`.
5. **`EADDRINUSE` if something else holds the port.** Change
   `proxy.port` in `dcp.jsonc` (and re-add the provider in step 5 with
   the new URL).
6. **Prompt-cache hit rate dips after pruning.** Because pruning
   changes the message prefix, prompt-cache reuse drops temporarily.
   Empirically (DCP upstream tests): ~85% with pruning vs ~90% direct.
   For long sessions the total token saving is still positive.

---

## Troubleshooting

| Symptom                                  | Action                                                                                                                |
|------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `/dcp-stats` returns `daemon unreachable` | Restart ZCode, or run `node <plugin root>/hooks/session-start.mjs` from a shell.                                       |
| `EADDRINUSE` on proxy startup            | Another process holds `8367`. Change `proxy.port` in `dcp.jsonc` and update the provider URL in step 5.                |
| Provider added but every call fails      | `upstream.baseUrl` / `upstream.apiKey` empty in `dcp.jsonc` — proxy returns 502 until you fill them in.                |
| Stats stop updating                      | Likely upstream is gzip-compressing SSE (see limitation 1) — switching to an uncompressed provider or patch tee.       |
| Local proxy not reachable from ZCode     | Check that ZCode's HTTP proxy (if any) exempts `127.0.0.1`.                                                            |
| Need verbose logs                        | `~/.zcode/cli/plugins/data/<zcode-dcp>/logs/` contains `dcp-<date>.log` (proxy + message-level) and `_daemon-launcher.log`. Set `debug: true` in `dcp.jsonc` for the trace. |

---

## Development

Zero dependencies — run the test suite with `node --test test/*.test.mjs`
(Node 20+). Note: the integration tests in `test/mcp.test.mjs` use Windows
process helpers (`cmd.exe` / `taskkill`) for daemon cleanup, so the full
suite currently requires Windows (CI runs on `windows-latest`). The plugin
runtime code itself is pure cross-platform Node.

---

## License

`AGPL-3.0-or-later`. Derived from `@tarquinen/opencode-dcp` v3.1.15.
Per-module source attribution and the full capability-mapping table
(port: 16 / downgraded: 9 / partial: 1 / infeasible: 3 / not-applicable: 3)
live at [`docs/CAPABILITY-MAPPING.md`](./docs/CAPABILITY-MAPPING.md).

See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) for details.