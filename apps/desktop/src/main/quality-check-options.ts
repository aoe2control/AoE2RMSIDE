import { create } from '@bufbuild/protobuf';
import {
  PlayerConfigurationSchema,
  QualityCheckOptionsSchema,
  QualityDetail,
  QualitySettingsSchema,
  type QualityCheckOptions,
} from '../generated/rmside/v1/rmside_pb';
import type { AppQualityRun } from '../shared/connector-run-api';

export function qualityCheckOptions(run: AppQualityRun): QualityCheckOptions {
  return create(QualityCheckOptionsSchema, {
    caseIds: [...run.caseIds],
    seedStart: run.seedStart,
    seedCount: run.seedCount,
    settings: run.settings.map((setting) =>
      create(QualitySettingsSchema, {
        mapSize: setting.mapSize,
        width: setting.width,
        height: setting.height,
        players: setting.players.map((player) =>
          create(PlayerConfigurationSchema, {
            slot: player.slot,
            team: player.team,
            civilizationId: player.civilizationId,
            color: player.color,
          }),
        ),
        seedCount: setting.seedCount,
      }),
    ),
    detail: QualityDetail.UNSPECIFIED,
  });
}
