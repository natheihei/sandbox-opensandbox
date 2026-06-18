// Adapts an OpenSandbox instance to the Harness network sandbox session API.
import { posix } from 'node:path';
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkSandboxSession,
} from '@ai-sdk/harness';
import {
  type Experimental_SandboxProcess,
  type Experimental_SandboxSession,
  extractLines,
} from '@ai-sdk/provider-utils';

const PROVIDER_ID = 'opensandbox';
const POLL_INTERVAL_MS = 250;

type OpenSandboxLike = {
  id: string;
  files: {
    readFile(path: string, options?: { encoding?: string }): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    writeFiles(
      entries: Array<{
        path: string;
        data: string | Uint8Array;
        mode?: number;
      }>,
    ): Promise<void>;
    createDirectories(
      entries: Array<{ path: string; mode?: number }>,
    ): Promise<void>;
  };
  commands: {
    run(
      command: string,
      options?: Record<string, unknown>,
      handlers?: unknown,
      abortSignal?: AbortSignal,
    ): Promise<{
      id?: string;
      exitCode?: number | null;
      logs?: {
        stdout?: unknown;
        stderr?: unknown;
      };
    }>;
    getCommandStatus?(commandId: string): Promise<{
      running?: boolean;
      exitCode?: number | null;
    }>;
    getBackgroundCommandLogs?(
      commandId: string,
      cursor?: number,
    ): Promise<{ content: string; cursor?: number }>;
    interrupt?(commandId: string): Promise<void>;
  };
  getEndpointUrl(port: number): Promise<string>;
  pause(): Promise<void>;
  kill(): Promise<void>;
  close(): Promise<void>;
};

export class OpenSandboxNetworkSandboxSession implements HarnessV1NetworkSandboxSession {
  readonly id: string;
  readonly defaultWorkingDirectory: string;
  readonly ports: ReadonlyArray<number>;
  private stopped = false;
  private destroyed = false;
  private stopPromise: Promise<void> | undefined;
  private destroyPromise: Promise<void> | undefined;

  constructor(
    private readonly input: {
      sandbox: OpenSandboxLike;
      ports: ReadonlyArray<number>;
      defaultWorkingDirectory: string;
      ownsLifecycle: boolean;
    },
  ) {
    this.id = input.sandbox.id;
    this.defaultWorkingDirectory = input.defaultWorkingDirectory;
    this.ports = [...input.ports];
  }

  get description(): string {
    return `OpenSandbox sandbox ${this.id}. Default working directory: ${this.defaultWorkingDirectory}`;
  }

  restricted(): Experimental_SandboxSession {
    return {
      description: this.description,
      readFile: options => this.readFile(options),
      readBinaryFile: options => this.readBinaryFile(options),
      readTextFile: options => this.readTextFile(options),
      writeFile: options => this.writeFile(options),
      writeBinaryFile: options => this.writeBinaryFile(options),
      writeTextFile: options => this.writeTextFile(options),
      spawn: options => this.spawn(options),
      run: options => this.run(options),
    };
  }

  async run({
    command,
    workingDirectory,
    env,
    abortSignal,
  }: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    abortSignal?.throwIfAborted();

    const execution = await this.input.sandbox.commands.run(
      command,
      { workingDirectory, envs: env },
      undefined,
      abortSignal,
    );

    return {
      exitCode: typeof execution.exitCode === 'number' ? execution.exitCode : 0,
      stdout: joinMessages(execution.logs?.stdout),
      stderr: joinMessages(execution.logs?.stderr),
    };
  }

