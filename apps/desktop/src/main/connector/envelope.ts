import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  CompatibilityRangeSchema,
  EnvelopeSchema,
  GoodbyeReason,
  PairingState,
  ProtocolErrorSchema,
  ProtocolVersionSchema,
  type CallResult,
  type ClientHello,
  type Envelope,
  type Image,
} from '../../generated/rmside/connect/v1/connect_pb';

export const protocolMajor = 1;
export const protocolMinor = 0;
export const protocolPatch = 0;

export const connectorWire = Object.freeze({
  frameBytes: 4 * 1024 * 1024,
  handshakeFrameBytes: 16 * 1024,
  argumentsJsonBytes: 512 * 1024,
  textItemBytes: 64 * 1024,
  pngBytes: 1536 * 1024,
  imageMaxSide: 1024,
  imageMinLongSide: 256,
  contentItems: 4,
  imagesPerResult: 1,
  nonceBytes: 32,
  proofBytes: 32,
  catalogHashBytes: 32,
  appNameChars: 64,
  appTitleChars: 64,
  appVersionChars: 32,
  launcherImageChars: 255,
  appDisplayNameChars: 128,
  productVersionBytes: 64,
  mcpRevisionBytes: 32,
  sessionIdBytes: 64,
  toolNameBytes: 64,
  progressMessageBytes: 256,
  goodbyeMessageBytes: 512,
  errorCodeBytes: 64,
  errorMessageBytes: 512,
});

export const protocolErrorCodes = Object.freeze({
  unsupportedMajor: 'unsupported-major',
  unknownMessage: 'unknown-message',
  malformedMessage: 'malformed-message',
});

export type EnvelopePayload = Envelope['payload'];

export type EnvelopeRefusal =
  | { kind: 'unsupported-major' }
  | { kind: 'unknown-message' }
  | { kind: 'malformed-message'; field: string };

export function connectorEnvelope(messageId: bigint, payload: EnvelopePayload): Envelope {
  return create(EnvelopeSchema, {
    version: create(ProtocolVersionSchema, {
      major: protocolMajor,
      minor: protocolMinor,
      patch: protocolPatch,
    }),
    compatibility: create(CompatibilityRangeSchema, {
      minimumMajor: protocolMajor,
      maximumMajor: protocolMajor,
    }),
    messageId,
    payload,
  });
}

export function truncateUtf8(text: string, maximum: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maximum) return text;
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function protocolErrorPayload(code: string, message: string): EnvelopePayload {
  return {
    case: 'protocolError',
    value: create(ProtocolErrorSchema, {
      code,
      message: truncateUtf8(message, connectorWire.errorMessageBytes),
    }),
  };
}

export function supportsMajor(envelope: Envelope): boolean {
  const range = envelope.compatibility;
  return (
    envelope.version?.major === protocolMajor &&
    range !== undefined &&
    range.minimumMajor <= range.maximumMajor &&
    range.minimumMajor <= protocolMajor &&
    protocolMajor <= range.maximumMajor
  );
}

const sessionIdPattern = /^[A-Za-z0-9-]{1,64}$/u;
const toolNamePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const errorCodePattern = /^[a-z-]{1,64}$/u;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isProductVersion(text: string): boolean {
  return (
    text.length >= 1 && text.length <= connectorWire.productVersionBytes && /^[!-~]+$/u.test(text)
  );
}

function isDisplayText(text: string, minimum: number, maximum: number): boolean {
  const count = [...text].length;
  return count >= minimum && count <= maximum && !/\p{Cc}/u.test(text);
}

function isKnownPairing(value: number): boolean {
  return (
    value === PairingState.APPROVED ||
    value === PairingState.PENDING ||
    value === PairingState.DENIED
  );
}

function isJsonObjectText(text: string): boolean {
  const trimmed = text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/gu, '');
  return (
    utf8Bytes(text) <= connectorWire.argumentsJsonBytes &&
    trimmed.length >= 2 &&
    trimmed.startsWith('{') &&
    trimmed.endsWith('}')
  );
}

