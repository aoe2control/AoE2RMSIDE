"""@rmside/quality: the shipped quality check of rms-test.

Load it with:

    load("@rmside/quality", "quality_check")
    result = quality_check()

`quality_check` generates the map on its seeds, runs every selected case,
and returns the summary the report's quality block holds. Each case also
runs on its own over samples from `rms.generate`:

    load("@rmside/quality", "wood")
    result = wood(rms.generate(rms.source(), rms.seeds(1, 20)))

Thresholds are named "case/code" and hold "failure", "warning", or
"advice" limits (and a few named extras). A threshold given here replaces
the default's numbers one by one; a number set to None removes it.
Walking distances are an approximation with eight directions of movement.
"""

VERSION = "1.0.0"

DEFAULT_THRESHOLDS = {
    "generation/failed-generation": {"failure": 0},
    "generation/game-crash": {"failure": 0},
    "generation/player-without-start": {"failure": 0},
    "generation/uneven-placement": {"warning": 0},
    "generation/objects-not-placed": {"advice": 0},
    "generation/generation-warnings": {"warning": 0},
    "generation/gaia-buildings": {"advice": 0},
    "generation/placement-records-omitted": {"advice": 0},
    "start-resources/start-gold": {"warning": 0, "failure": 3},
    "start-resources/start-stone": {"warning": 0, "failure": 3},
    "start-resources/start-berries": {"warning": 0, "failure": 3},
    "start-resources/start-hunt": {"warning": 0, "failure": 3},
    "start-resources/start-herdables": {"warning": 0, "failure": 3},
    "start-resources/start-predators": {"warning": 1, "near-start": 12},
    "start-resources/owned-objects": {"warning": 0},
    "start-resources/missing-start-objects": {"failure": 0},
    "start-resources/resource-totals": {"warning": 15},
    "resource-distances/nearest-gold": {"warning": 4, "failure": 12},
    "resource-distances/nearest-stone": {"warning": 4, "failure": 12},
    "resource-distances/nearest-berries": {"warning": 4, "failure": 12},
    "resource-distances/nearest-hunt": {"warning": 4, "failure": 12},
    "resource-distances/front-back": {"advice": 1},
    "shared-resources/neutral-gold": {"warning": 100, "failure": 190},
    "shared-resources/neutral-stone": {"warning": 100, "failure": 190},
    "shared-resources/neutral-relics": {"warning": 100},
    "shared-resources/neutral-hunt": {"warning": 100, "failure": 190},
    "shared-resources/favoured-player": {"warning": 50, "minimum-seeds": 20},
    "shared-resources/contested-distance": {"warning": 10, "percent": 33},
    "wood/wood-near-start": {"warning": 25},
    "wood/missing-woodline": {"failure": 0},
    "trapped/own-object-trapped": {"failure": 0},
    "trapped/uneven-trapped": {"warning": 0, "failure": 2},
    "trapped/trapped-resources": {"warning": 0},
    "trapped/uneven-enclosed": {"failure": 0},
    "trapped/enclosed-own-objects": {"warning": 0},
    "trapped/fenced-animals": {"warning": 0},
    "paths/players-cut-off": {"failure": 0, "water-map": 90},
    "paths/rush-distance": {"warning": 10},
    "paths/ally-distance": {"warning": 10},
    "building-space/building-space": {"warning": 15, "failure": 40},
    "building-space/wall-length": {"warning": 30},
    "hills/front-hills": {"warning": 15},
    "water/no-shore": {"warning": 0},
    "water/shore-fish": {"warning": 1},
    "water/island-size": {"warning": 15},
    "water/island-resources": {"failure": 0},
    "water/exposed-resources": {"advice": 80},
    "spacing/resource-clash": {"warning": 0},
    "spacing/resource-at-start": {"warning": 0},
    "chokepoints/narrow-route": {"warning": 2, "single-route": 4},
    "chokepoints/minerals-cut-off": {"warning": 2},
    "variation/same-forests": {"advice": 90},
    "variation/same-starts": {"advice": 100},
    "variation/object-count-outliers": {"advice": 50},
    "looks/no-beaches": {"advice": 50},
    "looks/bare-area": {"advice": 20},
    "looks/one-terrain": {"advice": 85},
    "looks/round-shapes": {"advice": 2},
    "looks/uniform-clusters": {"advice": 5},
    "looks/edge-differs": {"advice": 30},
}

