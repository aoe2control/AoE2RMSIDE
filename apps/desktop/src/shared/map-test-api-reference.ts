export interface MapTestSignatureDefinition {
  parameters: readonly string[];
  documentation?: string;
}

export const mapTestQualityModule = '@rmside/quality';

export const mapTestHostDocumentation: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'rms',
    'The map-test namespace: the map to test, seeds, lobby settings, generation, and game constant IDs.',
  ],
  [
    'source',
    'rms.source(path = None) returns the map pinned in the Run options, or the .rms/.rms2 map at path in the open folder.',
  ],
  [
    'id',
    'rms.id(name) returns the ID of a game constant, such as "GOLD" or "DEEP_WATER", in the selected game version. ID filters (object_ids, terrain_ids, cliff_types) also accept these names.',
  ],
  [
    'seeds',
    'rms.seeds(start, count = 1, step = 1) returns a checked uint32 seed sequence without wrapping.',
  ],
  [
    'generate',
    'rms.generate(target, seeds, preview = True, settings = None, failures = "stop", analyse = None) yields immutable samples in seed order. While the test runs, the preview shows the latest finished map, at most twice a second; afterwards it keeps the last map the script generated with preview on. preview = False leaves the preview as it is. settings takes a value of rms.settings() or a list of up to 16; every setting uses the same seeds, setting by setting. Settings other than the run\'s own work in a map test that loads "@rmside/quality". failures = "record" keeps a seed whose map fails as a sample with failure set instead of stopping the test. analyse = ["walk", "fields:starts"] prepares walking data while the maps generate; results stay the same.',
  ],
  [
    'settings',
    'rms.settings(map_size = None, players = None, teams = None) describes a lobby setting: struct(map_size, width, height, players), each player struct(slot, team, civilization_id, color). map_size is tiny, small, medium, normal, large, huge, or ludicrous; players is 1 to 8; teams is a list of team numbers from 0 to 4, one per player, or a layout such as "2v2" or "ffa". What you leave out stays as in the run. sample.settings is the setting a sample used.',
  ],
  [
    'xs',
    "rms.xs(path, seed = 0) opens an .xs file of the open folder; .call(name, *args) runs one of its functions with the game's Constants.xs and returns the result. seed sets the XS random numbers.",
  ],
  [
    'xs_start',
    "sample.xs_start() runs the XS start check on the sample's map, as the preview does, and returns its status, findings, chat lines, changes per player, and the call it stopped at. It needs the game's Constants.xs.",
  ],
  [
    'expect',
    'sample.expect(condition, message, values = None, code = None) records a finding when condition is false and continues.',
  ],
  [
    'report',
    'sample.report(message, values = None, code = None) records an unconditional reproducible finding.',
  ],
  [
    'players',
    'sample.players lists the players by slot: struct(slot, team, start, start_x, start_y, land_zone, land_zone_shared, town_center). start is "land", "town_center", or "none"; start_x and start_y are the start tile, None without a start; land_zone_shared is True when another player\'s land has the same zone; town_center is the player\'s first Town Center object, or None. A player is a place for the walking queries.',
  ],
  [
    'placements',
    'sample.placements(short_only = True) lists the create_object commands in command order: struct(line, column, object_id, player, groups_requested, groups_placed, objects_created). line and column are in the tested map, None in an included file. By default it lists only the commands that placed fewer groups than they asked for.',
  ],
  [
    'failure',
    'sample.failure is None when the map generated. With rms.generate(..., failures = "record"), a seed whose map failed keeps struct(code, message, crash_id) here and has no map, hashes, metrics, or players.',
  ],
  [
    'settings_index',
    "sample.settings_index is None for the run's own settings; otherwise it numbers the other lobby setting the sample used, from 0, in the order the test first sampled them.",
  ],
  [
    'walk_distance',
    "map.walk_distance(x1, y1, x2, y2, open_for = None) is the walking distance between two tiles in whole tiles, or None when no walking route joins them. Walking moves in eight directions around trees, cliffs, rocks, mines, buildings, walls, and gates; it approximates the game's paths. open_for = slot lets that player walk through their own buildings, walls, and gates.",
  ],
  [
    'distance_field',
    'map.distance_field(sources, open_for = None, max_distance = None) measures the walking distance from one or more places to every tile at once. Read it with at(x, y), to(place), reachable(place), nearest(object_ids, owner = None, count = 2, max_distance = None), and count_tiles(max_distance, ...). A place is a tile (x, y), an object, a player of sample.players, or a list of up to 64 of them.',
  ],
  [
    'narrowest_passage',
    'map.narrowest_passage(a, b = None, ring = None, open_for = None, limit = 16) finds the fewest walkable tiles whose blocking would separate place a from place b, or from every tile ring tiles away from a. It returns struct(width, capped, routes, passages): width 0 means not connected; capped is True when the width reached limit (1 to 64); routes counts the separate passages; passages lists up to 8 of them, narrowest first, as struct(width, x, y).',
  ],
  ['walk_hash', "map.walk_hash() is a fingerprint (SHA-256) of the map's walking data."],
]);

