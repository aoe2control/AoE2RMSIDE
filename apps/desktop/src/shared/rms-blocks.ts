export const rmsBlockCommandOperands: Readonly<Record<string, number>> = Object.freeze({
  create_player_lands: 0,
  create_land: 0,
  create_elevation: 1,
  create_terrain: 1,
  create_object: 1,
  create_object_group: 1,
  create_connect_all_players_land: 0,
  create_connect_teams_lands: 0,
  create_connect_same_land_zones: 0,
  create_connect_all_lands: 0,
  create_connect_to_nonplayer_land: 0,
  create_connect_land_zones: 2,
});

export function rmsBlockOperandCount(name: string): number | null {
  return Object.hasOwn(rmsBlockCommandOperands, name) ? rmsBlockCommandOperands[name]! : null;
}
