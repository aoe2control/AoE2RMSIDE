import { outputNote, type OutputMessage } from '../shared/output-message';

const gameProvidedMarker = ' (game-provided)';

export function unresolvedDependencyNote(dependency: string): OutputMessage {
  const gameProvided = dependency.endsWith(gameProvidedMarker);
  return outputNote(
    'Files',
    'files.clone-unresolved',
    {
      id: 'installed-maps.output.not-copied',
      args: { name: gameProvided ? dependency.slice(0, -gameProvidedMarker.length) : dependency },
    },
    {
      severity: 'warning',
      cause: {
        id: gameProvided
          ? 'installed-maps.output.not-copied.game-provided.cause'
          : 'installed-maps.output.not-copied.cause',
      },
    },
  );
}
