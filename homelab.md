# Running fortytwo on a homelab

A deployment guide for running fortytwo as an always-on service in containers
(rootless Podman on Ubuntu, but Docker works the same way): a Telegram channel,
the scheduler, durable memory with local embeddings, and the searchable
conversation transcript. It is written for readers who know Docker or Podman
and Claude Code but not fortytwo.

The compose files and configuration examples referenced here live in
[`examples/homelab/`](https://github.com/justfortytwo/docs/tree/main/examples/homelab).
They come from a real setup, with every secret and personal value replaced by a
placeholder.

## Why this exists

fortytwo wraps Claude Code; it does not replace it:

```
Claude Code = reasoning + tools + MCP + skills + browser + integrations
fortytwo    = identity + memory + transcript + time + channels
```

The Telegram bridge launches `claude -p` in stream-json mode, and the scheduler
launches headless turns through `@justfortytwo/runner`. Reasoning and tools stay
Claude Code's. This guide only covers what fortytwo needs from the machine around
it: processes that stay up, a shared workspace, and an embedding server.

## The shape: two containers, one image

Both containers use **the same image** (`localhost/claude-code:<version>`, see the
`Dockerfile`) and the same volumes, but do different jobs:

| Container     | Command                              | Role |
|---------------|--------------------------------------|------|
| `claude-code` | `ttyd` → `tmux` → `claude -c`        | Interactive session (web terminal or `podman exec`) to work, configure and update |
| `fortytwo`    | `npx fortytwo start`                 | Always-on runtime: Telegram bridge + scheduler (the memory MCP server is launched by Claude on demand) |

**Shared:** the Claude login and config (`claude_config`), `/workspace` (`.env`,
`.mcp.json`, `db/`, `context/`, `node_modules/`) and the toolchain
(`claude_tools`). Memory and transcript live in the same SQLite file.

**Not shared:** a context window. A session in the web terminal and a session
started from Telegram are **separate Claude sessions**; what ties them together is
the filesystem, the memory and the transcript, not the live conversation.

`fortytwo start` runs in the foreground on purpose, so the container runtime owns
restarts and logs (see [installer](./packages/installer.md#running-as-a-service)).

## Persistence

| Volume / mount | Contents |
|---|---|
| `claude_config` → `~/.claude` | Claude login (`.credentials.json`), settings, history. **Sensitive** |
| `./workspace` → `/workspace` | `.env`, `.mcp.json`, `CLAUDE.md`, `context/`, `db/fortytwo.db`, `state/`, `.fortytwo/`, `node_modules/` (the `@justfortytwo/*` packages), project `.claude/` |
| `claude_tools` → `~/.tools` | `npm -g`, `uv tool`, uv-managed Python, npm/uv caches |
| `ollama_data` | Embedding models |

`userns_mode: keep-id` (rootless Podman) maps your host UID to the `claude` user
(UID 1000) in the container; `:U` on the named volumes fixes their ownership.
On rootful Docker, drop it and align UIDs yourself.

`/workspace/.env` is loaded two ways: the `claude-code` command does
`set -a; source /workspace/.env; set +a` before starting ttyd, and
`fortytwo start` loads it itself. Start from `.env.example`; never commit `.env`.

## Install

Copy [`examples/homelab/`](https://github.com/justfortytwo/docs/tree/main/examples/homelab)
to the host, adapt the lines marked `ADAPT` (timezone, limits, network name), and
run from that directory:

```bash
podman network create shared
mkdir workspace
cp .env.example workspace/.env      # then fill it in
podman-compose -f compose.yaml build
podman-compose -f compose.ollama.yaml up -d          # embeddings, see below
podman-compose -f compose.yaml up -d claude-code
```

Then, from the interactive container:

```bash
podman exec -it claude-code bash
claude                         # log in once; the login is shared via claude_config
cd /workspace
npx create-fortytwo init       # same as `fortytwo init`; interactive
npx fortytwo doctor            # should report "healthy"
exit
```

Start the runtime and pair Telegram:

```bash
podman-compose -f compose.yaml up -d fortytwo
podman exec -it claude-code bash -lc 'cd /workspace && npx fortytwo pair'
# prints a code; send `/login <code>` to your bot from the chat you want to link
```

### What `init` does

1. Installs the engine packages that are missing (`gate`, `memory`, `persona`,
   `telegram`, `scheduler`, `transcript`) and pins the installer in
   `package.json` (exact version). `--no-install` leaves that to you.
2. Installs a `fortytwo` launcher in a directory already on `PATH`
   (`~/.local/bin`, `~/bin` or npm's global bin; `FORTYTWO_BIN_DIR` overrides).
   If none is writable, use `npx fortytwo …`, which does the same thing; the
   containers here always use `npx fortytwo`.
3. Captures your identity into `.fortytwo/identity.json`. Required answers:
   `agent_name`, `owner_name`, `owner_role`, `owner_positioning`,
   `owner_identity_summary`, `owner_values`, `owner_expertise`,
   `owner_boundaries`, `owner_voice_tone`. For non-interactive runs use `--yes`
   with `--answers file.json`, or `FORTYTWO_<KEY>` variables.
4. Writes secrets and `ALLOWED_CHAT_IDS` to `.env` (passed with
   `--telegram-bot-token` / `--allowed-chat-ids` or env, never prompted) and wires
   the `fortytwo-memory` entry in `.mcp.json`, including the transcript tools.
5. Renders the persona (`CLAUDE.md` + `context/*`) from your answers. Rendering
   is idempotent and never overwrites what you edited by hand.
6. Checks the embedding model on the Ollama server (pulling it if missing),
   migrates the database and records the installed version set in
   `.fortytwo/state.json`, which `rollback` uses.

After `init`, review `.env`, `.mcp.json` and `context/`. If `init` did not write
`.mcp.json` in your case, start from
[`.mcp.json.example`](https://github.com/justfortytwo/docs/blob/main/examples/homelab/.mcp.json.example).

## Embeddings (Ollama)

`@justfortytwo/memory` and `@justfortytwo/transcript` search by meaning as well as
by keyword, so they need an embedding model. fortytwo uses a **local** one, so
personal data never leaves the machine. Ollama only serves embeddings here; it
generates no answers.

- Model: `qwen3-embedding:0.6b` (about 640 MB on disk, 1024-dimension vectors).
- One `ollama` container on the `shared` network, reachable as
  `http://ollama:11434`, CPU only. `OLLAMA_KEEP_ALIVE=24h` keeps the model in RAM
  (about 2.4 GB observed) for a day after last use; the 4 GB limit in the compose
  file is sized for that.
- `ollama-entrypoint.sh` starts the server, waits for the API and runs
  `ollama pull` (a no-op when the model is already on the volume).
- `init` asks for the Ollama base URL: Enter for `http://localhost:11434`, or
  `http://ollama:11434` for a neighbouring container as here. The same URL and
  model appear in `.env` and in the `fortytwo-memory` entry of `.mcp.json`
  (`OLLAMA_BASE_URL`, `EMBED_MODEL`, `DB_PATH`).

**Caveats**

- **Do not change the embedding model after storing data.** The vector tables
  have a fixed dimension, and vectors from different models give plausible but
  wrong neighbours. Memory documents a `reembed` for a single id only.
- Without `EMBED_MODEL`, memory falls back to a deterministic `FakeEmbedder`:
  fine for tests, useless for real recall.
- An OpenAI-compatible remote provider is supported (`EMBED_PROVIDER=openai`);
  the setup behind this guide does not use it and it is untested here.
- If Ollama is unreachable, `init` and `doctor` fail the embedder check. Start it
  before fortytwo.

## Verify the transcript

Send your bot a message, then:

```bash
podman exec claude-code sqlite3 /workspace/db/fortytwo.db \
  "select id, ts, channel, direction, actor, substr(content,1,50) \
   from transcript order by id desc limit 5;"
```

Your message should appear as `telegram | inbound | owner` and the reply as
`outbound | assistant`. In a Claude session, the agent searches it with
`transcript_search` and reads neighbours with `transcript_context`.

## Updating

Always stop the runtime first: `update` refuses to run against live services.

```bash
podman stop fortytwo

# consistent backup (do not copy the .db file while Claude has it open)
podman exec claude-code bash -lc 'mkdir -p /workspace/db-backup &&
  sqlite3 /workspace/db/fortytwo.db ".backup /workspace/db-backup/fortytwo.db"'

podman exec -it claude-code bash -lc 'cd /workspace && npx fortytwo update --dry-run'
podman exec -it claude-code bash -lc 'cd /workspace && npx fortytwo update'
podman exec -it claude-code bash -lc 'cd /workspace && npx fortytwo doctor'

podman start fortytwo
podman restart claude-code     # reload .mcp.json so the session sees new tools
```

If something goes wrong, `npx fortytwo rollback` restores the previous version
set (single step, manual). It does **not** undo a data migration; restore the
backup for that.

### Updating from a pre-1.0 installation

A project's pinned CLI only knows the version set it shipped with, so
`npx fortytwo update` cannot move an installation from the 1.0 prereleases (or
older) to the current release. Name the installer once; after that the project
pins the new CLI and the plain command works again:

```bash
podman exec -it claude-code bash -lc \
  'cd /workspace && npx @justfortytwo/installer@latest update --dry-run'
podman exec -it claude-code bash -lc \
  'cd /workspace && npx @justfortytwo/installer@latest update'
```

On an installation that predates the transcript, `update`:

1. installs `@justfortytwo/transcript` and re-wires **only** the
   `fortytwo-memory` entry of `.mcp.json` (other servers, such as WhatsApp,
   are left as they are);
2. moves the chat rows (Telegram messages and scheduler notifications) out of
   memory into the transcript, verifying each copy before deleting the
   original. It prints `moved N chat row(s) from memory to the transcript`;
3. reports a failed move as `chat migration skipped: …` without aborting.
   Memory stays intact and the next `init` or `update` retries it.

Updating Claude Code itself is separate: change `CLAUDE_CODE_VERSION` in the
`Dockerfile` and the image tag in the compose file, then `build` and
`up -d --force-recreate` (auto-update is disabled in the container).

## Optional: browser and WhatsApp

Both are **Claude capabilities, not fortytwo features**: fortytwo knows nothing
about a browser or WhatsApp. Add them after the core setup works.

**Browser.** Chromium runs in its own container (`compose.chromium.yaml`,
LinuxServer image with a web desktop) and keeps a persistent profile. Its CDP
endpoint is proxied by nginx (`cdp.conf`) from 9222 to 9223 so other containers
on `shared` can reach it. Claude drives it with the `@playwright/cli` tool and
its skill, attaching with `playwright-cli attach --cdp=http://chromium:9223`
(`playwright-cli.config.json.example` sets the endpoint). Behavioural rules
(never close the browser, preserve tabs, leave logins and 2FA to the human) go
in `/workspace/.claude/rules/browser.md`; see `browser-rule.md.example`.

**WhatsApp.** WAHA (`compose.waha.yaml`) runs as a separate service with its own
Redis on an internal network. Claude reaches it over MCP (HTTP, `/mcp`),
authenticated with an `X-Api-Key` header read from the environment. Two WhatsApp
sessions means two `.mcp.json` entries with the same URL and different app
keys. Secrets go in `waha.env` (from `.env.waha.example`); pair the WhatsApp
session from the WAHA dashboard with a QR code.

MCP guideline: use MCP for real external capabilities (memory, WhatsApp, mail).
Do not wrap in fortytwo what Claude Code already does (shell, files, git, web),
and do not create a subagent per tool: a subagent is a role, not an API wrapper.

## Security

Never copy these from a working setup into a repository or a shared kit: `.env`,
the Telegram token, WAHA keys, `~/.claude` (login/OAuth), the real `.mcp.json`,
`chromium-config/` (cookies, sessions), `waha_sessions`, `db/fortytwo.db` and
`state/` (personal memory, transcript and Telegram bindings), `context/`,
`.fortytwo/identity.json`, `.claude/settings.local.json`.

- **ttyd and the Chromium web desktop have no authentication.** The CDP endpoint
  on 9223 gives full browser control to anyone on `shared`. Do not publish them
  or route them to the internet; keep them behind a reverse proxy with a
  LAN-only filter, or on loopback.
- The transcript holds your full chat history **forever**. Treat `db/` and its
  backups as sensitive, and encrypt or restrict them accordingly.

## Suggested order

1. `claude-code` (login, `/workspace`)
2. Ollama
3. fortytwo (`init`, `doctor`, `start`)
4. Telegram (`pair`)
5. Restart test: restart `fortytwo`, check `doctor`, check that memory and
   transcript persist
6. Only then: browser, WhatsApp, mail, calendar, GitHub

## Scope

**Covered:** the always-on topology, persistence, embeddings, first install,
updating (including the move from prereleases to 1.0), and the optional browser
and WhatsApp services as used in the originating setup.

**Not verified:**

- Rootful Docker, other distributions and compose implementations: the example
  was run on rootless Podman, Ubuntu 24.04. The `userns_mode: keep-id` line is
  Podman-specific.
- A clean `init` with real answers was not re-run to produce this guide; the
  steps follow the installer behaviour and README.
- Pinned versions in the example (Claude Code, Node, ttyd, uv) are those in use
  at the time of writing; bump them deliberately.
- The `qwen3-embedding:0.6b` sizing figures (disk, RAM) are observed values on
  one CPU-only host, not guarantees.
