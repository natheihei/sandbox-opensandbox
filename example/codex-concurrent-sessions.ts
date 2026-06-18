// End-to-end example for concurrent named sessions and resume behavior.
import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createCodex } from '@ai-sdk/harness-codex';
import { createCodexOpenSandbox } from './create-codex-opensandbox';

// Optional run id makes repeated example runs easy to correlate in logs and files.
const exampleRunId = process.env.EXAMPLE_RUN_ID;

const SESSION_NAMES = ['alpha', 'bravo', 'charlie'] as const;
const runId = (exampleRunId ?? new Date().toISOString()).replace(
  /[^a-zA-Z0-9_.-]/g,
  '-',
);
const agent = new HarnessAgent({
  harness: createCodex({ model: 'gpt-5.5' }),
  sandbox: createCodexOpenSandbox(),
  permissionMode: 'allow-all',
});

const sessionSpecs = SESSION_NAMES.map(name => ({
  name,
  sessionId: `opensandbox-example-${name}-${runId}`,
  fileName: `session-${name}.txt`,
}));

const activeSessions: Array<Awaited<ReturnType<typeof agent.createSession>>> =
  [];
const resumedSessions: Array<Awaited<ReturnType<typeof agent.createSession>>> =
  [];
const totalTimer = startTimer('example total');

try {
  console.log(`Starting ${sessionSpecs.length} concurrent sessions.`);
  console.log(`Run id: ${runId}`);

  const initialSessions = await time('create sessions total', () =>
    Promise.all(
      sessionSpecs.map(async spec => {
        const session = await time(`${spec.name} create session`, () =>
          agent.createSession({ sessionId: spec.sessionId }),
        );
        activeSessions.push(session);

        return { ...spec, session };
      }),
    ),
  );

  const initialResults = await time('initial generate total', () =>
    Promise.all(
      initialSessions.map(async spec => {
        const result = await time(`${spec.name} initial generate`, () =>
          agent.generate({
            session: spec.session,
            prompt: [
              `You are session ${spec.name}.`,
              `In your current working directory, create a file named ${spec.fileName} with exactly this first line: "${spec.name} initial ${runId}".`,
              `Then run pwd and cat ${spec.fileName}.`,
              'Reply with the session name, pwd output, and file contents.',
            ].join(' '),
          }),
        );

        return { ...spec, text: result.text };
      }),
    ),
  );

  for (const result of initialResults) {
    console.log(`\n--- ${result.name} initial ---\n${result.text}`);
  }

  console.log('\nStopping sessions to make them resumable.');
  const resumeStates = await time('stop sessions total', () =>
    Promise.all(
      initialResults.map(async spec => {
        const resumeFrom = await time(`${spec.name} stop session`, () =>
          spec.session.stop(),
        );

        return { ...spec, resumeFrom };
      }),
    ),
  );
  activeSessions.length = 0;

  console.log('Resuming the same sessions by sessionId and resume state.');
  const resumed = await time('resume sessions total', () =>
    Promise.all(
      resumeStates.map(async spec => {
        const session = await time(`${spec.name} resume session`, () =>
          agent.createSession({
            sessionId: spec.sessionId,
            resumeFrom: spec.resumeFrom,
          }),
        );
        resumedSessions.push(session);

        return { ...spec, session };
      }),
    ),
  );

  const resumedResults = await time('resumed generate total', () =>
    Promise.all(
      resumed.map(async spec => {
        const result = await time(`${spec.name} resumed generate`, () =>
          agent.generate({
            session: spec.session,
            prompt: [
              `This is resumed session ${spec.name}.`,
              `Verify that ${spec.fileName} still contains the original "${spec.name} initial ${runId}" line.`,
              `Append a second line exactly: "${spec.name} resumed ${runId}".`,
              `Then cat ${spec.fileName}.`,
              'Reply with whether the original line was present and the final file contents.',
            ].join(' '),
          }),
        );

        return { ...spec, text: result.text };
      }),
    ),
  );

  for (const result of resumedResults) {
    console.log(`\n--- ${result.name} resumed ---\n${result.text}`);
  }
} finally {
  await time('destroy resumed sessions total', () =>
    Promise.allSettled(
      resumedSessions.map(session =>
        time(`${session.sessionId} destroy resumed session`, () =>
          session.destroy(),
        ),
      ),
    ),
  );
  await time('destroy active sessions total', () =>
    Promise.allSettled(
      activeSessions.map(session =>
        time(`${session.sessionId} destroy active session`, () =>
          session.destroy(),
        ),
      ),
    ),
  );
  totalTimer.done();
}

async function time<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const timer = startTimer(label);

  try {
    return await operation();
  } finally {
    timer.done();
  }
}

function startTimer(label: string): { done: () => void } {
  const start = performance.now();
  const startedAt = new Date().toISOString();

  console.log(`[timing:start] ${label} at ${startedAt}`);

  return {
    done: () => {
      const durationMs = performance.now() - start;
      const durationSeconds = durationMs / 1000;

      console.log(
        `[timing:end] ${label} duration=${durationMs.toFixed(0)}ms (${durationSeconds.toFixed(1)}s)`,
      );
    },
  };
}
