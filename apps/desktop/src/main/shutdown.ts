export const shutdownBoundMilliseconds = 10_000;

export interface ShutdownSteps {
  stopExecution(): Promise<unknown>;
  stopServices(): Promise<unknown>;
  killChildren(): void;
  exit(): void;
  log(message: string, error?: unknown): void;
}

export type ShutdownOutcome = 'completed' | 'timed-out';

export async function shutdownApplication(
  steps: ShutdownSteps,
  boundMilliseconds = shutdownBoundMilliseconds,
): Promise<ShutdownOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const orderly = (async (): Promise<ShutdownOutcome> => {
    await steps
      .stopExecution()
      .catch((error: unknown) => steps.log('stopping the active run failed while quitting', error));
    await steps
      .stopServices()
      .catch((error: unknown) =>
        steps.log('stopping the native processes failed while quitting', error),
      );
    return 'completed';
  })();
  const bound = new Promise<ShutdownOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), boundMilliseconds);
  });
  const outcome = await Promise.race([orderly, bound]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timed-out') {
    steps.log(
      `quitting did not finish within ${boundMilliseconds} ms; ending the remaining native processes`,
    );
  }
  try {
    steps.killChildren();
  } catch (error) {
    steps.log('ending the native processes failed while quitting', error);
  }
  steps.exit();
  return outcome;
}

interface ErrorEventTarget {
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (error: unknown) => void,
  ): unknown;
}

export function guardShutdownErrors(
  target: ErrorEventTarget,
  log: (message: string, error?: unknown) => void,
): void {
  target.on('uncaughtException', (error) => log('uncaught error while quitting', error));
  target.on('unhandledRejection', (error) => log('unhandled rejection while quitting', error));
}
