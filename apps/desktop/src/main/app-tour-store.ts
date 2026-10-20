import { join } from 'node:path';
import { readFileBounded, replaceFileAtomically } from './bounded-file';
import {
  doneTourProgress,
  initialTourProgress,
  parseTourRecord,
  tourRecordFileName,
  tourRecordFor,
  tourRecordMaximumBytes,
  type TourProgress,
} from '../shared/app-tour';

export class AppTourStore {
  readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    userDataPath: string,
    private readonly withoutRecord: TourProgress = initialTourProgress,
  ) {
    this.path = join(userDataPath, tourRecordFileName);
  }

  read(): Promise<TourProgress> {
    return this.serialize(() => this.readUnqueued());
  }

  write(progress: TourProgress): Promise<void> {
    return this.serialize(() =>
      replaceFileAtomically(this.path, JSON.stringify(tourRecordFor(progress))),
    );
  }

  private async readUnqueued(): Promise<TourProgress> {
    let bytes: Buffer;
    try {
      bytes = await readFileBounded(this.path, tourRecordMaximumBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return this.withoutRecord;
      return doneTourProgress;
    }
    try {
      return parseTourRecord(JSON.parse(bytes.toString('utf8')));
    } catch {
      return doneTourProgress;
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.catch(() => undefined).then(work);
    this.pending = run;
    return run;
  }
}
