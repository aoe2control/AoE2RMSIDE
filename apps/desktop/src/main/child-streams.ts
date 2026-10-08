interface ChildStreams {
  readonly stdin?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

interface ErrorEmitter {
  on(event: 'error', listener: (error: Error) => void): unknown;
}

function emitsErrors(stream: unknown): stream is ErrorEmitter {
  return (
    typeof stream === 'object' &&
    stream !== null &&
    typeof (stream as { on?: unknown }).on === 'function'
  );
}

export function guardChildStreams(child: ChildStreams, onError: (error: Error) => void): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (emitsErrors(stream)) {
      stream.on('error', (error) =>
        onError(error instanceof Error ? error : new Error(String(error))),
      );
    }
  }
}

export function isClosedPipeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === 'EPIPE' ||
    code === 'EOF' ||
    code === 'ECONNRESET' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END'
  );
}
