# @natheihei/sandbox-opensandbox

OpenSandbox-backed sandbox provider for AI SDK Harness agents.

Vercel has released support for [`HarnessAgent`](https://ai-sdk.dev/v7/docs/ai-sdk-harnesses/overview), which lets us run established agent harnesses through the same AI SDK surface. This library plugs that interface into OpenSandbox so we can start a sandbox on our own computer and run our own harness with our own subscription credentials.

## Install

```bash
pnpm add @natheihei/sandbox-opensandbox
```

## Local Codex with local OpenSandbox (with our subscription)

We already have a capable computer and Codex authenticated with our subscription. Use them together: run `@ai-sdk/harness-codex` inside OpenSandbox on our own Docker host, reuse the credentials in `${HOME}/.codex`, and skip paying for a hosted sandbox service or wiring up another API key.

### Prerequisites

- Docker is installed and running.
- Codex config exists under `${HOME}/.codex` with authentication information.
- OpenSandbox server can mount `${HOME}/.codex` from the host.

### Configure and start OpenSandbox

Create an OpenSandbox Docker runtime config:

```bash
uvx opensandbox-server init-config ~/.sandbox.toml --example docker
```

Update the `[storage]` section in `~/.sandbox.toml` so OpenSandbox can mount our local Codex config. OpenSandbox TOML does not expand `${HOME}`, so use an absolute path:

```toml
[storage]
# Add the host .codex path so Codex auth can be copied into the sandbox.
allowed_host_paths = ['/Users/<your user name>/.codex']
```

Start the server:

```bash
uvx opensandbox-server --config ~/.sandbox.toml
```

### Create a Codex OpenSandbox provider

```ts
import { createOpenSandbox } from '@natheihei/sandbox-opensandbox';

const codexConfigOnHost = `${process.env.HOME}/.codex`;

function createCodexOpenSandbox() {
  return createOpenSandbox({
    connectionConfig: { domain: 'http://127.0.0.1:8080' },
    image: 'opensandbox/code-interpreter:v1.1.0',
    ports: [3000],
    timeoutSeconds: null,
    mounts: [
      {
        name: 'codex-auth-source',
        hostPath: codexConfigOnHost,
        mountPath: '/mnt/codex-auth-source',
        readOnly: true,
      },
    ],
    setupScripts: [
      {
        // @ai-sdk/harness-codex expects pnpm in the sandbox, but the image may not include it.
        command: `
set -euo pipefail
if ! pnpm --version >/dev/null 2>&1; then
  npm install -g pnpm@10.33.0
fi
`,
      },
      {
        // Copy only the files Codex needs, keeping the mounted host config read-only.
        command: `
set -euo pipefail
home="$(printf "%s" "$HOME")"
source="/mnt/codex-auth-source"
target="$home/.codex"
mkdir -p "$target"
for file in auth.json config.toml; do
  if [ -f "$source/$file" ] && [ ! -f "$target/$file" ]; then
    cp "$source/$file" "$target/$file"
    chmod 600 "$target/$file"
  fi
done
`,
      },
    ],
  });
}
```

### Use the agent

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createCodex } from '@ai-sdk/harness-codex';

const agent = new HarnessAgent({
  harness: createCodex({ model: 'gpt-5.5' }),
  sandbox: createCodexOpenSandbox(),
  permissionMode: 'allow-all',
});

const session = await agent.createSession();

try {
  const result = await agent.generate({
    session,
    prompt: 'Say hello, run pwd, and summarize the working directory path.',
  });

  console.log(result.text);
} finally {
  await session.destroy();
}
```

See `example/` for complete runnable examples, including concurrent named sessions and resume behavior.
