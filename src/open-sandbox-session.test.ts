import { describe, expect, it } from 'vitest';
import { OpenSandboxNetworkSandboxSession } from './open-sandbox-session';

type CommandRunResult = {
  id?: string;
  exitCode?: number | null;
  logs?: {
    stdout?: unknown;
    stderr?: unknown;
  };
  result?: unknown[];
};

function makeSandbox() {
  const files = new Map<string, string>();
  const createdDirectories: string[] = [];
  const lifecycleEvents: string[] = [];
  const statusCalls: string[] = [];
  const interruptCalls: string[] = [];
  const logCalls: Array<{ commandId: string; cursor: number | undefined }> = [];
  let nextRunResult: CommandRunResult | undefined;
  const commandStatuses: Array<{
    running?: boolean;
    exitCode?: number | null;
  }> = [{ running: false, exitCode: 3 }];
  const backgroundLogs: Array<{ content: string; cursor?: number }> = [
    { content: 'background output', cursor: 1 },
    { content: '' },
  ];
  const runCalls: Array<{
    command: string;
    options: unknown;
    handlers: unknown;
    abortSignal: AbortSignal | undefined;
  }> = [];

  return {
    id: 'sbx-1',
    get nextRunResult() {
      return nextRunResult;
    },
    set nextRunResult(value: CommandRunResult | undefined) {
      nextRunResult = value;
    },
    files: {
      readFile: async (path: string) => files.get(path) ?? '',
      readBytes: async (path: string) =>
        new TextEncoder().encode(files.get(path) ?? ''),
      writeFiles: async (
        entries: Array<{ path: string; data: string | Uint8Array }>,
      ) => {
        for (const entry of entries) {
          files.set(
            entry.path,
            typeof entry.data === 'string'
              ? entry.data
              : new TextDecoder().decode(entry.data),
          );
        }
      },
      createDirectories: async (entries: Array<{ path: string }>) => {
        createdDirectories.push(...entries.map(entry => entry.path));
      },
    },
    commands: {
      run: async (
        command: string,
        options: unknown,
        handlers: unknown,
        abortSignal: AbortSignal | undefined,
      ) => {
        runCalls.push({ command, options, handlers, abortSignal });
        return (
          nextRunResult ?? {
            id: 'cmd-1',
            exitCode: 7,
            logs: {
              stdout: [
                { text: `stdout:${command}`, timestamp: Date.now() },
                { text: '\nnext', timestamp: Date.now() },
              ],
              stderr: [{ text: 'stderr', timestamp: Date.now() }],
            },
            result: [],
          }
        );
      },
      getCommandStatus: async (commandId: string) => {
        statusCalls.push(commandId);
        return commandStatuses.shift() ?? { running: false, exitCode: 0 };
      },
      getBackgroundCommandLogs: async (
        commandId: string,
        cursor: number | undefined,
      ) => {
        logCalls.push({ commandId, cursor });
        return backgroundLogs.shift() ?? { content: '' };
      },
      interrupt: async (commandId: string) => {
        interruptCalls.push(commandId);
      },
    },
    getEndpointUrl: async (port: number) => `http://localhost:${port}`,
    pause: async () => {
      lifecycleEvents.push('pause');
    },
    kill: async () => {
      lifecycleEvents.push('kill');
    },
    close: async () => {
      lifecycleEvents.push('close');
    },
    backgroundLogs,
    commandStatuses,
    createdDirectories,
    interruptCalls,
    lifecycleEvents,
    logCalls,
    runCalls,
    statusCalls,
  };
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let content = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    content += decoder.decode(value, { stream: true });
  }

  content += decoder.decode();

  return content;
}

