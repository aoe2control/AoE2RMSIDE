import { useEffect, useState } from 'react';

export class DelayedFlag {
  private timer: unknown = null;
  private on = false;

  constructor(
    private readonly delayMilliseconds: number,
    private readonly onChange: (on: boolean) => void,
    private readonly timers: {
      set(callback: () => void, milliseconds: number): unknown;
      clear(handle: unknown): void;
    } = {
      set: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
      clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {}

  get value(): boolean {
    return this.on;
  }

  set(input: boolean): void {
    if (!input) {
      this.cancel();
      this.change(false);
      return;
    }
    if (this.on || this.timer !== null) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.change(true);
    }, this.delayMilliseconds);
  }

  cancel(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private change(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    this.onChange(on);
  }
}

export function useDelayedFlag(value: boolean, delayMilliseconds: number): boolean {
  const [on, setOn] = useState(false);
  const [flag] = useState(() => new DelayedFlag(delayMilliseconds, setOn));
  useEffect(() => {
    flag.set(value);
  }, [flag, value]);
  useEffect(() => () => flag.cancel(), [flag]);
  return value && on;
}
