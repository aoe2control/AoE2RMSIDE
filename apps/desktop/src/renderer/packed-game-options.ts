import type { MessageId } from '../shared/i18n/translator';
import { wordOutputText, type OutputText } from '../shared/output-message';
import { packagedCivilizationCount } from '../shared/packaged-game-versions';

export interface PackedCivilizationOption {
  id: number;
  label: string;
}

const randomCivilizationId = 0;

const civilizationNames: ReadonlyMap<number, MessageId> = new Map<number, MessageId>([
  [1, 'game-options.civilization.britons'],
  [2, 'game-options.civilization.franks'],
  [3, 'game-options.civilization.goths'],
  [4, 'game-options.civilization.teutons'],
  [5, 'game-options.civilization.japanese'],
  [6, 'game-options.civilization.chinese'],
  [7, 'game-options.civilization.byzantines'],
  [8, 'game-options.civilization.persians'],
  [9, 'game-options.civilization.saracens'],
  [10, 'game-options.civilization.turks'],
  [11, 'game-options.civilization.vikings'],
  [12, 'game-options.civilization.mongols'],
  [13, 'game-options.civilization.celts'],
  [14, 'game-options.civilization.spanish'],
  [15, 'game-options.civilization.aztecs'],
  [16, 'game-options.civilization.mayans'],
  [17, 'game-options.civilization.huns'],
  [18, 'game-options.civilization.koreans'],
  [19, 'game-options.civilization.italians'],
  [20, 'game-options.civilization.hindustanis'],
  [21, 'game-options.civilization.incas'],
  [22, 'game-options.civilization.magyars'],
  [23, 'game-options.civilization.slavs'],
  [24, 'game-options.civilization.portuguese'],
  [25, 'game-options.civilization.ethiopians'],
  [26, 'game-options.civilization.malians'],
  [27, 'game-options.civilization.berbers'],
  [28, 'game-options.civilization.khmer'],
  [29, 'game-options.civilization.malay'],
  [30, 'game-options.civilization.burmese'],
  [31, 'game-options.civilization.vietnamese'],
  [32, 'game-options.civilization.bulgarians'],
  [33, 'game-options.civilization.tatars'],
  [34, 'game-options.civilization.cumans'],
  [35, 'game-options.civilization.lithuanians'],
  [36, 'game-options.civilization.burgundians'],
  [37, 'game-options.civilization.sicilians'],
  [38, 'game-options.civilization.poles'],
  [39, 'game-options.civilization.bohemians'],
  [40, 'game-options.civilization.dravidians'],
  [41, 'game-options.civilization.bengalis'],
  [42, 'game-options.civilization.gurjaras'],
  [43, 'game-options.civilization.romans'],
  [44, 'game-options.civilization.armenians'],
  [45, 'game-options.civilization.georgians'],
  [46, 'game-options.civilization.achaemenids'],
  [47, 'game-options.civilization.athenians'],
  [48, 'game-options.civilization.spartans'],
  [49, 'game-options.civilization.shu'],
  [50, 'game-options.civilization.wu'],
  [51, 'game-options.civilization.wei'],
  [52, 'game-options.civilization.jurchens'],
  [53, 'game-options.civilization.khitans'],
  [54, 'game-options.civilization.macedonians'],
  [55, 'game-options.civilization.thracians'],
  [56, 'game-options.civilization.puru'],
  [57, 'game-options.civilization.muisca'],
  [58, 'game-options.civilization.mapuche'],
  [59, 'game-options.civilization.tupi'],
  [60, 'game-options.civilization.saxons'],
  [61, 'game-options.civilization.varangians'],
  [62, 'game-options.civilization.danes'],
]);

export function civilizationName(id: number): OutputText {
  if (id === randomCivilizationId) return { id: 'game-options.civilization.random' };
  const name = civilizationNames.get(id);
  return name ? { id: name } : { id: 'game-options.civilization.unknown', args: { id } };
}

function civilizationOption(id: number): PackedCivilizationOption {
  return {
    id,
    get label() {
      return wordOutputText(civilizationName(id));
    },
  };
}

export function packedCivilizationOptions(
  profileId: string | null,
  productVersion: string | null = null,
): readonly PackedCivilizationOption[] {
  const count = packagedCivilizationCount(profileId, productVersion);
  const random = civilizationOption(randomCivilizationId);
  if (count === undefined) return [random];
  return [
    random,
    ...[...civilizationNames.keys()].filter((id) => id < count).map(civilizationOption),
  ];
}

export function availableCivilizationIds(
  civilizationIds: readonly number[],
  options: readonly PackedCivilizationOption[],
): number[] {
  if (options.length <= 1) return [...civilizationIds];
  const available = new Set(options.map((option) => option.id));
  return civilizationIds.map((id) => (available.has(id) ? id : 0));
}
