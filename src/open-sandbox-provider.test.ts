import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createOpenSandbox,
  OpenSandboxProvider,
} from './open-sandbox-provider';
import type { OpenSandboxSettings } from './types';

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function makeSandbox({
  id = 'sbx-1',
  pwd = '/workspace/project',
  home = '/home/sandbox',
  existingFiles = new Set<string>(),
}: {
  id?: string;
  pwd?: string;
  home?: string;
  existingFiles?: Set<string>;
} = {}) {
  const calls: string[] = [];
  const lifecycleEvents: string[] = [];

  const sandbox = {
    id,
    files: {
      readFile: async (path: string) => {
        calls.push(`readFile:${path}`);
        return '';
      },
      readBytes: async (path: string) => {
        calls.push(`readBytes:${path}`);

        if (!existingFiles.has(path)) {
          const error = new Error('not found') as Error & {
            statusCode?: number;
          };
          error.statusCode = 404;
          throw error;
        }

        return new Uint8Array();
      },
      writeFiles: async () => {},
      createDirectories: async () => {},
    },
    commands: {
      run: async (command: string) => {
        calls.push(`run:${command}`);

        if (command === 'pwd') {
          return {
            id: 'cmd-pwd',
            exitCode: 0,
            logs: { stdout: [{ text: pwd }], stderr: [] },
            result: [],
          };
        }

        if (command === 'printf "%s" "$HOME"') {
          return {
            id: 'cmd-home',
            exitCode: 0,
            logs: { stdout: [{ text: home }], stderr: [] },
            result: [],
          };
        }

        if (command === 'exit 1') {
          return {
            id: 'cmd-fail',
            exitCode: 1,
            logs: { stdout: [], stderr: [{ text: 'failed' }] },
            result: [],
          };
        }

        return {
          id: 'cmd',
          exitCode: 0,
          logs: { stdout: [], stderr: [] },
          result: [],
        };
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
    calls,
    lifecycleEvents,
  };

  return sandbox;
}

describe('OpenSandboxProvider', () => {
  it('creates Harness sandbox providers with OpenSandbox identifiers', () => {
    const provider = createOpenSandbox({});

    expect(provider).toBeInstanceOf(OpenSandboxProvider);
    expect(provider.specificationVersion).toBe('harness-sandbox-v1');
    expect(provider.providerId).toBe('opensandbox');
  });

  it('creates a sandbox with provider metadata and runs create setup before returning', async () => {
    const createdOptions: Array<Record<string, unknown>> = [];
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      {
        metadata: {
          app: 'demo',
          'ai-sdk-provider': 'user-value',
        },
        ports: [3000],
        setupScripts: [{ command: 'echo setup' }],
      },
      {
        create: async options => {
          createdOptions.push(options);
          return sandbox;
        },
      },
    );

    const session = await provider.createSession({ sessionId: 'session-1' });

    expect(session.id).toBe('sbx-1');
    expect(session.ports).toEqual([3000]);
    expect(session.defaultWorkingDirectory).toBe('/workspace/project');
    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0]?.metadata).toEqual({
      app: 'demo',
      'ai-sdk-provider': 'harness',
      'ai-sdk-session': hashSessionId('session-1'),
    });
    expect(sandbox.calls).toEqual(['run:pwd', 'run:echo setup']);
  });

  it('passes generic sandbox creation settings and converts mounts to volume entries', async () => {
    const createdOptions: Array<Record<string, unknown>> = [];
    const provider = new OpenSandboxProvider(
      {
        connectionConfig: { domain: 'localhost:8080', protocol: 'http' },
        entrypoint: ['sleep', 'infinity'],
        env: { NODE_ENV: 'test' },
        metadata: { app: 'demo' },
        networkPolicy: { egress: 'allow' },
        resource: { cpu: '2' },
        timeoutSeconds: 120,
        volumes: [
          { name: 'cache', host: { path: '/host/cache' }, mountPath: '/cache' },
        ],
        mounts: [
          {
            name: 'source',
            hostPath: '/host/source',
            mountPath: '/workspace/source',
          },
          {
            name: 'readonly',
            hostPath: '/host/readonly',
            mountPath: '/workspace/readonly',
            readOnly: true,
          },
        ],
      },
      {
        create: async options => {
          createdOptions.push(options);
          return makeSandbox();
        },
      },
    );

    await provider.createSession({ sessionId: 'session-1' });

    expect(createdOptions[0]).toEqual({
      connectionConfig: { domain: 'localhost:8080', protocol: 'http' },
      image: 'opensandbox/code-interpreter:v1.1.0',
      entrypoint: ['sleep', 'infinity'],
      env: { NODE_ENV: 'test' },
      metadata: {
        app: 'demo',
        'ai-sdk-provider': 'harness',
        'ai-sdk-session': hashSessionId('session-1'),
      },
      networkPolicy: { egress: 'allow' },
      resource: { cpu: '2' },
      timeoutSeconds: 120,
      volumes: [
        { name: 'cache', host: { path: '/host/cache' }, mountPath: '/cache' },
        {
          name: 'source',
          host: { path: '/host/source' },
          mountPath: '/workspace/source',
          readOnly: false,
        },
        {
          name: 'readonly',
          host: { path: '/host/readonly' },
          mountPath: '/workspace/readonly',
          readOnly: true,
        },
      ],
    });
  });

  it('rejects invalid generic volumes before creating a sandbox', async () => {
    let createCalled = false;
    const provider = new OpenSandboxProvider(
      {
        volumes: [{ name: 'cache' }],
      },
      {
        create: async () => {
          createCalled = true;
          return makeSandbox();
        },
      },
    );

    await expect(provider.createSession()).rejects.toThrow(
      'OpenSandbox volume 1 must include string name and mountPath.',
    );
    expect(createCalled).toBe(false);
  });

  it('wraps caller-supplied sandboxes without owning their lifecycle', async () => {
    const sandbox = makeSandbox({ pwd: '' });
    const provider = new OpenSandboxProvider({
      sandbox: sandbox as unknown as OpenSandboxSettings['sandbox'],
      ports: [3000],
    });

    const session = await provider.createSession();
    await session.stop();
    await session.destroy?.();

    expect(session.defaultWorkingDirectory).toBe('/workspace');
    expect(sandbox.lifecycleEvents).toEqual([]);
    expect(sandbox.calls).toEqual(['run:pwd']);
  });

  it('runs onFirstCreate for owned fresh sandboxes after setup scripts', async () => {
    const events: string[] = [];
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      { setupScripts: [{ command: 'echo setup' }] },
      {
        create: async () => sandbox,
      },
    );

    await provider.createSession({
      onFirstCreate: async (session, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        events.push(session.description);
      },
    });

    expect(sandbox.calls).toEqual(['run:pwd', 'run:echo setup']);
    expect(events).toEqual([
      'OpenSandbox sandbox sbx-1. Default working directory: /workspace/project',
    ]);
  });

  it('destroys owned fresh sandboxes when setup fails', async () => {
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      { setupScripts: [{ command: 'exit 1' }] },
      {
        create: async () => sandbox,
      },
    );

    await expect(provider.createSession()).rejects.toThrow(
      'Setup script 1 failed with exit code 1.',
    );
    expect(sandbox.lifecycleEvents).toEqual(['kill', 'close']);
  });

  it('preserves the original create failure when cleanup fails', async () => {
    const sandbox = makeSandbox();
    sandbox.kill = async () => {
      sandbox.lifecycleEvents.push('kill');
      throw new Error('cleanup failed');
    };
    const provider = new OpenSandboxProvider(
      { setupScripts: [{ command: 'exit 1' }] },
      {
        create: async () => sandbox,
      },
    );

    await expect(provider.createSession()).rejects.toThrow(
      'Setup script 1 failed with exit code 1.',
    );
  });

  it('pauses resumed sandboxes when setup fails', async () => {
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      { setupScripts: [{ command: 'exit 1', runOnResume: true }] },
      {
        list: async () => [{ id: 'sbx-1' }],
        connect: async () => sandbox,
      },
    );

    await expect(
      provider.resumeSession({ sessionId: 'session-1' }),
    ).rejects.toThrow('Setup script 1 failed with exit code 1.');
    expect(sandbox.lifecycleEvents).toEqual(['pause', 'close']);
  });

  it('preserves the original resume failure when cleanup fails', async () => {
    const sandbox = makeSandbox();
    sandbox.pause = async () => {
      sandbox.lifecycleEvents.push('pause');
      throw new Error('cleanup failed');
    };
    const provider = new OpenSandboxProvider(
      { setupScripts: [{ command: 'exit 1', runOnResume: true }] },
      {
        list: async () => [{ id: 'sbx-1' }],
        connect: async () => sandbox,
      },
    );

    await expect(
      provider.resumeSession({ sessionId: 'session-1' }),
    ).rejects.toThrow('Setup script 1 failed with exit code 1.');
  });

  it('honors aborted create requests before doing work', async () => {
    const abortController = new AbortController();
    let createCalled = false;
    const provider = new OpenSandboxProvider(
      {},
      {
        create: async () => {
          createCalled = true;
          return makeSandbox();
        },
      },
    );

    abortController.abort(new Error('create aborted'));

    await expect(
      provider.createSession({ abortSignal: abortController.signal }),
    ).rejects.toThrow('create aborted');
    expect(createCalled).toBe(false);
  });

  it('resumes a matching sandbox, owns its lifecycle, and runs resume setup', async () => {
    const listedMetadata: Array<Record<string, string>> = [];
    const connectedIds: string[] = [];
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      {
        metadata: { app: 'demo' },
        setupScripts: [{ command: 'echo resume', runOnResume: true }],
      },
      {
        list: async metadata => {
          listedMetadata.push(metadata);
          return [{ id: 'sbx-1' }];
        },
        connect: async id => {
          connectedIds.push(id);
          return sandbox;
        },
      },
    );

    const session = await provider.resumeSession({ sessionId: 'session-1' });
    await session.stop();

    expect(listedMetadata).toEqual([
      {
        app: 'demo',
        'ai-sdk-provider': 'harness',
        'ai-sdk-session': hashSessionId('session-1'),
      },
    ]);
    expect(connectedIds).toEqual(['sbx-1']);
    expect(sandbox.calls).toEqual(['run:pwd', 'run:echo resume']);
    expect(sandbox.lifecycleEvents).toEqual(['pause', 'close']);
  });

  it('resumes paused matching sandboxes before returning a session', async () => {
    const listedMetadata: Array<Record<string, string>> = [];
    const resumedIds: string[] = [];
    const connectedIds: string[] = [];
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      { metadata: { app: 'demo' } },
      {
        list: async metadata => {
          listedMetadata.push(metadata);
          return [{ id: 'sbx-1', state: 'Paused' }];
        },
        resume: async id => {
          resumedIds.push(id);
          return sandbox;
        },
        connect: async id => {
          connectedIds.push(id);
          return sandbox;
        },
      },
    );

    const session = await provider.resumeSession({ sessionId: 'session-1' });

    expect(session.id).toBe('sbx-1');
    expect(listedMetadata).toHaveLength(1);
    expect(resumedIds).toEqual(['sbx-1']);
    expect(connectedIds).toEqual([]);
  });

  it('resumes paused matching sandboxes returned with SDK status shape', async () => {
    const resumedIds: string[] = [];
    const connectedIds: string[] = [];
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      {},
      {
        list: async () => [{ id: 'sbx-1', status: { state: 'Paused' } }],
        resume: async id => {
          resumedIds.push(id);
          return sandbox;
        },
        connect: async id => {
          connectedIds.push(id);
          return sandbox;
        },
      },
    );

    await provider.resumeSession({ sessionId: 'session-1' });

    expect(resumedIds).toEqual(['sbx-1']);
    expect(connectedIds).toEqual([]);
  });

  it('throws a clear error when no sandbox matches resume metadata', async () => {
    const provider = new OpenSandboxProvider(
      {},
      {
        list: async () => [],
      },
    );

    await expect(
      provider.resumeSession({ sessionId: 'session-1' }),
    ).rejects.toThrow(
      'No OpenSandbox sandbox found for Harness session session-1.',
    );
  });

  it('throws a clear error when resume metadata lookup is ambiguous', async () => {
    const provider = new OpenSandboxProvider(
      {},
      {
        list: async () => [{ id: 'a' }, { id: 'b' }],
      },
    );

    await expect(
      provider.resumeSession({ sessionId: 'session-1' }),
    ).rejects.toThrow('multiple OpenSandbox sandboxes');
  });

  it('honors aborted resume requests before doing work', async () => {
    const abortController = new AbortController();
    let listCalled = false;
    const provider = new OpenSandboxProvider(
      {},
      {
        list: async () => {
          listCalled = true;
          return [];
        },
      },
    );

    abortController.abort(new Error('resume aborted'));

    await expect(
      provider.resumeSession({
        sessionId: 'session-1',
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow('resume aborted');
    expect(listCalled).toBe(false);
  });

  it('skips create-only setup scripts on resume', async () => {
    const sandbox = makeSandbox();
    const provider = new OpenSandboxProvider(
      {
        setupScripts: [
          {
            command: 'echo seed',
          },
        ],
      },
      {
        list: async () => [{ id: 'sbx-1' }],
        connect: async () => sandbox,
      },
    );

    await provider.resumeSession({ sessionId: 'session-1' });

    expect(sandbox.calls).toEqual(['run:pwd']);
  });
});
