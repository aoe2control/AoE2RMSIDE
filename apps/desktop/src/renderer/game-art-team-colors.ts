import type { GameArtTeamColor, GameArtTeamColors } from '../shared/game-art';
import { ownerPlayerColorIndex, ownerPreviewColor } from './preview-materials';

export interface TeamColor {
  red: number;
  green: number;
  blue: number;
  pivot: number;
}

export const teamColorRampThroughWhite = true;

export const teamColorBrightnessGain = 1;

const luminanceWeights = [0.299, 0.587, 0.114] as const;

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

export function teamColoredPixel(
  rgb: readonly [number, number, number],
  mask: number,
  team: TeamColor,
  rampThroughWhite = teamColorRampThroughWhite,
  gain = teamColorBrightnessGain,
): [number, number, number] {
  const color = [rgb[0] * gain, rgb[1] * gain, rgb[2] * gain] as const;
  const brightness =
    color[0] * luminanceWeights[0] +
    color[1] * luminanceWeights[1] +
    color[2] * luminanceWeights[2];
  const pivot = rampThroughWhite ? mix(team.pivot, 0.5, mask) : team.pivot;
  const contrast = rampThroughWhite ? mix(0.5, team.pivot, mask) : 0.5;
  const teamChannels = [team.red, team.green, team.blue] as const;
  const result: [number, number, number] = [0, 0, 0];
  if (brightness < pivot) {
    const along = pivot > 0 ? brightness / pivot : 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const original = color[channel]! * 2 * contrast;
      result[channel] = mix(original, teamChannels[channel]! * along, mask);
    }
  } else {
    const along = pivot < 1 ? (1 - brightness) / (1 - pivot) : 0;
    const scale = 2 * ((2 * brightness - 1) * (0.5 - contrast) + contrast);
    for (let channel = 0; channel < 3; channel += 1) {
      const original = color[channel]! * scale;
      result[channel] = mix(original, along * (teamChannels[channel]! - 1) + 1, mask);
    }
  }
  return result;
}

export function teamColorPixels(
  main: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  team: TeamColor,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(main.length);
  for (let index = 0; index < main.length; index += 4) {
    const strength = mask[index]! / 255;
    const alpha = main[index + 3]!;
    if (strength <= 0 || alpha === 0) continue;
    const shown = teamColoredPixel(
      [main[index]! / 255, main[index + 1]! / 255, main[index + 2]! / 255],
      strength,
      team,
    );
    result[index] = Math.round(Math.min(1, Math.max(0, shown[0])) * 255);
    result[index + 1] = Math.round(Math.min(1, Math.max(0, shown[1])) * 255);
    result[index + 2] = Math.round(Math.min(1, Math.max(0, shown[2])) * 255);
    result[index + 3] = alpha;
  }
  return result;
}

export function teamColorFromRgb(rgb: number, pivot = 1): TeamColor {
  return {
    red: ((rgb >> 16) & 0xff) / 255,
    green: ((rgb >> 8) & 0xff) / 255,
    blue: (rgb & 0xff) / 255,
    pivot,
  };
}

function fromInstallation(color: GameArtTeamColor): TeamColor {
  return { red: color.red, green: color.green, blue: color.blue, pivot: color.pivot };
}

const gaiaStandIn: TeamColor = { red: 1, green: 1, blue: 1, pivot: 1 };

export function teamColorResolver(
  installation: GameArtTeamColors | null | undefined,
  playerColorIds: readonly number[] | undefined,
): (owner: number) => TeamColor {
  return (owner: number) => {
    if (owner <= 0) {
      return installation?.gaia ? fromInstallation(installation.gaia) : gaiaStandIn;
    }
    const color = installation?.players[ownerPlayerColorIndex(owner, playerColorIds)];
    return color
      ? fromInstallation(color)
      : teamColorFromRgb(ownerPreviewColor(owner, playerColorIds));
  };
}

export function teamColorKey(team: TeamColor): string {
  return [team.red, team.green, team.blue, team.pivot].map((value) => value.toFixed(4)).join(',');
}

export const teamColorGlsl = `
vec3 teamColored(vec3 rgb, float mask, vec3 team, float pivotColor) {
  vec3 color = rgb * ${teamColorBrightnessGain.toFixed(4)};
  float brightness = dot(color, vec3(0.299, 0.587, 0.114));
  float pivot = ${teamColorRampThroughWhite ? 'mix(pivotColor, 0.5, mask)' : 'pivotColor'};
  float contrast = ${teamColorRampThroughWhite ? 'mix(0.5, pivotColor, mask)' : '0.5'};
  if (brightness < pivot) {
    float along = pivot > 0.0 ? brightness / pivot : 0.0;
    return mix(color * 2.0 * contrast, team * along, mask);
  }
  float along = pivot < 1.0 ? (1.0 - brightness) / (1.0 - pivot) : 0.0;
  float scale = 2.0 * ((2.0 * brightness - 1.0) * (0.5 - contrast) + contrast);
  return mix(color * scale, along * (team - 1.0) + 1.0, mask);
}
`;