describe('OpenSandboxNetworkSandboxSession', () => {
  it('writes and reads text files', async () => {
    const sandbox = makeSandbox();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await session.writeTextFile({ path: '/workspace/a.txt', content: 'hello' });

    await expect(
      session.readTextFile({ path: '/workspace/a.txt' }),
    ).resolves.toBe('hello');
    expect(sandbox.createdDirectories).toEqual(['/workspace']);
  });

  it('creates parent directories with OpenSandbox octal-style mode values', async () => {
    const sandbox = makeSandbox();
    const directoryEntries: Array<{ path: string; mode?: number }> = [];
    sandbox.files.createDirectories = async entries => {
      directoryEntries.push(...entries);
    };
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await session.writeTextFile({ path: '/workspace/a.txt', content: 'hello' });

    expect(directoryEntries).toEqual([{ path: '/workspace', mode: 755 }]);
  });

  it('returns null for missing files reported as 404 download failures', async () => {
    const sandbox = makeSandbox();
    sandbox.files.readBytes = async () => {
      const error = new Error('Download failed') as Error & {
        statusCode?: number;
      };
      error.statusCode = 404;
      throw error;
    };
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await expect(
      session.readTextFile({ path: '/workspace/missing.txt' }),
    ).resolves.toBeNull();
  });

  it('throws non-404 download failures', async () => {
    const sandbox = makeSandbox();
    sandbox.files.readBytes = async () => {
      const error = new Error('Download failed') as Error & {
        statusCode?: number;
      };
      error.statusCode = 500;
      throw error;
    };
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await expect(
      session.readTextFile({ path: '/workspace/error.txt' }),
    ).rejects.toThrow('Download failed');
  });

  it('normalizes run output', async () => {
    const sandbox = makeSandbox();
    const abortController = new AbortController();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await expect(
      session.run({
        command: 'pwd',
        workingDirectory: '/workspace',
        env: { FOO: 'bar' },
        abortSignal: abortController.signal,
      }),
    ).resolves.toEqual({
      exitCode: 7,
      stdout: 'stdout:pwd\nnext',
      stderr: 'stderr',
    });
    expect(sandbox.runCalls).toEqual([
      {
        command: 'pwd',
        options: { workingDirectory: '/workspace', envs: { FOO: 'bar' } },
        handlers: undefined,
        abortSignal: abortController.signal,
      },
    ]);
  });

  it('starts spawned commands in the background with the requested options', async () => {
    const sandbox = makeSandbox();
    const abortController = new AbortController();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await session.spawn({
      command: 'npm run dev',
      workingDirectory: '/workspace/app',
      env: { NODE_ENV: 'test' },
      abortSignal: abortController.signal,
    });

    expect(sandbox.runCalls).toEqual([
      {
        command: 'npm run dev',
        options: {
          background: true,
          workingDirectory: '/workspace/app',
          envs: { NODE_ENV: 'test' },
        },
        handlers: undefined,
        abortSignal: abortController.signal,
      },
    ]);
  });

  it('waits for spawned commands to finish and returns their exit code', async () => {
    const sandbox = makeSandbox();
    sandbox.commandStatuses.length = 0;
    sandbox.commandStatuses.push(
      { running: true },
      { running: false, exitCode: 42 },
    );
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const process = await session.spawn({ command: 'npm test' });

    await expect(process.wait()).resolves.toEqual({ exitCode: 42 });
    expect(sandbox.statusCalls).toEqual(['cmd-1', 'cmd-1']);
  });

  it('kills spawned commands by interrupting the background command id', async () => {
    const sandbox = makeSandbox();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const process = await session.spawn({ command: 'sleep 1000' });

    await process.kill();
    await process.kill();

    expect(sandbox.interruptCalls).toEqual(['cmd-1']);
  });

  it('streams background command logs from stdout', async () => {
    const sandbox = makeSandbox();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const process = await session.spawn({ command: 'printf logs' });

    await expect(readText(process.stdout)).resolves.toBe('background output');
    expect(sandbox.logCalls).toEqual([
      { commandId: 'cmd-1', cursor: undefined },
      { commandId: 'cmd-1', cursor: 1 },
      { commandId: 'cmd-1', cursor: 1 },
    ]);
  });

  it('drains trailing logs after terminal status is observed', async () => {
    const sandbox = makeSandbox();
    sandbox.backgroundLogs.length = 0;
    sandbox.backgroundLogs.push(
      { content: '' },
      { content: 'final output', cursor: 1 },
      { content: '' },
    );
    sandbox.commandStatuses.length = 0;
    sandbox.commandStatuses.push(
      { running: false, exitCode: 0 },
      { running: false, exitCode: 0 },
    );
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const process = await session.spawn({ command: 'printf final' });

    await expect(readText(process.stdout)).resolves.toBe('final output');
  });

  it('interrupts spawned commands when the abort signal fires', async () => {
    const sandbox = makeSandbox();
    sandbox.commandStatuses.length = 0;
    sandbox.commandStatuses.push({ running: true });
    const abortController = new AbortController();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const process = await session.spawn({
      command: 'sleep 1000',
      abortSignal: abortController.signal,
    });
    const waitPromise = process.wait();

    abortController.abort(new Error('aborted'));

    await expect(waitPromise).rejects.toThrow('aborted');
    expect(sandbox.interruptCalls).toEqual(['cmd-1']);
  });

  it('throws a clear error when spawned background commands do not return an id', async () => {
    const sandbox = makeSandbox();
    sandbox.nextRunResult = { exitCode: 0 };
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await expect(session.spawn({ command: 'npm run dev' })).rejects.toThrow(
      'OpenSandbox background command did not return an execution id.',
    );
  });

  it('converts HTTP endpoint URL to websocket URL', async () => {
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox: makeSandbox(),
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await expect(
      session.getPortUrl({ port: 3000, protocol: 'ws' }),
    ).resolves.toBe('ws://localhost:3000/');
  });

  it('returns a restricted view without lifecycle methods', () => {
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox: makeSandbox(),
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const restricted = session.restricted() as Record<string, unknown>;

    expect(restricted.run).toBeTypeOf('function');
    expect(restricted.getPortUrl).toBeUndefined();
    expect(restricted.stop).toBeUndefined();
    expect(restricted.destroy).toBeUndefined();
    expect(restricted.ports).toBeUndefined();
  });

  it('closes when owned lifecycle stop pause fails', async () => {
    const sandbox = makeSandbox();
    sandbox.pause = async () => {
      sandbox.lifecycleEvents.push('pause');
      throw new Error('pause failed');
    };
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await expect(session.stop()).rejects.toThrow('pause failed');

    expect(sandbox.lifecycleEvents).toEqual(['pause', 'close']);
  });

  it('only stops owned sandboxes once', async () => {
    const sandbox = makeSandbox();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await session.stop();
    await session.stop();

    expect(sandbox.lifecycleEvents).toEqual(['pause', 'close']);
  });

  it('does not destroy an already stopped sandbox client', async () => {
    const sandbox = makeSandbox();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await session.stop();
    await session.destroy();

    expect(sandbox.lifecycleEvents).toEqual(['pause', 'close']);
  });

  it('does not destroy while stop is in flight', async () => {
    const sandbox = makeSandbox();
    let finishPause: (() => void) | undefined;
    const pauseStarted = new Promise<void>(resolve => {
      sandbox.pause = async () => {
        sandbox.lifecycleEvents.push('pause:start');
        resolve();
        await new Promise<void>(finish => {
          finishPause = finish;
        });
        sandbox.lifecycleEvents.push('pause:end');
      };
    });
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const stopPromise = session.stop();
    await pauseStarted;
    await session.destroy();
    finishPause?.();
    await stopPromise;

    expect(sandbox.lifecycleEvents).toEqual([
      'pause:start',
      'pause:end',
      'close',
    ]);
  });

  it('does not stop while destroy is in flight', async () => {
    const sandbox = makeSandbox();
    let finishKill: (() => void) | undefined;
    const killStarted = new Promise<void>(resolve => {
      sandbox.kill = async () => {
        sandbox.lifecycleEvents.push('kill:start');
        resolve();
        await new Promise<void>(finish => {
          finishKill = finish;
        });
        sandbox.lifecycleEvents.push('kill:end');
      };
    });
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    const destroyPromise = session.destroy();
    await killStarted;
    await session.stop();
    finishKill?.();
    await destroyPromise;

    expect(sandbox.lifecycleEvents).toEqual([
      'kill:start',
      'kill:end',
      'close',
    ]);
  });

  it('does not close caller-owned sandboxes on stop or destroy', async () => {
    const sandbox = makeSandbox();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: false,
    });

    await session.stop();
    await session.destroy();

    expect(sandbox.lifecycleEvents).toEqual([]);
  });

  it('closes when owned lifecycle destroy kill fails', async () => {
    const sandbox = makeSandbox();
    sandbox.kill = async () => {
      sandbox.lifecycleEvents.push('kill');
      throw new Error('kill failed');
    };
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await expect(session.destroy()).rejects.toThrow('kill failed');

    expect(sandbox.lifecycleEvents).toEqual(['kill', 'close']);
  });

  it('only destroys owned sandboxes once', async () => {
    const sandbox = makeSandbox();
    const session = new OpenSandboxNetworkSandboxSession({
      sandbox,
      ports: [3000],
      defaultWorkingDirectory: '/workspace',
      ownsLifecycle: true,
    });

    await session.destroy();
    await session.destroy();

    expect(sandbox.lifecycleEvents).toEqual(['kill', 'close']);
  });
});