const tileFilters = [
  'terrain_ids = None',
  'land_zone_ids = None',
  'terrain_zone_ids = None',
  'layer_ids = None',
  'walkable = None',
  'buildable = None',
];
const coordinates = ['x1', 'y1', 'x2', 'y2'];

export const mapTestRmsSignatures: ReadonlyMap<string, MapTestSignatureDefinition> = new Map<
  string,
  MapTestSignatureDefinition
>([
  [
    'source',
    {
      parameters: ['path = None'],
      documentation: 'Selects the default/pinned or explicit authorized RMS source.',
    },
  ],
  [
    'seeds',
    {
      parameters: ['start', 'count = 1', 'step = 1'],
      documentation: 'Creates a checked deterministic uint32 sequence.',
    },
  ],
  [
    'generate',
    {
      parameters: [
        'target',
        'seeds',
        'preview = True',
        'settings = None',
        'failures = "stop"',
        'analyse = None',
      ],
      documentation: 'Generates immutable samples, setting by setting, in seed order.',
    },
  ],
  [
    'settings',
    {
      parameters: ['map_size = None', 'players = None', 'teams = None'],
      documentation: "Describes a lobby setting; what you leave out stays as in the run's own.",
    },
  ],
  [
    'id',
    {
      parameters: ['name'],
      documentation: 'Returns the ID of a game constant in the selected game version.',
    },
  ],
  [
    'xs',
    {
      parameters: ['path', 'seed = 0'],
      documentation:
        'Opens an .xs file of the open folder whose functions .call(name, *args) runs.',
    },
  ],
]);

export const mapTestSampleValues: ReadonlyMap<string, string> = new Map<string, string>([
  ['seed', 'The seed of this map.'],
  ['map', 'The generated map; None when the map failed (see failure).'],
  ['request_hash', 'A fingerprint of the generation request.'],
  ['map_hash', 'A fingerprint of the generated map.'],
  ['warnings', 'The warnings of generating this map, each with code and message.'],
  ['metrics', 'Counts for this map, such as tile_count and object_count.'],
  ['players', 'The players by slot, with their team, start, land zone, and Town Center.'],
  ['failure', 'None, or struct(code, message, crash_id) for a failed map that was recorded.'],
  ['settings', 'The lobby setting this sample used, as rms.settings() returns it.'],
  ['settings_index', "None for the run's own settings, else the other setting's number."],
]);

export const mapTestSampleSignatures: ReadonlyMap<string, MapTestSignatureDefinition> = new Map<
  string,
  MapTestSignatureDefinition
>([
  [
    'expect',
    {
      parameters: ['condition', 'message', 'values = None', 'code = None'],
      documentation: 'Records a failed assertion and continues.',
    },
  ],
  [
    'report',
    {
      parameters: ['message', 'values = None', 'code = None'],
      documentation: 'Records an unconditional finding.',
    },
  ],
  [
    'xs_start',
    {
      parameters: [],
      documentation: "Runs the XS start check on this sample's map and returns its result.",
    },
  ],
  [
    'placements',
    {
      parameters: ['short_only = True'],
      documentation:
        'Lists the create_object commands, by default those that placed too few groups.',
    },
  ],
]);

