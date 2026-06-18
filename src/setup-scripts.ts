// Runs user-supplied initialization commands inside a restricted sandbox session.
import type { Experimental_SandboxSession as SandboxSession } from '@ai-sdk/provider-utils';
import type { OpenSandboxSetupScript } from './types';

/** Executes setup scripts for create or resume phases in declaration order. */
export async function runSetupScripts({
  session,
  scripts,
  phase,
  abortSignal,
}: {
  session: SandboxSession;
  scripts: ReadonlyArray<OpenSandboxSetupScript> | undefined;
  phase: 'create' | 'resume';
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (scripts == null || scripts.length === 0) {
    return;
  }

  for (let index = 0; index < scripts.length; index++) {
    const script = scripts[index]!;
    if (
      phase === 'resume' &&
      !(await shouldRunOnResume({
        script,
      }))
    ) {
      continue;
    }

    const result = await session.run({
      command: script.command,
      abortSignal,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Setup script ${index + 1} failed with exit code ${result.exitCode}.`,
      );
    }
  }
}

async function shouldRunOnResume({
  script,
}: {
  script: OpenSandboxSetupScript;
}): Promise<boolean> {
  // Resume is opt-in so one-time initialization does not overwrite persisted state.
  return script.runOnResume === true;
}
