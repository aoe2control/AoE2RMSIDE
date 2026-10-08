import { randomUUID } from 'node:crypto';
import type {
  BehaviorProfileDescriptor,
  ContentPackDescriptor,
  DefinitionFileGameFolderNames,
  DefinitionFileGenerateRequest,
  DefinitionFileGenerateResult,
  DefinitionFilePlan,
  DefinitionFilePrepareRequest,
  LocalPresentationNames,
} from '../shared/api';
import {
  definitionFileKey,
  definitionFileNameProblem,
  definitionGroupCount,
  definitionGroupIds,
  definitionIdentifier,
  lobbyLabels,
  renderDefinitionFile,
  resolveDefinitionNames,
  suffixedDefinitionName,
  type DefinitionCandidate,
  type DefinitionCandidates,
  type DefinitionFileIdentities,
  type DefinitionGroupId,
  type DefinitionName,
  type ProjectDefinitionFile,
} from '../shared/definition-file';
import type { GeneratedFileTarget, GeneratedFileWriteResult } from './workspace-service';

interface ShippedConstantKinds {
  schemaVersion: string;
  profileId: string;
  derivationContract: string;
  entries: Array<{
    productVersion: string;
    provenance: { definitionsSha256: string };
    names: Array<{ name: string; kind: string }>;
  }>;
}

interface ShippedSupportBundle {
  schemaVersion: string;
  productVersion: string;
  behaviorProfileId: string;
  contentPack: { packId: string; packVersion: string; contentHash: string };
  implicitDefinitions: { count: number; fileSha256: string };
}

const shippedConstantKinds = Object.values(
  import.meta.glob<ShippedConstantKinds>('../../../../profiles/constant-kinds/*.json', {
    eager: true,
    import: 'default',
  }),
);
const shippedSupportBundles = Object.values(
  import.meta.glob<ShippedSupportBundle>(
    '../../../../crates/rms-content/data/aoe2de-*-support-bundle.json',
    { eager: true, import: 'default' },
  ),
);

export type ContentNameKind = 'object' | 'terrain';

export function shippedNameKinds(
  contentPack: Pick<
    ContentPackDescriptor,
    'packId' | 'packVersion' | 'contentHash' | 'productVersion'
  >,
  kindsDocuments: readonly ShippedConstantKinds[] = shippedConstantKinds,
  bundles: readonly ShippedSupportBundle[] = shippedSupportBundles,
): Map<string, ContentNameKind> | null {
  const bundle = bundles.find(
    (candidate) =>
      candidate.schemaVersion.startsWith('1.') &&
      candidate.contentPack.packId === contentPack.packId &&
      candidate.contentPack.packVersion === contentPack.packVersion &&
      candidate.contentPack.contentHash === contentPack.contentHash &&
      candidate.productVersion === contentPack.productVersion,
  );
  if (!bundle) return null;
  const document = kindsDocuments.find(
    (candidate) =>
      candidate.profileId === bundle.behaviorProfileId &&
      candidate.schemaVersion.startsWith('1.') &&
      candidate.derivationContract === 'aoe2de-definition-heading-kinds-v1',
  );
  const entry = document?.entries.find(
    (candidate) =>
      candidate.productVersion === bundle.productVersion &&
      candidate.provenance.definitionsSha256 === bundle.implicitDefinitions.fileSha256,
  );
  if (!entry) return null;
  const kinds = new Map<string, ContentNameKind>();
  for (const named of entry.names) {
    if (named.kind === 'object' || named.kind === 'terrain') kinds.set(named.name, named.kind);
  }
  return kinds;
}

export function localNameKinds(
  names: Pick<LocalPresentationNames, 'objects' | 'terrains'>,
): Map<string, { kind: ContentNameKind; id: number }> {
  const kinds = new Map<string, { kind: ContentNameKind; id: number }>();
  for (const [kind, entries] of [
    ['terrain', names.terrains],
    ['object', names.objects],
  ] as const) {
    for (const entry of entries) {
      for (const name of [entry.constant, ...entry.aliases]) {
        if (name && !kinds.has(name)) kinds.set(name, { kind, id: entry.id });
      }
    }
  }
  return kinds;
}

export interface CandidateInput {
  implicitDefinitions: Readonly<Record<string, string>>;
  objectIds: ReadonlySet<number>;
  kindOf(name: string, value: number): ContentNameKind | null;
  displayNames: {
    objects: ReadonlyMap<number, string>;
    terrains: ReadonlyMap<number, string>;
  } | null;
}

const maximumTerrainId = 255;

