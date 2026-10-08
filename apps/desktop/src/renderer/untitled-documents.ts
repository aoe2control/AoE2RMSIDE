import { editionCapabilities, type EditionCapabilities } from '../shared/edition';
import { mapTestStarterTemplate } from '../shared/map-test-contract';
import { rmsStarterTemplateFor } from '../shared/rms-starter';
import { xsStarterTemplate } from '../shared/xs-contract';
import type { EditorDocument } from './workspace-controller';

const emptyDiskHash = '0'.repeat(64);

export type UntitledRmsOrigin = 'automatic' | 'explicit';

export function createUntitledRmsDocument(
  index: number,
  origin: UntitledRmsOrigin,
  capabilities: Pick<EditionCapabilities, 'newRmsScript' | 'documentation'> = editionCapabilities,
): EditorDocument {
  const starter = capabilities.newRmsScript ? rmsStarterTemplateFor(capabilities) : '';
  const explicit = origin === 'explicit' && starter !== '';
  return {
    id: `untitled:${index}`,
    uri: `untitled://rms/Untitled-${index}.rms`,
    path: null,
    name: `Untitled-${index}.rms`,
    content: starter,
    savedContent: explicit ? '' : starter,
    encoding: 'utf8',
    newlineStyle: 'crlf',
    sourceKind: 'ordinary',
    readOnly: false,
    diskHash: emptyDiskHash,
    dirty: explicit,
    preview: !explicit,
    editedThisOpenLifetime: false,
    viewState: null,
  };
}

export function createUntitledXsDocument(index: number): EditorDocument {
  return {
    id: `untitled:xs:${index}`,
    uri: `untitled://xs/Untitled-${index}.xs`,
    path: null,
    name: `Untitled-${index}.xs`,
    content: xsStarterTemplate,
    savedContent: '',
    encoding: 'utf8',
    newlineStyle: 'crlf',
    sourceKind: 'ordinary',
    readOnly: false,
    diskHash: emptyDiskHash,
    dirty: true,
    preview: false,
    editedThisOpenLifetime: false,
    viewState: null,
  };
}

export function createUntitledMapTestDocument(index: number): EditorDocument {
  return {
    id: `untitled:map-test:${index}`,
    uri: `untitled://starlark/Untitled-${index}.rmstest`,
    path: null,
    name: `Untitled-${index}.rmstest`,
    content: mapTestStarterTemplate,
    savedContent: '',
    encoding: 'utf8',
    newlineStyle: 'crlf',
    sourceKind: 'ordinary',
    readOnly: false,
    diskHash: emptyDiskHash,
    dirty: true,
    preview: false,
    editedThisOpenLifetime: false,
    viewState: null,
  };
}

export function isUntitledDocument(document: Pick<EditorDocument, 'path' | 'id'>): boolean {
  return document.path === null && document.id.startsWith('untitled:');
}

export function editedDocument(document: EditorDocument, content: string): EditorDocument {
  const dirty = content !== document.savedContent;
  return {
    ...document,
    content,
    dirty,
    preview: isUntitledDocument(document) ? !dirty : false,
    editedThisOpenLifetime: true,
  };
}
