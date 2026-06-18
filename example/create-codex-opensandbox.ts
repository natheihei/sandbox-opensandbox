// Shared OpenSandbox configuration for the Codex examples.
import { createOpenSandbox } from '@natheihei/sandbox-opensandbox';

const codexConfigOnHost = `${process.env.HOME}/.codex`;
const openSandboxBaseUrl = 'http://127.0.0.1:8080';
const openSandboxImage = 'opensandbox/code-interpreter:v1.1.0';
const openSandboxBridgePort = 3000;

/** Creates the OpenSandbox provider used by the Codex examples. */
export function createCodexOpenSandbox() {
  return createOpenSandbox({
    connectionConfig: { domain: openSandboxBaseUrl },
    image: openSandboxImage,
    ports: [openSandboxBridgePort],
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
