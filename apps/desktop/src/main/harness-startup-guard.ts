export function underTestHarness(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.RMSIDE_E2E_HARNESS === '1';
}

export interface HarnessGuardProcess {
  env: NodeJS.ProcessEnv;
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  off(event: 'uncaughtException', listener: (error: unknown) => void): unknown;
  exit(code: number): never;
  stderr: { write(text: string): unknown };
}

export function installHarnessStartupGuard(target: HarnessGuardProcess): () => void {
  if (target.env.RMSIDE_E2E_HARNESS !== '1') return () => undefined;
  const listener = (error: unknown) => {
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    target.stderr.write(`RMSIDE main-process startup failed under the test harness:\n${text}\n`);
    target.exit(1);
  };
  target.on('uncaughtException', listener);
  return () => {
    target.off('uncaughtException', listener);
  };
}

export const removeHarnessStartupGuard = installHarnessStartupGuard(process);
