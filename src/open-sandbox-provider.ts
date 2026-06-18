// Maps the AI SDK Harness sandbox provider interface onto OpenSandbox lifecycle APIs.
import { createHash } from 'node:crypto';
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from '@ai-sdk/harness';
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import {
  Sandbox,
  type SandboxConnectOptions,
  type SandboxCreateOptions,
  SandboxManager,
  type SandboxManagerOptions,
} from '@alibaba-group/opensandbox';
import { OpenSandboxNetworkSandboxSession } from './open-sandbox-session';
import { runSetupScripts } from './setup-scripts';
import type { OpenSandboxSettings } from './types';

type OpenSandboxLike = ConstructorParameters<
  typeof OpenSandboxNetworkSandboxSession
>[0]['sandbox'];

type OpenSandboxCreateOptions = {
  connectionConfig?: OpenSandboxSettings['connectionConfig'];
  image: NonNullable<SandboxCreateOptions['image']>;
  entrypoint?: ReadonlyArray<string>;
  env?: Record<string, string>;
  metadata: Record<string, string>;
  networkPolicy?: SandboxCreateOptions['networkPolicy'];
  resource?: Record<string, string>;
  timeoutSeconds?: number | null;
  volumes?: SandboxCreateOptions['volumes'];
};

type OpenSandboxDependencies = {
  create?: (options: OpenSandboxCreateOptions) => Promise<OpenSandboxLike>;
  connect?: (sandboxId: string) => Promise<OpenSandboxLike>;
  resume?: (sandboxId: string) => Promise<OpenSandboxLike>;
  list?: (
    metadata: Record<string, string>,
  ) => Promise<Array<OpenSandboxListItem>>;
};

type OpenSandboxListItem = {
  id: string;
  state?: string;
  status?: { state?: string };
};

const PROVIDER_ID = 'opensandbox';
const DEFAULT_IMAGE = 'opensandbox/code-interpreter:v1.1.0';

export function createOpenSandbox(
  settings: OpenSandboxSettings,
): HarnessV1SandboxProvider {
  return new OpenSandboxProvider(settings);
}

/** Creates, resumes, and wraps OpenSandbox instances as Harness sessions. */
export class OpenSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = 'harness-sandbox-v1' as const;
  readonly providerId = PROVIDER_ID;

  constructor(
    private readonly settings: OpenSandboxSettings,
    private readonly dependencies: OpenSandboxDependencies = {},
  ) {}

  /** Creates a fresh sandbox session and runs create-phase setup scripts. */
  createSession = async ({
    sessionId,
    abortSignal,
    onFirstCreate,
  }: {
    sessionId?: string;
    abortSignal?: AbortSignal;
    identity?: string;
    onFirstCreate?: (
      session: SandboxSession,
      opts: { abortSignal?: AbortSignal },
    ) => Promise<void>;
  } = {}): Promise<HarnessV1NetworkSandboxSession> => {
    abortSignal?.throwIfAborted();

    const ownsLifecycle = this.settings.sandbox == null;
    const sandbox =
      this.settings.sandbox ??
      (await this.createSandbox(this.metadataForSession(sessionId)));
    let session: OpenSandboxNetworkSandboxSession | undefined;

    try {
      session = new OpenSandboxNetworkSandboxSession({
        sandbox,
        ports: this.settings.ports ?? [],
        defaultWorkingDirectory: await resolveDefaultWorkingDirectory(sandbox),
        ownsLifecycle,
      });
      // Setup hooks and onFirstCreate receive the restricted API so they cannot
      // accidentally stop or destroy the sandbox they are preparing.
      const restrictedSession = session.restricted();

      await runSetupScripts({
        session: restrictedSession,
        scripts: this.settings.setupScripts,
        phase: 'create',
        abortSignal,
      });

      if (ownsLifecycle && onFirstCreate != null) {
        await onFirstCreate(restrictedSession, { abortSignal });
      }

      return session;
    } catch (error) {
      if (ownsLifecycle) {
        await cleanupOwnedSandbox({ session, sandbox, mode: 'destroy' }).catch(
          () => undefined,
        );
      }
      throw error;
    }
  };

  /** Reconnects to the single sandbox associated with a named Harness session. */
  resumeSession = async ({
    sessionId,
    abortSignal,
  }: {
    sessionId: string;
    abortSignal?: AbortSignal;
  }): Promise<HarnessV1NetworkSandboxSession> => {
    abortSignal?.throwIfAborted();

    const metadata = this.metadataForSession(sessionId);
    const matches = await this.listSandboxes(metadata);

    if (matches.length === 0) {
      throw new Error(
        `No OpenSandbox sandbox found for Harness session ${sessionId}.`,
      );
    }

    if (matches.length > 1) {
      throw new Error(
        `Found multiple OpenSandbox sandboxes for Harness session ${sessionId}.`,
      );
    }

    const match = matches[0]!;
    const sandbox =
      match.state === 'Paused'
        ? await this.resumeSandbox(match.id)
        : await this.connectSandbox(match.id);
    let session: OpenSandboxNetworkSandboxSession | undefined;

    try {
      session = new OpenSandboxNetworkSandboxSession({
        sandbox,
        ports: this.settings.ports ?? [],
        defaultWorkingDirectory: await resolveDefaultWorkingDirectory(sandbox),
        ownsLifecycle: true,
      });
      const restrictedSession = session.restricted();

      await runSetupScripts({
        session: restrictedSession,
        scripts: this.settings.setupScripts,
        phase: 'resume',
        abortSignal,
      });

      return session;
    } catch (error) {
      await cleanupOwnedSandbox({ session, sandbox, mode: 'stop' }).catch(
        () => undefined,
      );
      throw error;
    }
  };

  private metadataForSession(
    sessionId: string | undefined,
  ): Record<string, string> {
    return {
      ...(this.settings.metadata ?? {}),
      'ai-sdk-provider': 'harness',
      ...(sessionId == null
        ? {}
        : { 'ai-sdk-session': hashSessionId(sessionId) }),
    };
  }

  private async createSandbox(
    metadata: Record<string, string>,
  ): Promise<OpenSandboxLike> {
    const options = this.createSandboxOptions(metadata);

    if (this.dependencies.create != null) {
      return this.dependencies.create(options);
    }

    return Sandbox.create(
      options as SandboxCreateOptions,
    ) as Promise<OpenSandboxLike>;
  }

  private createSandboxOptions(
    metadata: Record<string, string>,
  ): OpenSandboxCreateOptions {
    return {
      connectionConfig: this.settings.connectionConfig,
      image: this.settings.image ?? DEFAULT_IMAGE,
      entrypoint: this.settings.entrypoint,
      env: this.settings.env,
      metadata,
      networkPolicy: this.settings.networkPolicy as
        | SandboxCreateOptions['networkPolicy']
        | undefined,
      resource: this.settings.resource,
      timeoutSeconds: this.settings.timeoutSeconds,
      volumes: this.createVolumes() as SandboxCreateOptions['volumes'],
    };
  }

  private createVolumes(): SandboxCreateOptions['volumes'] | undefined {
    const volumes = [
      ...(this.settings.volumes ?? []).map((volume, index) =>
        validateVolume(volume, index),
      ),
      ...(this.settings.mounts ?? []).map(mount => ({
        name: mount.name,
        host: { path: mount.hostPath },
        mountPath: mount.mountPath,
        readOnly: mount.readOnly ?? false,
      })),
    ];

    return volumes.length === 0
      ? undefined
      : (volumes as SandboxCreateOptions['volumes']);
  }

  private async listSandboxes(
    metadata: Record<string, string>,
  ): Promise<Array<{ id: string; state?: string }>> {
    if (this.dependencies.list != null) {
      return (await this.dependencies.list(metadata)).map(normalizeListItem);
    }

    const manager = SandboxManager.create({
      connectionConfig: this.settings.connectionConfig,
    } as SandboxManagerOptions);

    try {
      const result = await manager.listSandboxInfos({
        states: ['Running', 'Paused'],
        metadata,
        pageSize: 2,
      });
      const items = Array.isArray(result) ? result : result.items;

      return items.map((item: OpenSandboxListItem) => normalizeListItem(item));
    } finally {
      await manager.close?.();
    }
  }

  private async connectSandbox(sandboxId: string): Promise<OpenSandboxLike> {
    if (this.dependencies.connect != null) {
      return this.dependencies.connect(sandboxId);
    }

    return Sandbox.connect({
      sandboxId,
      connectionConfig: this.settings.connectionConfig,
    } as SandboxConnectOptions) as Promise<OpenSandboxLike>;
  }

  private async resumeSandbox(sandboxId: string): Promise<OpenSandboxLike> {
    if (this.dependencies.resume != null) {
      return this.dependencies.resume(sandboxId);
    }

    return Sandbox.resume({
      sandboxId,
      connectionConfig: this.settings.connectionConfig,
    } as SandboxConnectOptions) as Promise<OpenSandboxLike>;
  }
}