export const mapTestMapValues: ReadonlyMap<string, string> = new Map<string, string>([
  ['width', 'The map width in tiles.'],
  ['height', 'The map height in tiles.'],
  ['hash', 'A fingerprint of the generated map.'],
]);

export const mapTestMapSignatures: ReadonlyMap<string, MapTestSignatureDefinition> = new Map<
  string,
  MapTestSignatureDefinition
>([
  ['tile', { parameters: ['x', 'y'] }],
  ['tiles', { parameters: tileFilters }],
  ['count_tiles', { parameters: tileFilters }],
  ['objects', { parameters: ['object_ids = None', 'owner = None'] }],
  ['walls', { parameters: ['object_ids = None', 'owner = None'] }],
  ['cliffs', { parameters: ['cliff_types = None'] }],
  ['connections', { parameters: ['kinds = None'] }],
  ['neighbors', { parameters: ['x', 'y', 'diagonal = False'] }],
  ['manhattan_distance', { parameters: coordinates }],
  ['chebyshev_distance', { parameters: coordinates }],
  ['squared_distance', { parameters: coordinates }],
  ['boundaries', { parameters: tileFilters }],
  ['components', { parameters: tileFilters }],
  ['connected', { parameters: [...coordinates, ...tileFilters] }],
  [
    'walk_distance',
    {
      parameters: [...coordinates, 'open_for = None'],
      documentation: 'Walking distance between two tiles in whole tiles, or None.',
    },
  ],
  [
    'distance_field',
    {
      parameters: ['sources', 'open_for = None', 'max_distance = None'],
      documentation: 'Walking distances from places to every tile, read with its methods.',
    },
  ],
  [
    'narrowest_passage',
    {
      parameters: ['a', 'b = None', 'ring = None', 'open_for = None', 'limit = 16'],
      documentation: 'The fewest walkable tiles whose blocking separates the places.',
    },
  ],
  [
    'walk_hash',
    {
      parameters: [],
      documentation: "A fingerprint (SHA-256) of the map's walking data.",
    },
  ],
]);

export const mapTestFieldSignatures: ReadonlyMap<string, MapTestSignatureDefinition> = new Map<
  string,
  MapTestSignatureDefinition
>([
  [
    'at',
    {
      parameters: ['x', 'y'],
      documentation: 'The walking distance to a tile in whole tiles, or None.',
    },
  ],
  [
    'to',
    {
      parameters: ['place'],
      documentation: 'The walking distance to the nearest tile of a place, or None.',
    },
  ],
  [
    'reachable',
    {
      parameters: ['place'],
      documentation: 'True when walking reaches the place.',
    },
  ],
  [
    'nearest',
    {
      parameters: ['object_ids', 'owner = None', 'count = 2', 'max_distance = None'],
      documentation:
        'The nearest objects by walking, nearest first, as struct(object, distance); count is 1 to 64.',
    },
  ],
  [
    'count_tiles',
    {
      parameters: ['max_distance', ...tileFilters],
      documentation: 'Counts the tiles within max_distance walking tiles that match the filters.',
    },
  ],
]);

const caseParameters = ['samples', 'thresholds = None'];