export function definitionCandidates(input: CandidateInput): DefinitionCandidates {
  const builtIn: Record<DefinitionGroupId, DefinitionName[]> = { terrains: [], objects: [] };
  for (const [name, text] of Object.entries(input.implicitDefinitions)) {
    if (!/^-?\d{1,10}$/u.test(text)) continue;
    const value = Number(text);
    const kind = input.kindOf(name, value);
    if (kind === 'object' && input.objectIds.has(value)) builtIn.objects.push({ id: value, name });
    else if (kind === 'terrain' && value >= 0 && value <= maximumTerrainId) {
      builtIn.terrains.push({ id: value, name });
    }
  }
  const byIdThenName = (left: DefinitionName, right: DefinitionName) =>
    left.id - right.id || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  builtIn.terrains.sort(byIdThenName);
  builtIn.objects.sort(byIdThenName);
  const gameFolder: Record<DefinitionGroupId, DefinitionCandidate[]> = {
    terrains: [],
    objects: [],
  };
  if (input.displayNames) {
    for (const group of definitionGroupIds) {
      const named = new Set(builtIn[group].map((entry) => entry.id));
      const texts = group === 'terrains' ? input.displayNames.terrains : input.displayNames.objects;
      for (const [id, text] of [...texts].sort(([left], [right]) => left - right)) {
        if (named.has(id)) continue;
        if (group === 'objects' ? !input.objectIds.has(id) : id < 0 || id > maximumTerrainId) {
          continue;
        }
        const base = definitionIdentifier(text, group);
        if (base) gameFolder[group].push({ id, base });
      }
    }
  }
  const reserved = new Set([...Object.keys(input.implicitDefinitions), ...lobbyLabels]);
  const reservedNames = new Set<string>();
  for (const group of definitionGroupIds) {
    for (const candidate of gameFolder[group]) {
      for (const name of [candidate.base, suffixedDefinitionName(candidate.base, candidate.id)]) {
        if (reserved.has(name)) reservedNames.add(name);
      }
    }
  }
  return { builtIn, gameFolder, reservedNames: [...reservedNames].sort() };
}

export function candidateNames(candidates: DefinitionCandidates): Set<string> {
  const names = new Set<string>();
  for (const group of definitionGroupIds) {
    for (const entry of candidates.builtIn[group]) names.add(entry.name);
    for (const candidate of candidates.gameFolder[group]) {
      names.add(candidate.base);
      names.add(suffixedDefinitionName(candidate.base, candidate.id));
    }
  }
  return names;
}

export interface DefinitionFileContent {
  profile: BehaviorProfileDescriptor;
  contentPack: ContentPackDescriptor;
  productVersion: string;
  local: boolean;
}

export interface DefinitionFileHost {
  selectedContent(): Promise<DefinitionFileContent | null>;
  localNames(): Promise<LocalPresentationNames | null>;
  reservedFileNames(): string[];
  target(folderId: string | null): Promise<GeneratedFileTarget | null>;
  projectDefinitions(
    relevant: (name: string) => boolean,
  ): Promise<{ files: ProjectDefinitionFile[]; complete: boolean }>;
  writeInFolder(
    folderId: string,
    name: string,
    text: string,
    overwrite: boolean,
  ): Promise<GeneratedFileWriteResult>;
  chooseSavePath(suggestedName: string): Promise<string | null>;
  writeAs(path: string, text: string): Promise<string>;
}

interface StoredPlan {
  plan: DefinitionFilePlan;
  folderId: string | null;
}

const emptyCandidates = (): DefinitionCandidates => ({
  builtIn: { terrains: [], objects: [] },
  gameFolder: { terrains: [], objects: [] },
  reservedNames: [],
});

export class DefinitionFileService {
  private stored: StoredPlan | null = null;

  constructor(private readonly host: DefinitionFileHost) {}

  async prepare(request: DefinitionFilePrepareRequest): Promise<DefinitionFilePlan> {
    const { folderId } = validateDefinitionFilePrepareRequest(request);
    const target = await this.host.target(folderId);
    const content = await this.host.selectedContent();
    const reservedFileNames = this.host.reservedFileNames();
    const planTarget: DefinitionFilePlan['target'] = target
      ? { kind: 'folder', name: target.name, relativePath: target.relativePath }
      : { kind: 'save-dialog' };
    const unavailable = (
      identities: DefinitionFileIdentities | null,
      gameFolderNames: DefinitionFileGameFolderNames,
    ): DefinitionFilePlan => ({
      planId: randomUUID(),
      status: 'unavailable',
      identities,
      candidates: emptyCandidates(),
      project: [],
      projectComplete: true,
      gameFolderNames,
      target: planTarget,
      reservedFileNames,
    });
    if (!content) return this.store(unavailable(null, 'no-game-folder'), null);
    const { contentPack, profile } = content;
    const identities: DefinitionFileIdentities = {
      gameVersion: content.productVersion,
      gameVersionVerified:
        !content.local && profile.productVersions.includes(content.productVersion),
    };
    const localNames = await this.host.localNames().catch(() => null);
    const sameVersion =
      localNames !== null &&
      localNames.productVersion !== null &&
      content.productVersion !== '' &&
      localNames.productVersion === content.productVersion;
    const gameFolderNames: DefinitionFileGameFolderNames = !localNames
      ? 'no-game-folder'
      : !sameVersion
        ? 'other-version'
        : localNames.displayStrings !== 'available'
          ? 'no-text'
          : 'used';
    if (
      contentPack.synthetic ||
      (!contentPack.packagedBundle && !content.local) ||
      !/^\d{1,10}(?:\.\d{1,10}){1,3}$/u.test(content.productVersion)
    ) {
      return this.store(unavailable(identities, gameFolderNames), folderId);
    }
    const objectIds = new Set(contentPack.objectNames.map((entry) => entry.objectId));
    let kindOf: CandidateInput['kindOf'];
    if (content.local) {
      const kinds = sameVersion ? localNameKinds(localNames) : new Map();
      kindOf = (name, value) => {
        const known = kinds.get(name);
        return known && known.id === value ? known.kind : null;
      };
    } else {
      const kinds = shippedNameKinds(contentPack);
      kindOf = (name) => kinds?.get(name) ?? null;
    }
    const displayNames =
      gameFolderNames === 'used' && localNames
        ? {
            objects: displayNameMap(localNames.objects),
            terrains: displayNameMap(localNames.terrains),
          }
        : null;
    const candidates = definitionCandidates({
      implicitDefinitions: contentPack.implicitDefinitions,
      objectIds,
      kindOf,
      displayNames,
    });
    const relevant = candidateNames(candidates);
    const project = target
      ? await this.host.projectDefinitions((name) => relevant.has(name))
      : { files: [], complete: true };
    return this.store(
      {
        planId: randomUUID(),
        status: 'ready',
        identities,
        candidates,
        project: project.files,
        projectComplete: project.complete,
        gameFolderNames,
        target: planTarget,
        reservedFileNames,
      },
      target?.folderId ?? null,
    );
  }

