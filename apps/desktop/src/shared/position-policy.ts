export const positionPolicies = [
  'random',
  'fixed',
  'team-together',
  'random-team-positions',
] as const;

export type PositionPolicy = (typeof positionPolicies)[number];

export const positionPolicyOptions: Readonly<
  Record<PositionPolicy, { teamTogether: boolean; teamPositions: boolean; nativeValue: number }>
> = {
  random: { teamTogether: false, teamPositions: false, nativeValue: 0 },
  fixed: { teamTogether: true, teamPositions: true, nativeValue: 1 },
  'team-together': { teamTogether: true, teamPositions: false, nativeValue: 2 },
  'random-team-positions': { teamTogether: false, teamPositions: true, nativeValue: 3 },
};

export function isPositionPolicy(value: unknown): value is PositionPolicy {
  return (positionPolicies as readonly unknown[]).includes(value);
}

export function positionPolicyFromLobbyOptions(
  teamTogether: boolean,
  teamPositions: boolean,
): PositionPolicy {
  if (teamTogether) return teamPositions ? 'fixed' : 'team-together';
  return teamPositions ? 'random-team-positions' : 'random';
}

export function positionPolicySetupMinor(policy: string): 0 | 3 {
  return policy === 'random-team-positions' ? 3 : 0;
}