export const mapTestQualityCases: readonly { name: string; id: string; summary: string }[] = [
  {
    name: 'generation',
    id: 'generation',
    summary:
      'Seeds that fail or would crash the game, players without a start, and create_object commands that place too little or unevenly.',
  },
  {
    name: 'start_resources',
    id: 'start-resources',
    summary:
      'Gold, stone, food, predators, and own objects near each start, compared between players.',
  },
  {
    name: 'resource_distances',
    id: 'resource-distances',
    summary:
      'Walking distance from each start to its nearest resources, and which side they are on.',
  },
  {
    name: 'shared_resources',
    id: 'shared-resources',
    summary:
      'How neutral gold, stone, relics, and hunt split between players, and who is nearest the centre.',
  },
  { name: 'wood', id: 'wood', summary: 'Trees and large woodlines near each start.' },
  {
    name: 'trapped',
    id: 'trapped',
    summary:
      "Own objects and nearby resources that the player's villagers cannot reach, and animals own buildings close in.",
  },
  {
    name: 'paths',
    id: 'paths',
    summary:
      'Whether players can walk to each other, and walking distances to opponents and teammates.',
  },
  {
    name: 'building_space',
    id: 'building-space',
    summary: 'Buildable land near each start and the tiles it takes to wall a base.',
  },
  {
    name: 'hills',
    id: 'hills',
    summary: 'High ground near each start towards the nearest opponent.',
  },
  {
    name: 'water',
    id: 'water',
    summary: 'Shores, shore fish, islands, and resources open to ships. Skipped on land maps.',
  },
  {
    name: 'spacing',
    id: 'spacing',
    summary: 'Resources placed right next to each other or to a Town Center.',
  },
  {
    name: 'chokepoints',
    id: 'chokepoints',
    summary: 'Narrow passages between opponents, and gold or stone one building could cut off.',
  },
  {
    name: 'variation',
    id: 'variation',
    summary: 'Advice: how much forests, starts, and object counts change between seeds.',
  },
  {
    name: 'looks',
    id: 'looks',
    summary: 'Advice: beaches, bare areas, one-terrain land, round shapes, and uneven map edges.',
  },
];

export const mapTestQualitySignatures: ReadonlyMap<string, MapTestSignatureDefinition> = new Map<
  string,
  MapTestSignatureDefinition
>([
  [
    'quality_check',
    {
      parameters: [
        'target = None',
        'seeds = None',
        'settings = None',
        'cases = None',
        'thresholds = None',
      ],
      documentation: 'Generates the map on its seeds and runs the selected quality cases.',
    },
  ],
  ...mapTestQualityCases.map(
    ({ name, id, summary }) =>
      [name, { parameters: caseParameters, documentation: `Case ${id}: ${summary}` }] as const,
  ),
]);

export const mapTestQualityValues: ReadonlyMap<string, string> = new Map<string, string>([
  ['CASES', 'A dictionary from each case id, such as "building-space", to its function.'],
  [
    'DEFAULT_THRESHOLDS',
    'The default limits as a dictionary by "case/code", each a dictionary of "failure", "warning", "advice", and a few named extras.',
  ],
  ['VERSION', 'The text that names this release of the library; a report records it.'],
]);

export const mapTestQualityDocumentation: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'quality_check',
    'quality_check(target = None, seeds = None, settings = None, cases = None, thresholds = None) generates the map (rms.source() when target is None) on its seeds (1 to 20 when None) under each setting (the run\'s own when None), records the seeds that fail, runs the selected cases (all when None; "generation" always runs), and returns struct(result, counts, items, passed, skipped, omitted_items, samples, failed_samples, text). result is "passed", "warnings", or "failed"; each item has case, code, level, message, bad (samples at that level), of (samples measured), metric (label, unit, p5, p50, p95, max), and up to three worst samples with seed, settings_index, value, players, and tile. text is a summary of at most 40 lines. It runs once per map test.',
  ],
  ...mapTestQualityCases.map(
    ({ name, id, summary }) =>
      [
        name,
        `${name}(samples, thresholds = None) runs the quality case "${id}" over samples from rms.generate and returns struct(case, skipped, items). ${summary}`,
      ] as const,
  ),
  [
    'CASES',
    'CASES maps each quality case id, such as "building-space", to its function, in the check\'s order.',
  ],
  [
    'DEFAULT_THRESHOLDS',
    'DEFAULT_THRESHOLDS holds the default limits by "case/code", for example "wood/wood-near-start": {"warning": 15}. Pass thresholds = {"case/code": {"warning": n}} to change a number; None removes one. A level above the case\'s highest, an unknown code, or an unknown name is refused.',
  ],
  ['VERSION', 'VERSION is the text that names this release of the library; a report records it.'],
]);