  async spawn({
    command,
    workingDirectory,
    env,
    abortSignal,
  }: {
    command: string;
    workingDirectory?: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<Experimental_SandboxProcess> {
    abortSignal?.throwIfAborted();

    const execution = await this.input.sandbox.commands.run(
      command,
      { background: true, workingDirectory, envs: env },
      undefined,
      abortSignal,
    );

    if (typeof execution.id !== 'string' || execution.id.length === 0) {
      throw new Error(
        'OpenSandbox background command did not return an execution id.',
      );
    }

    const commandId = execution.id;
    let killPromise: Promise<void> | undefined;
    const interrupt = async () => {
      killPromise ??= (async () => {
        if (this.input.sandbox.commands.interrupt == null) {
          throw new Error(
            'OpenSandbox background command interruption is not supported by this sandbox.',
          );
        }

        await this.input.sandbox.commands.interrupt(commandId);
      })();

      await killPromise;
    };
    const abortListener = () => {
      void interrupt().catch(() => undefined);
    };
    abortSignal?.addEventListener('abort', abortListener, { once: true });
    const cleanupAbortListener = () => {
      abortSignal?.removeEventListener('abort', abortListener);
    };

    return {
      stdout: createBackgroundLogStream({
        commandId,
        abortSignal,
        onDone: cleanupAbortListener,
        getLogs: async (id, cursor) =>
          this.input.sandbox.commands.getBackgroundCommandLogs?.(id, cursor),
        getStatus: id => this.input.sandbox.commands.getCommandStatus?.(id),
      }),
      stderr: createEmptyStream(),
      wait: async () => {
        if (this.input.sandbox.commands.getCommandStatus == null) {
          throw new Error(
            'OpenSandbox background command status is not supported by this sandbox.',
          );
        }

        try {
          while (true) {
            abortSignal?.throwIfAborted();

            const status =
              await this.input.sandbox.commands.getCommandStatus(commandId);

            if (status.running !== true) {
              return {
                exitCode:
                  typeof status.exitCode === 'number' ? status.exitCode : 0,
              };
            }

            await delay(POLL_INTERVAL_MS, abortSignal);
          }
        } finally {
          cleanupAbortListener();
        }
      },
      kill: async () => {
        try {
          await interrupt();
        } finally {
          cleanupAbortListener();
        }
      },
    };
  }

  async readFile(options: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile(options);

    if (bytes == null) {
      return null;
    }

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async readBinaryFile({
    path,
    abortSignal,
  }: {
    path: string;
    abortSignal?: AbortSignal;
  }): Promise<Uint8Array | null> {
    abortSignal?.throwIfAborted();

    try {
      return await this.input.sandbox.files.readBytes(path);
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async readTextFile({
    path,
    encoding = 'utf-8',
    startLine,
    endLine,
    abortSignal,
  }: {
    path: string;
    encoding?: string;
    startLine?: number;
    endLine?: number;
    abortSignal?: AbortSignal;
  }): Promise<string | null> {
    const bytes = await this.readBinaryFile({ path, abortSignal });

    if (bytes == null) {
      return null;
    }

    return extractTextLines({
      text: Buffer.from(bytes).toString(encoding as BufferEncoding),
      startLine,
      endLine,
    });
  }

  async writeFile({
    path,
    content,
    abortSignal,
  }: {
    path: string;
    content: ReadableStream<Uint8Array>;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const bytes = await collectStream(content);

    await this.writeBinaryFile({ path, content: bytes, abortSignal });
  }

  async writeBinaryFile({
    path,
    content,
    abortSignal,
  }: {
    path: string;
    content: Uint8Array;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    abortSignal?.throwIfAborted();

    await this.ensureParent(path);
    await this.input.sandbox.files.writeFiles([{ path, data: content }]);
  }

  async writeTextFile({
    path,
    content,
    encoding = 'utf-8',
    abortSignal,
  }: {
    path: string;
    content: string;
    encoding?: string;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    await this.writeBinaryFile({
      path,
      content: Buffer.from(content, encoding as BufferEncoding),
      abortSignal,
    });
  }

  getPortUrl = async ({
    port,
    protocol = 'https',
  }: {
    port: number;
    protocol?: 'http' | 'https' | 'ws';
  }): Promise<string> => {
    if (!this.ports.includes(port)) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: PROVIDER_ID,
        message: `Port ${port} is not declared. Declared ports: [${this.ports.join(', ')}].`,
      });
    }

    const url = new URL(await this.input.sandbox.getEndpointUrl(port));

    if (protocol === 'ws') {
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    } else {
      url.protocol = protocol === 'https' ? 'https:' : 'http:';
    }

    return url.toString();
  };

  stop = async (): Promise<void> => {
    if (!this.input.ownsLifecycle || this.destroyed) {
      return;
    }

    if (this.stopPromise != null) {
      await this.stopPromise;
      return;
    }

    if (this.stopped) {
      return;
    }

    this.stopped = true;
    this.stopPromise ??= (async () => {
      try {
        await this.input.sandbox.pause();
      } finally {
        await this.input.sandbox.close();
      }
    })();

    await this.stopPromise;
  };

  destroy = async (): Promise<void> => {
    if (!this.input.ownsLifecycle || this.stopped) {
      return;
    }

    if (this.destroyPromise != null) {
      await this.destroyPromise;
      return;
    }

    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.destroyPromise ??= (async () => {
      try {
        await this.input.sandbox.kill();
      } finally {
        await this.input.sandbox.close();
      }
    })();

    await this.destroyPromise;
  };

  private async ensureParent(path: string): Promise<void> {
    const parent = posix.dirname(path);

    if (parent !== '' && parent !== '.' && parent !== '/') {
      await this.input.sandbox.files.createDirectories([
        { path: parent, mode: 755 },
      ]);
    }
  }
}

function joinMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }

  return messages
    .map(message => String((message as { text?: unknown }).text ?? ''))
    .join('');
}

function createBackgroundLogStream({
  commandId,
  abortSignal,
  onDone,
  getLogs,
  getStatus,
}: {
  commandId: string;
  abortSignal?: AbortSignal;
  onDone?: () => void;
  getLogs: (
    commandId: string,
    cursor?: number,
  ) => Promise<{ content: string; cursor?: number } | undefined>;
  getStatus: (
    commandId: string,
  ) =>
    | Promise<{ running?: boolean; exitCode?: number | null } | undefined>
    | undefined;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const streamAbortController = new AbortController();
  let cursor: number | undefined;
  let finalDrain = false;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    onDone?.();
    streamAbortController.abort();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        try {
          abortSignal?.throwIfAborted();

          const logs = await getLogs(commandId, cursor);

          if (logs != null) {
            cursor = logs.cursor ?? cursor;

            if (logs.content.length > 0) {
              controller.enqueue(encoder.encode(logs.content));
              return;
            }
          }

          const status = await getStatus(commandId);

          if (status == null || status.running !== true) {
            // OpenSandbox can report completion before the last log chunk is
            // visible, so do one final polling delay before closing stdout.
            if (!finalDrain) {
              finalDrain = true;
              await delayWithAbortSignals(
                POLL_INTERVAL_MS,
                abortSignal,
                streamAbortController.signal,
              );
              continue;
            }
            finish();
            controller.close();
            return;
          }

          await delayWithAbortSignals(
            POLL_INTERVAL_MS,
            abortSignal,
            streamAbortController.signal,
          );
        } catch (error) {
          if (done) return;
          finish();
          controller.error(error);
          return;
        }
      }
    },
    cancel() {
      finish();
    },
  });
}

function createEmptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

async function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted();

  await new Promise<void>((resolve, reject) => {
    if (abortSignal == null) {
      setTimeout(resolve, ms);
      return;
    }

    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      abortSignal.removeEventListener('abort', onAbort);
      reject(abortSignal.reason);
    };

    timeout = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });

  abortSignal?.throwIfAborted();
}

async function delayWithAbortSignals(
  ms: number,
  first: AbortSignal | undefined,
  second: AbortSignal,
): Promise<void> {
  first?.throwIfAborted();
  second.throwIfAborted();

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timeout);
      first?.removeEventListener('abort', onFirstAbort);
      second.removeEventListener('abort', onSecondAbort);
    };
    const abort = (signal: AbortSignal) => {
      cleanup();
      reject(signal.reason);
    };
    const onFirstAbort = () => {
      if (first != null) {
        abort(first);
      }
    };
    const onSecondAbort = () => {
      abort(second);
    };

    timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    first?.addEventListener('abort', onFirstAbort, { once: true });
    second.addEventListener('abort', onSecondAbort, { once: true });
  });

  first?.throwIfAborted();
  second.throwIfAborted();
}

function isNotFound(error: unknown): boolean {
  // The SDK has returned both structured status fields and plain messages for
  // missing files, so normalize all known shapes into Harness's null result.
  if (error != null && typeof error === 'object') {
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      response?: { status?: unknown };
    };
    if (
      candidate.status === 404 ||
      candidate.statusCode === 404 ||
      candidate.response?.status === 404 ||
      candidate.code === 'ENOENT' ||
      candidate.code === 'NOT_FOUND'
    ) {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);

  return /not found|no such file|enoent/i.test(message);
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    if (value != null) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

async function extractTextLines({
  text,
  startLine,
  endLine,
}: {
  text: string;
  startLine?: number;
  endLine?: number;
}): Promise<string> {
  if (startLine == null && endLine == null) {
    return text;
  }

  return extractLines({ text, startLine, endLine });
}
