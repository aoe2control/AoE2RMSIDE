import { presentMessage } from '../shared/message-catalog';
import type { OutputMessage } from '../shared/output-message';

export interface SessionAutosaveReporter {
  save(run: () => Promise<void>): Promise<void>;
}

export function createSessionAutosaveReporter(
  report: (message: OutputMessage) => void,
): SessionAutosaveReporter {
  let failureReported = false;
  return {
    async save(run) {
      try {
        await run();
        failureReported = false;
      } catch (error) {
        if (failureReported) return;
        failureReported = true;
        report(
          presentMessage({
            source: 'App',
            code: 'session.save-failed',
            raw: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
  };
}