  async generate(request: DefinitionFileGenerateRequest): Promise<DefinitionFileGenerateResult> {
    const validated = validateDefinitionFileGenerateRequest(request);
    const stored = this.stored;
    if (!stored || stored.plan.planId !== validated.planId) {
      throw new Error('the definition file plan is stale; open the dialog again');
    }
    const { plan, folderId } = stored;
    if (plan.status !== 'ready' || !plan.identities) {
      throw new Error('no definition file is available for the selected game version');
    }
    const reserved = new Set(this.host.reservedFileNames());
    const problem = definitionFileNameProblem(validated.fileName, reserved);
    if (problem) throw new Error(`the definition file name is ${problem}`);
    const excludedFile =
      plan.target.kind === 'folder'
        ? definitionFileKey(
            plan.target.relativePath
              ? `${plan.target.relativePath}/${validated.fileName}`
              : validated.fileName,
          )
        : null;
    const resolved = resolveDefinitionNames(plan.candidates, plan.project, excludedFile);
    for (const group of validated.groups) {
      if (definitionGroupCount(resolved, group, validated.includeBuiltIn) === 0) {
        throw new Error(`the ${group} group has no names to write`);
      }
    }
    const text = renderDefinitionFile(plan.identities, resolved, validated);
    if (plan.target.kind === 'save-dialog' || folderId === null) {
      const path = await this.host.chooseSavePath(validated.fileName);
      if (!path) return { status: 'cancelled' };
      return { status: 'written', path: await this.host.writeAs(path, text) };
    }
    const written = await this.host.writeInFolder(
      folderId,
      validated.fileName,
      text,
      validated.overwrite,
    );
    return written;
  }

  private store(plan: DefinitionFilePlan, folderId: string | null): DefinitionFilePlan {
    this.stored = { plan, folderId };
    return plan;
  }
}

function displayNameMap(entries: LocalPresentationNames['objects']): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  for (const entry of entries) if (entry.displayName) names.set(entry.id, entry.displayName);
  return names;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function validateDefinitionFilePrepareRequest(value: unknown): DefinitionFilePrepareRequest {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => key !== 'folderId')) {
    throw new Error('definition file request is invalid');
  }
  const folderId = value.folderId;
  if (
    folderId !== null &&
    (typeof folderId !== 'string' || folderId.length < 1 || folderId.length > 256)
  ) {
    throw new Error('definition file folder is invalid');
  }
  return { folderId };
}

export function validateDefinitionFileGenerateRequest(
  value: unknown,
): DefinitionFileGenerateRequest {
  const keys = ['planId', 'fileName', 'groups', 'includeBuiltIn', 'overwrite'];
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('definition file request is invalid');
  }
  const { planId, fileName, groups, includeBuiltIn, overwrite } = value;
  if (typeof planId !== 'string' || planId.length < 1 || planId.length > 64) {
    throw new Error('definition file plan is invalid');
  }
  if (typeof fileName !== 'string' || fileName.length < 1 || fileName.length > 255) {
    throw new Error('definition file name is invalid');
  }
  if (
    !Array.isArray(groups) ||
    groups.length < 1 ||
    groups.length > definitionGroupIds.length ||
    groups.some((group) => !definitionGroupIds.includes(group as DefinitionGroupId)) ||
    new Set(groups).size !== groups.length
  ) {
    throw new Error('definition file groups are invalid');
  }
  if (typeof includeBuiltIn !== 'boolean' || typeof overwrite !== 'boolean') {
    throw new Error('definition file options are invalid');
  }
  return {
    planId,
    fileName,
    groups: definitionGroupIds.filter((group) => groups.includes(group)),
    includeBuiltIn,
    overwrite,
  };
}