function normalizeListItem(item: OpenSandboxListItem): {
  id: string;
  state?: string;
} {
  return {
    id: item.id,
    state: item.state ?? item.status?.state,
  };
}

function validateVolume(
  volume: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  if (
    volume == null ||
    typeof volume !== 'object' ||
    typeof volume.name !== 'string' ||
    typeof volume.mountPath !== 'string'
  ) {
    throw new Error(
      `OpenSandbox volume ${index + 1} must include string name and mountPath.`,
    );
  }

  const backendCount = ['host', 'pvc', 'ossfs'].filter(key =>
    Object.prototype.hasOwnProperty.call(volume, key),
  ).length;

  if (backendCount !== 1) {
    throw new Error(
      `OpenSandbox volume ${index + 1} must include exactly one backend: host, pvc, or ossfs.`,
    );
  }

  return volume;
}

async function cleanupOwnedSandbox({
  session,
  sandbox,
  mode,
}: {
  session: OpenSandboxNetworkSandboxSession | undefined;
  sandbox: OpenSandboxLike;
  mode: 'destroy' | 'stop';
}): Promise<void> {
  // If session construction failed, fall back to the raw SDK object so owned
  // sandboxes do not leak after setup or resume errors.
  try {
    if (session != null) {
      if (mode === 'destroy') {
        await session.destroy?.();
      } else {
        await session.stop();
      }
      return;
    }

    if (mode === 'destroy') {
      await sandbox.kill();
    } else {
      await sandbox.pause();
    }
  } finally {
    if (session == null) {
      await sandbox.close();
    }
  }
}

function hashSessionId(sessionId: string): string {
  // Hash caller-provided IDs before storing them as provider metadata.
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

async function resolveDefaultWorkingDirectory(
  sandbox: OpenSandboxLike,
): Promise<string> {
  const result = await sandbox.commands.run('pwd');
  const stdout = joinMessages(result.logs?.stdout).trim();

  return stdout.length === 0 ? '/workspace' : stdout;
}

function joinMessages(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }

  return messages
    .map(message => String((message as { text?: unknown }).text ?? ''))
    .join('');
}
