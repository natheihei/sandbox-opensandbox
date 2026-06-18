import { describe, expect, it } from 'vitest';
import { runSetupScripts } from './setup-scripts';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';

function mockSession({
  existingFiles = new Set<string>(),
  runResult = { exitCode: 0, stdout: '', stderr: '' },
}: {
  existingFiles?: Set<string>;
  runResult?: { exitCode: number; stdout: string; stderr: string };
} = {}) {
  const runs: string[] = [];
  const session: SandboxSession = {
    description: 'mock',
    readFile: async () => null,
    readBinaryFile: async () => null,
    readTextFile: async ({ path }) => (existingFiles.has(path) ? '' : null),
    writeFile: async () => {},
    writeBinaryFile: async () => {},
    writeTextFile: async () => {},
    spawn: async () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      wait: async () => ({ exitCode: 0 }),
      kill: async () => {},
    }),
    run: async ({ command }) => {
      runs.push(command);
      return runResult;
    },
  };
  return { session, runs };
}

describe('runSetupScripts', () => {
  it('runs all setup scripts on fresh create', async () => {
    const { session, runs } = mockSession();
    await runSetupScripts({
      session,
      phase: 'create',
      scripts: [{ command: 'echo setup' }],
    });
    expect(runs).toEqual(['echo setup']);
  });

  it('skips resume scripts by default', async () => {
    const { session, runs } = mockSession();
    await runSetupScripts({
      session,
      phase: 'resume',
      scripts: [{ command: 'echo setup' }],
    });
    expect(runs).toEqual([]);
  });

  it('skips resume scripts when runOnResume is false', async () => {
    const { session, runs } = mockSession();
    await runSetupScripts({
      session,
      phase: 'resume',
      scripts: [{ command: 'echo setup', runOnResume: false }],
    });
    expect(runs).toEqual([]);
  });

  it('runs resume scripts when runOnResume is true', async () => {
    const { session, runs } = mockSession();
    await runSetupScripts({
      session,
      phase: 'resume',
      scripts: [{ command: 'echo setup', runOnResume: true }],
    });
    expect(runs).toEqual(['echo setup']);
  });

  it('does not include command output in failure errors', async () => {
    const { session } = mockSession({
      runResult: {
        exitCode: 1,
        stdout: 'secret stdout',
        stderr: 'secret stderr',
      },
    });
    let error: unknown;
    try {
      await runSetupScripts({
        session,
        phase: 'create',
        scripts: [{ command: 'echo secret' }],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toBe('Setup script 1 failed with exit code 1.');
    expect(message).not.toContain('echo secret');
    expect(message).not.toContain('secret stdout');
    expect(message).not.toContain('secret stderr');
  });
});
