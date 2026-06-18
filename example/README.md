# OpenSandbox Codex HarnessAgent Example

This example validates `@natheihei/sandbox-opensandbox` with the existing `@ai-sdk/harness-codex` adapter.

## Prerequisites

- Docker is installed and running.
- Codex config exists under `${HOME}/.codex`.
- A local OpenSandbox server is installed and running. One Docker-backed setup is:

```bash
uvx opensandbox-server init-config ~/.sandbox.toml --example docker
uvx opensandbox-server
```

- The OpenSandbox server config allows mounting your local Codex auth directory at `${HOME}/.codex`. OpenSandbox does not expand `${HOME}` inside `sandbox.toml`, so use an absolute path:

```toml
[storage]
# Add the host .codex path so the example can mount Codex auth into the sandbox.
allowed_host_paths = ['/Users/<your user name>/.codex']
```

Only `auth.json` and `config.toml` are copied from the mounted Codex auth source when they exist and are missing inside the sandbox.

## Run The Basic Example

Build the provider package, then start the basic example from the package root:

```bash
pnpm build
pnpm --dir example start
```

The example has its own nested `pnpm-workspace.yaml` so `pnpm --dir example start` installs only this example package when `node_modules/.bin/tsx` is missing. It uses published AI SDK Harness packages and the local provider package from `file:..`.

The example mounts `${HOME}/.codex` read-only to `/mnt/codex-auth-source` and seeds sandbox auth with a generic setup script.

## Run The Concurrent Resume Example

The advanced example starts three sessions concurrently, runs one prompt in each session, stops each session to get resumable lifecycle state, resumes the same sessions, verifies per-session files persisted, then destroys the resumed sandboxes:

```bash
pnpm build
pnpm --dir example start:advanced
```

Use `EXAMPLE_RUN_ID` when you want stable, human-readable session IDs across repeated local runs:

```bash
EXAMPLE_RUN_ID=demo-1 pnpm --dir example start:advanced
```

The example demonstrates the two pieces needed for resume:

- `sessionId`: a stable ID passed to `agent.createSession({ sessionId })`.
- `resumeFrom`: the lifecycle payload returned by `session.stop()` and passed back to `agent.createSession({ sessionId, resumeFrom })`.

Calling `stop()` pauses the OpenSandbox-backed sandbox so it can be resumed. Calling `destroy()` removes the sandbox and discards resumability.

## Type-Check The Examples

Type-check the local example scripts without starting OpenSandbox:

```bash
pnpm --dir example check
```

## Fixed Example Settings

The example intentionally hardcodes these settings:

- OpenSandbox control-plane URL: `http://127.0.0.1:8080`
- OpenSandbox image: `opensandbox/code-interpreter:v1.1.0`
- Bridge port: `3000`
- Codex model: `gpt-5.5`
