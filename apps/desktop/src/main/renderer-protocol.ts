import { realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative } from 'node:path';
import { readFileBounded } from './bounded-file';

export const rendererScheme = 'app';
export const rendererHost = 'rmside';
export const rendererOrigin = `${rendererScheme}://${rendererHost}`;
export const rendererDocumentUrl = `${rendererOrigin}/index.html`;

export const rendererSchemePrivileges = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  codeCache: true,
});

const maximumUrlLength = 2048;
export const maximumRendererFileBytes = 64 * 1024 * 1024;

export const rendererContentTypes: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

function parsedUrl(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > maximumUrlLength) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isRendererAuthority(url: URL): boolean {
  return (
    url.protocol === `${rendererScheme}:` &&
    url.host === rendererHost &&
    url.username === '' &&
    url.password === ''
  );
}

export function isRendererDocumentUrl(url: unknown): boolean {
  const parsed = parsedUrl(url);
  return parsed !== null && isRendererAuthority(parsed) && parsed.pathname === '/index.html';
}

export function isRendererOrigin(origin: unknown): boolean {
  const parsed = parsedUrl(origin);
  return (
    parsed !== null &&
    isRendererAuthority(parsed) &&
    (parsed.pathname === '' || parsed.pathname === '/') &&
    parsed.search === '' &&
    parsed.hash === ''
  );
}

export type RendererRequestResolution =
  | { kind: 'file'; relativePath: string; contentType: string }
  | { kind: 'refused'; status: 400 | 404 | 405; reason: string };

function refused(
  status: 400 | 404 | 405,
  reason: string,
): Extract<RendererRequestResolution, { kind: 'refused' }> {
  return { kind: 'refused', status, reason };
}

const windowsDeviceName =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu;
const unsafeSegmentCharacter = /[\u0000-\u001f\u007f<>:"|?*\\]/u;

export function resolveRendererRequest(method: string, url: string): RendererRequestResolution {
  if (method !== 'GET' && method !== 'HEAD') return refused(405, 'method');
  const parsed = parsedUrl(url);
  if (!parsed || !isRendererAuthority(parsed) || parsed.port !== '') {
    return refused(400, 'origin');
  }
  const encodedPath = parsed.pathname;
  if (!encodedPath.startsWith('/') || encodedPath === '/' || encodedPath.endsWith('/')) {
    return refused(404, 'directory');
  }
  if (/%(?:2f|5c|00)/iu.test(encodedPath)) return refused(400, 'encoded separator');
  const segments: string[] = [];
  for (const encoded of encodedPath.slice(1).split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return refused(400, 'encoding');
    }
    if (segment === '' || segment === '.' || segment === '..') return refused(400, 'segment');
    if (unsafeSegmentCharacter.test(segment)) return refused(400, 'character');
    if (/[. ]$/u.test(segment) || windowsDeviceName.test(segment)) return refused(400, 'name');
    segments.push(segment);
  }
  const fileName = segments.at(-1)!;
  const contentType = rendererContentTypes[extname(fileName).toLowerCase()];
  if (!contentType) return refused(404, 'type');
  return { kind: 'file', relativePath: segments.join('/'), contentType };
}

export function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

const responseStatusText: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  405: 'Method Not Allowed',
};

function refusal(status: 400 | 404 | 405): Response {
  return new Response(null, {
    status,
    statusText: responseStatusText[status]!,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function serveRendererRequest(
  rendererRoot: string,
  request: { method: string; url: string },
): Promise<Response> {
  const resolution = resolveRendererRequest(request.method, request.url);
  if (resolution.kind === 'refused') return refusal(resolution.status);
  let bytes: Buffer;
  try {
    const root = await realpath(rendererRoot);
    const target = await realpath(join(root, ...resolution.relativePath.split('/')));
    if (!isContainedPath(root, target)) return refusal(404);
    bytes = await readFileBounded(target, maximumRendererFileBytes);
  } catch {
    return refusal(404);
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': resolution.contentType,
      'Content-Length': String(bytes.length),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export interface RendererProtocolHost {
  registerSchemesAsPrivileged(
    schemes: Array<{ scheme: string; privileges: typeof rendererSchemePrivileges }>,
  ): void;
}

export function registerRendererScheme(host: RendererProtocolHost): void {
  host.registerSchemesAsPrivileged([
    { scheme: rendererScheme, privileges: rendererSchemePrivileges },
  ]);
}

export function handleRendererProtocol(
  sessionProtocol: {
    handle(scheme: string, handler: (request: Request) => Promise<Response>): void;
  },
  rendererRoot: string,
): void {
  sessionProtocol.handle(rendererScheme, (request) =>
    serveRendererRequest(rendererRoot, { method: request.method, url: request.url }),
  );
}
