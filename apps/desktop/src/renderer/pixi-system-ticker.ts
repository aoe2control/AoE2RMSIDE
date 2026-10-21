import { Ticker } from 'pixi.js';

export interface PixiSystemTicker {
  autoStart: boolean;
  stop(): void;
  update(currentTime?: number): void;
}

export function holdPixiSystemTicker(ticker: PixiSystemTicker = Ticker.system): {
  advance(now?: number): void;
} {
  ticker.autoStart = false;
  ticker.stop();
  return { advance: (now = performance.now()) => ticker.update(now) };
}
