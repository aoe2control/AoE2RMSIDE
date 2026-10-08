export class SourceStructureRequest<TStructure> {
  private attempt = 0;
  private inFlight = false;
  private finished = false;
  private timer: unknown = null;

  constructor(
    private readonly options: {
      request(): Promise<TStructure | null>;
      current(): boolean;
      apply(structure: TStructure): void;
      delays: readonly number[];
      setTimer(callback: () => void, milliseconds: number): unknown;
      clearTimer(timer: unknown): void;
    },
  ) {}

  start(): void {
    this.ask();
  }

  poke(): void {
    if (this.finished || this.inFlight) return;
    if (!this.options.current()) {
      this.stop();
      return;
    }
    this.ask();
  }

  stop(): void {
    this.finished = true;
    this.clearTimer();
  }

  get pending(): boolean {
    return !this.finished;
  }

  private ask(): void {
    this.clearTimer();
    this.inFlight = true;
    void this.options.request().then(
      (structure) => this.answered(structure),
      () => this.answered(null),
    );
  }

  private answered(structure: TStructure | null): void {
    this.inFlight = false;
    if (this.finished) return;
    if (!this.options.current()) {
      this.stop();
      return;
    }
    if (structure !== null) {
      this.stop();
      this.options.apply(structure);
      return;
    }
    const delay = this.options.delays[this.attempt];
    this.attempt += 1;
    if (delay === undefined) return;
    this.timer = this.options.setTimer(() => {
      this.timer = null;
      this.poke();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.options.clearTimer(this.timer);
    this.timer = null;
  }
}
