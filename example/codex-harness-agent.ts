// Minimal example: create one Codex session, run a prompt, and tear it down.
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createCodex } from '@ai-sdk/harness-codex';
import { createCodexOpenSandbox } from './create-codex-opensandbox';

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