def _limits(thresholds):
    limits = {code: dict(values) for code, values in DEFAULT_THRESHOLDS.items()}
    if thresholds == None:
        return limits
    if type(thresholds) != "dict":
        fail("quality thresholds are a dictionary by \"case/code\"")
    for code, values in thresholds.items():
        if code not in limits:
            fail("unknown quality threshold \"%s\"" % code)
        if type(values) != "dict":
            fail("quality threshold \"%s\" is a dictionary of numbers" % code)
        for name, value in values.items():
            if value == None:
                limits[code].pop(name, None)
            else:
                limits[code][name] = value
    return limits

def _handles(samples):
    handles = []
    for sample in samples:
        if type(sample) == "struct":
            handles.append(sample._handle)
        else:
            handles.append(sample)
    return handles

def _case(case, samples, thresholds):
    return __rms_quality_case(case, _handles(samples), _limits(thresholds))

def generation(samples, thresholds = None):
    """Seeds that fail or would crash the game, players without a start, and create_object commands that place too little or unevenly."""
    return _case("generation", samples, thresholds)

def start_resources(samples, thresholds = None):
    """Gold, stone, food, predators, and own objects near each start, compared between players."""
    return _case("start-resources", samples, thresholds)

def resource_distances(samples, thresholds = None):
    """Walking distance from each start to its nearest resources, and which side they are on."""
    return _case("resource-distances", samples, thresholds)

def shared_resources(samples, thresholds = None):
    """How neutral gold, stone, relics, and hunt split between players, and who is nearest the centre."""
    return _case("shared-resources", samples, thresholds)

def wood(samples, thresholds = None):
    """Trees and large woodlines near each start."""
    return _case("wood", samples, thresholds)

def trapped(samples, thresholds = None):
    """Own objects and nearby resources that the player's villagers cannot reach, and animals own buildings close in."""
    return _case("trapped", samples, thresholds)

def paths(samples, thresholds = None):
    """Whether players can walk to each other, and walking distances to opponents and teammates."""
    return _case("paths", samples, thresholds)

def building_space(samples, thresholds = None):
    """Buildable land near each start and the tiles it takes to wall a base."""
    return _case("building-space", samples, thresholds)

def hills(samples, thresholds = None):
    """High ground near each start towards the nearest opponent."""
    return _case("hills", samples, thresholds)

def water(samples, thresholds = None):
    """Shores, shore fish, islands, and resources open to ships. Skipped on land maps."""
    return _case("water", samples, thresholds)

def spacing(samples, thresholds = None):
    """Resources placed right next to each other or to a Town Center."""
    return _case("spacing", samples, thresholds)

def chokepoints(samples, thresholds = None):
    """Narrow passages between opponents, and gold or stone one building could cut off."""
    return _case("chokepoints", samples, thresholds)

def variation(samples, thresholds = None):
    """Advice: how much forests, starts, and object counts change between seeds."""
    return _case("variation", samples, thresholds)

def looks(samples, thresholds = None):
    """Advice: beaches, bare areas, one-terrain land, round shapes, and uneven map edges."""
    return _case("looks", samples, thresholds)

CASES = {
    "generation": generation,
    "start-resources": start_resources,
    "resource-distances": resource_distances,
    "shared-resources": shared_resources,
    "wood": wood,
    "trapped": trapped,
    "paths": paths,
    "building-space": building_space,
    "hills": hills,
    "water": water,
    "spacing": spacing,
    "chokepoints": chokepoints,
    "variation": variation,
    "looks": looks,
}

def quality_check(target = None, seeds = None, settings = None, cases = None, thresholds = None):
    """Generates the map on its seeds and runs the selected cases (all of them by default).

    target: the map; the open map when None. seeds: a list of seeds; 1 to 20
    when None. settings: a value of rms.settings() or a list of them; the
    run's own when None. cases: case ids; "generation" always runs.
    Returns the result, its counts and items, the cases that passed, and
    a short text of at most 40 lines.
    """
    plan = __rms_quality_plan(target, seeds, settings, cases)
    groups = [
        __rms_generate(plan.target, setting.seeds, False, setting.settings, "record", None, plan.cases)
        for setting in plan.settings
    ]
    handles = [handle for group in groups for handle in group]
    limits = _limits(thresholds)
    results = [__rms_quality_case(case, handles, limits) for case in plan.cases]
    return __rms_quality_finish(groups, [result._id for result in results])