export interface MapTestApiEntry {
  name: string;
  signature: string;
  text: string;
}

export type MapTestReceiver = 'rms' | 'sample' | 'map' | 'field' | 'quality';

const receivers: readonly {
  receiver: MapTestReceiver;
  values?: ReadonlyMap<string, string>;
  signatures: ReadonlyMap<string, MapTestSignatureDefinition>;
  role: string;
  valueRole?: string;
  hover: ReadonlyMap<string, string>;
  written: (name: string) => string;
}[] = [
  {
    receiver: 'rms',
    signatures: mapTestRmsSignatures,
    role: 'A function of the map-test namespace rms.',
    hover: mapTestHostDocumentation,
    written: (name) => `rms.${name}`,
  },
  {
    receiver: 'sample',
    values: mapTestSampleValues,
    signatures: mapTestSampleSignatures,
    role: 'A method of a sample that rms.generate yields.',
    valueRole: 'A value of a sample that rms.generate yields.',
    hover: mapTestHostDocumentation,
    written: (name) => `sample.${name}`,
  },
  {
    receiver: 'map',
    values: mapTestMapValues,
    signatures: mapTestMapSignatures,
    role: "A method of a sample's map (sample.map).",
    valueRole: "A value of a sample's map (sample.map).",
    hover: mapTestHostDocumentation,
    written: (name) => `map.${name}`,
  },
  {
    receiver: 'field',
    signatures: mapTestFieldSignatures,
    role: 'A method of a distance field that map.distance_field returns.',
    hover: new Map(),
    written: (name) => `field.${name}`,
  },
  {
    receiver: 'quality',
    values: mapTestQualityValues,
    signatures: mapTestQualitySignatures,
    role: `A function of the quality library, load("${mapTestQualityModule}", ...).`,
    valueRole: `A value of the quality library, load("${mapTestQualityModule}", ...).`,
    hover: mapTestQualityDocumentation,
    written: (name) => name,
  },
];

export interface MapTestMember {
  label: string;
  method: boolean;
  documentation?: string;
}

export function mapTestMembers(receiver: MapTestReceiver): MapTestMember[] {
  const entry = receivers.find((candidate) => candidate.receiver === receiver)!;
  const documentation = (label: string, summary: string | undefined) =>
    entry.hover.get(label) ?? summary;
  return [
    ...[...(entry.values ?? new Map<string, string>())].map(([label, summary]) => ({
      label,
      method: false,
      documentation: documentation(label, summary),
    })),
    ...[...entry.signatures].map(([label, definition]) => ({
      label,
      method: true,
      documentation: documentation(label, definition.documentation),
    })),
  ];
}

export function mapTestApiEntries(): MapTestApiEntry[] {
  const entries: MapTestApiEntry[] = [
    { name: 'rms', signature: 'rms', text: mapTestHostDocumentation.get('rms')! },
  ];
  for (const { receiver, values, signatures, role, valueRole, hover, written } of receivers) {
    for (const [value, summary] of values ?? []) {
      entries.push({
        name: `${receiver}.${value}`,
        signature: written(value),
        text: `${valueRole ?? role} ${hover.get(value) ?? summary}`,
      });
    }
    for (const [method, definition] of signatures) {
      const signature = `${written(method)}(${definition.parameters.join(', ')})`;
      const detail = hover.get(method) ?? definition.documentation;
      const text = detail === undefined ? role : `${role} ${detail}`;
      entries.push({ name: `${receiver}.${method}`, signature, text });
    }
  }
  return entries;
}

export function mapTestApiEntry(name: string): MapTestApiEntry | undefined {
  const entries = mapTestApiEntries();
  const qualified = entries.find((entry) => entry.name === name);
  if (qualified) return qualified;
  const bare = entries.filter((entry) => entry.name.split('.').at(-1) === name);
  return bare.length === 1 ? bare[0] : undefined;
}