function checkClientHello(hello: ClientHello): string | null {
  if (!isProductVersion(hello.connectorVersion)) return 'client_hello.connector_version';
  if (hello.catalogHash.length !== connectorWire.catalogHashBytes)
    return 'client_hello.catalog_hash';
  if (hello.clientNonce.length !== connectorWire.nonceBytes) return 'client_hello.client_nonce';
  if (
    utf8Bytes(hello.mcpRevision) > connectorWire.mcpRevisionBytes ||
    !/^[!-~]*$/u.test(hello.mcpRevision)
  ) {
    return 'client_hello.mcp_revision';
  }
  const app = hello.app;
  if (!app) return 'client_hello.app';
  if (!isDisplayText(app.name, 1, connectorWire.appNameChars)) return 'client_hello.app.name';
  if (!isDisplayText(app.title, 0, connectorWire.appTitleChars)) return 'client_hello.app.title';
  if (!isDisplayText(app.version, 0, connectorWire.appVersionChars))
    return 'client_hello.app.version';
  if (
    !isDisplayText(app.launcherImage, 0, connectorWire.launcherImageChars) ||
    /[\\/:]/u.test(app.launcherImage)
  ) {
    return 'client_hello.app.launcher_image';
  }
  return null;
}

function checkImage(image: Image): string | null {
  const png = Buffer.from(image.png.buffer, image.png.byteOffset, image.png.byteLength);
  if (
    png.length < 24 ||
    png.length > connectorWire.pngBytes ||
    !png.subarray(0, 8).equals(pngSignature) ||
    png.toString('latin1', 12, 16) !== 'IHDR'
  ) {
    return 'call_result.content.image.png';
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const inSide = (side: number) => side >= 1 && side <= connectorWire.imageMaxSide;
  if (
    width !== image.width ||
    height !== image.height ||
    !inSide(image.width) ||
    !inSide(image.height) ||
    Math.max(image.width, image.height) < connectorWire.imageMinLongSide
  ) {
    return 'call_result.content.image.size';
  }
  return null;
}

function checkCallResult(result: CallResult): string | null {
  if (result.callId === 0n) return 'call_result.call_id';
  if (result.content.length === 0 || result.content.length > connectorWire.contentItems) {
    return 'call_result.content';
  }
  let images = 0;
  for (const item of result.content) {
    switch (item.item.case) {
      case 'text':
        if (utf8Bytes(item.item.value) > connectorWire.textItemBytes) {
          return 'call_result.content.text';
        }
        break;
      case 'image': {
        images += 1;
        const refusal = checkImage(item.item.value);
        if (refusal) return refusal;
        break;
      }
      default:
        return 'call_result.content.item';
    }
  }
  if (images > connectorWire.imagesPerResult) return 'call_result.content.image';
  if (result.isError && !(result.content.length === 1 && result.content[0]!.item.case === 'text')) {
    return 'call_result.is_error';
  }
  return null;
}

function malformedField(envelope: Envelope): string | null {
  const payload = envelope.payload;
  switch (payload.case) {
    case 'clientHello':
      return checkClientHello(payload.value);
    case 'serverHello': {
      const hello = payload.value;
      if (!isProductVersion(hello.ideVersion)) return 'server_hello.ide_version';
      if (hello.catalogHash.length !== connectorWire.catalogHashBytes) {
        return 'server_hello.catalog_hash';
      }
      if (hello.serverNonce.length !== connectorWire.nonceBytes) return 'server_hello.server_nonce';
      if (hello.serverProof.length !== connectorWire.proofBytes) return 'server_hello.server_proof';
      return null;
    }
    case 'clientProof':
      return payload.value.clientProof.length === connectorWire.proofBytes
        ? null
        : 'client_proof.client_proof';
    case 'sessionReady': {
      const ready = payload.value;
      if (!sessionIdPattern.test(ready.sessionId)) return 'session_ready.session_id';
      if (!isKnownPairing(ready.pairing)) return 'session_ready.pairing';
      if (!isDisplayText(ready.appDisplayName, 1, connectorWire.appDisplayNameChars)) {
        return 'session_ready.app_display_name';
      }
      return null;
    }
    case 'pairingChanged':
      return isKnownPairing(payload.value.pairing) ? null : 'pairing_changed.pairing';
    case 'callTool': {
      const call = payload.value;
      if (call.callId === 0n) return 'call_tool.call_id';
      if (!toolNamePattern.test(call.toolName)) return 'call_tool.tool_name';
      if (!isJsonObjectText(call.argumentsJson)) return 'call_tool.arguments_json';
      return null;
    }
    case 'cancelCall':
      return payload.value.callId === 0n ? 'cancel_call.call_id' : null;
    case 'callProgress': {
      const progress = payload.value;
      if (progress.callId === 0n) return 'call_progress.call_id';
      if (progress.total !== 0 && progress.done > progress.total) return 'call_progress.done';
      if (utf8Bytes(progress.message) > connectorWire.progressMessageBytes) {
        return 'call_progress.message';
      }
      return null;
    }
    case 'callResult':
      return checkCallResult(payload.value);
    case 'goodbye': {
      if (payload.value.reason === GoodbyeReason.UNSPECIFIED || payload.value.reason < 0) {
        return 'goodbye.reason';
      }
      return utf8Bytes(payload.value.message) > connectorWire.goodbyeMessageBytes
        ? 'goodbye.message'
        : null;
    }
    case 'protocolError': {
      if (!errorCodePattern.test(payload.value.code)) return 'protocol_error.code';
      return utf8Bytes(payload.value.message) > connectorWire.errorMessageBytes
        ? 'protocol_error.message'
        : null;
    }
    default:
      return null;
  }
}

export function checkEnvelope(envelope: Envelope): EnvelopeRefusal | null {
  if (!supportsMajor(envelope)) return { kind: 'unsupported-major' };
  if (envelope.messageId === 0n) return { kind: 'malformed-message', field: 'message_id' };
  if (envelope.payload.case === undefined) return { kind: 'unknown-message' };
  const field = malformedField(envelope);
  return field === null ? null : { kind: 'malformed-message', field };
}

export function decodeEnvelope(frame: Uint8Array): Envelope {
  return fromBinary(EnvelopeSchema, frame);
}

export function encodeFrame(envelope: Envelope): Buffer {
  const body = toBinary(EnvelopeSchema, envelope);
  if (body.byteLength > connectorWire.frameBytes) {
    throw new Error('connector frame exceeds the maximum length');
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32LE(body.byteLength, 0);
  frame.set(body, 4);
  return frame;
}

export class FrameTooLargeError extends Error {
  constructor(readonly declared: number) {
    super('connector frame declares an excessive length');
    this.name = 'FrameTooLargeError';
  }
}

export class ConnectorFrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(public maximumBytes: number) {}

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(Buffer.from(chunk));
      this.buffered += chunk.byteLength;
    }
    const frames: Uint8Array[] = [];
    while (this.buffered >= 4) {
      const head = this.join(4);
      const length = head.readUInt32LE(0);
      if (length > this.maximumBytes) throw new FrameTooLargeError(length);
      if (this.buffered < length + 4) break;
      const whole = this.join(length + 4);
      frames.push(Uint8Array.from(whole.subarray(4)));
      this.consume(length + 4);
    }
    return frames;
  }

  private join(bytes: number): Buffer {
    if (this.chunks[0]!.byteLength >= bytes) return this.chunks[0]!;
    const joined = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [joined];
    return joined;
  }

  private consume(bytes: number): void {
    const first = this.chunks[0]!;
    if (first.byteLength === bytes) this.chunks.shift();
    else this.chunks[0] = first.subarray(bytes);
    this.buffered -= bytes;
  }
}
