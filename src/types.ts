import type { ConnectionConfig, Sandbox } from '@alibaba-group/opensandbox';

/** Host directory mounted into each created OpenSandbox container. */
export type OpenSandboxMount = {
  /** Stable volume name passed to OpenSandbox. */
  readonly name: string;
  /** Host filesystem path that OpenSandbox should mount. */
  readonly hostPath: string;
  /** Container path where the host path is mounted. */
  readonly mountPath: string;
  /** Whether the sandbox can write back to the host mount. */
  readonly readOnly?: boolean;
};

/** Shell script executed after a sandbox is created or resumed. */
export type OpenSandboxSetupScript = {
  /** Command body executed with the sandbox session run API. */
  readonly command: string;
  /** By default setup scripts run only on first create. */
  readonly runOnResume?: boolean;
};

/** Settings for creating or wrapping OpenSandbox instances. */
export type OpenSandboxSettings = {
  /** Existing sandbox instance to wrap instead of creating a new one. */
  readonly sandbox?: Sandbox;
  /** OpenSandbox control-plane connection options. */
  readonly connectionConfig?: ConnectionConfig | Record<string, unknown>;
  /** Container image used when this provider owns sandbox creation. */
  readonly image?: string;
  /** Optional container entrypoint override. */
  readonly entrypoint?: ReadonlyArray<string>;
  /** Environment variables injected into the sandbox container. */
  readonly env?: Record<string, string>;
  /** Metadata used for lookup when resuming named sessions. */
  readonly metadata?: Record<string, string>;
  /** Provider-specific network policy forwarded to OpenSandbox. */
  readonly networkPolicy?: Record<string, unknown>;
  /** Provider-specific resource limits forwarded to OpenSandbox. */
  readonly resource?: Record<string, string>;
  /** Sandbox timeout in seconds; null disables the provider default. */
  readonly timeoutSeconds?: number | null;
  /** Ports that may be exposed through the Harness getPortUrl API. */
  readonly ports?: ReadonlyArray<number>;
  /** Raw OpenSandbox volume definitions for advanced callers. */
  readonly volumes?: ReadonlyArray<Record<string, unknown>>;
  /** Convenience host mounts converted into OpenSandbox volumes. */
  readonly mounts?: ReadonlyArray<OpenSandboxMount>;
  /** Commands to prepare tools, credentials, or workspace state. */
  readonly setupScripts?: ReadonlyArray<OpenSandboxSetupScript>;
};
