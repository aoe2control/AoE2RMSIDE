export const nativeOcclusionFeature = 'CalculateNativeWinOcclusion';

export function withDisabledFeature(current: string, feature: string): string {
  const features = current
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (!features.includes(feature)) features.push(feature);
  return features.join(',');
}

export const windowStackerScript = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -Namespace RmsideWindowStacking -Name Native -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr window, System.IntPtr insertAfter, int x, int y, int width, int height, uint flags);\'',
  "[Console]::Out.WriteLine('ready')",
  '[Console]::Out.Flush()',
  'while ($null -ne ($line = [Console]::In.ReadLine())) {',
  "  $answer = 'failed'",
  '  try {',
  '    if ([RmsideWindowStacking.Native]::SetWindowPos([System.IntPtr][System.Int64]$line, [System.IntPtr]1, 0, 0, 0, 0, 0x13)) {',
  "      $answer = 'ok'",
  '    }',
  '  } catch {}',
  '  [Console]::Out.WriteLine($answer)',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

export function windowStackerCommand(systemRoot: string | undefined): {
  file: string;
  args: string[];
} {
  const root = systemRoot && systemRoot.trim() !== '' ? systemRoot : 'C:\\Windows';
  return {
    file: `${root.replace(/[\\/]+$/u, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(windowStackerScript, 'utf16le').toString('base64'),
    ],
  };
}

export function windowHandleText(handle: Buffer): string {
  return handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
}

export interface WindowStackerProcess {
  stdin: {
    write(text: string): unknown;
    end(): unknown;
    on(event: 'error', listener: () => void): unknown;
  } | null;
  stdout: {
    setEncoding(encoding: 'utf8'): unknown;
    on(event: 'data', listener: (chunk: string) => void): unknown;
  } | null;
  on(event: 'exit' | 'error', listener: () => void): unknown;
}

export interface WindowStacker {
  placeAtBottom(handle: Buffer): Promise<boolean>;
  close(): void;
}

export function startWindowStacker(
  spawnHelper: () => WindowStackerProcess,
  timeoutMs = 15_000,
): WindowStacker {
  const pending: Array<(placed: boolean) => void> = [];
  let alive = true;
  let markReady: (ready: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    markReady = resolve;
  });
  let helper: WindowStackerProcess | null = null;
  const end = () => {
    alive = false;
    markReady(false);
    for (const settle of pending.splice(0)) settle(false);
  };
  try {
    helper = spawnHelper();
  } catch {
    end();
  }
  if (helper) {
    let buffered = '';
    let started = false;
    helper.stdout?.setEncoding('utf8');
    helper.stdout?.on('data', (chunk) => {
      buffered += chunk;
      for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (!started) {
          started = line === 'ready';
          if (started) markReady(true);
          continue;
        }
        pending.shift()?.(line === 'ok');
      }
    });
    helper.on('exit', end);
    helper.on('error', end);
    helper.stdin?.on('error', end);
  }
  const withinLimit = <Value>(promise: Promise<Value>, fallback: Value) =>
    new Promise<Value>((resolve) => {
      const timer = setTimeout(() => resolve(fallback), timeoutMs);
      void promise.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  return {
    async placeAtBottom(handle) {
      if (!(await withinLimit(ready, false)) || !alive || !helper?.stdin) return false;
      const stdin = helper.stdin;
      const answer = new Promise<boolean>((resolve) => {
        pending.push(resolve);
        stdin.write(`${windowHandleText(handle)}\n`);
      });
      return withinLimit(answer, false);
    },
    close() {
      if (!alive) return;
      helper?.stdin?.end();
      end();
    },
  };
}

export interface StackedWindow {
  getNativeWindowHandle(): Buffer;
  isDestroyed(): boolean;
  showInactive(): void;
  maximize(): void;
  on(event: 'show' | 'restore' | 'maximize', listener: () => void): unknown;
}

export const windowStackingEvents = ['show', 'restore', 'maximize'] as const;

export async function showWindowAtBack(
  window: StackedWindow,
  stacker: WindowStacker,
  maximized: boolean,
): Promise<void> {
  const keepAtBack = () => {
    if (!window.isDestroyed()) void stacker.placeAtBottom(window.getNativeWindowHandle());
  };
  for (const event of windowStackingEvents) window.on(event, keepAtBack);
  if (window.isDestroyed()) return;
  await stacker.placeAtBottom(window.getNativeWindowHandle());
  if (window.isDestroyed()) return;
  window.showInactive();
  if (maximized) window.maximize();
}
