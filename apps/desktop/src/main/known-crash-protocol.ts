import {
  KnownCrashEvidence as ProtocolKnownCrashEvidence,
  type KnownCrashReference as ProtocolKnownCrashReference,
} from '../generated/rmside/v1/rmside_pb';
import {
  knownCrashReference,
  withKnownCrashMarker,
  type KnownCrashEvidence,
  type KnownCrashReference,
} from '../shared/known-crashes';

function evidenceWord(value: ProtocolKnownCrashEvidence): KnownCrashEvidence {
  if (value === ProtocolKnownCrashEvidence.LIVE) return 'live';
  if (value === ProtocolKnownCrashEvidence.STATIC) return 'static';
  return 'inferred';
}

export function fromProtocolKnownCrash(
  value: ProtocolKnownCrashReference | undefined,
): KnownCrashReference | null {
  if (!value) return null;
  return knownCrashReference({
    crashId: value.crashId,
    evidence: evidenceWord(value.evidence),
    arguments: value.arguments.map((argument) => ({
      name: argument.name,
      value: argument.value,
    })),
  });
}

export function protocolTextWithKnownCrash(
  text: string,
  value: ProtocolKnownCrashReference | undefined,
  enabled: boolean,
): string {
  const reference = enabled ? fromProtocolKnownCrash(value) : null;
  return reference ? withKnownCrashMarker(text, reference) : text;
}
