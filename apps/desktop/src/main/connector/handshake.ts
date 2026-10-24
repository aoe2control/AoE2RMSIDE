import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  ServerHelloSchema,
  type ClientHello,
  type ServerHello,
} from '../../generated/rmside/connect/v1/connect_pb';
import { connectorWire, protocolMajor } from './envelope';

export const connectorKeyBytes = 32;
const pipeLabel = 'rmside-connect-pipe';
const serverLabel = 'rmside-connect-server';
const clientLabel = 'rmside-connect-client';

export function connectorKeyId(key: Uint8Array): string {
  assertKey(key);
  return createHash('sha256').update(pipeLabel).update(key).digest('hex').slice(0, 16);
}

export function connectorPipeName(key: Uint8Array): string {
  return `\\\\.\\pipe\\AoE2RMSIDE-MCP-${protocolMajor}-${connectorKeyId(key)}`;
}

export function connectorServerProof(
  key: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
): Buffer {
  assertKey(key);
  return createHmac('sha256', key)
    .update(serverLabel)
    .update(clientNonce)
    .update(serverNonce)
    .digest();
}

export function connectorClientProof(
  key: Uint8Array,
  serverNonce: Uint8Array,
  clientNonce: Uint8Array,
): Buffer {
  assertKey(key);
  return createHmac('sha256', key)
    .update(clientLabel)
    .update(serverNonce)
    .update(clientNonce)
    .digest();
}

export function connectorProofMatches(received: Uint8Array, expected: Uint8Array): boolean {
  return (
    received.byteLength === connectorWire.proofBytes &&
    expected.byteLength === connectorWire.proofBytes &&
    timingSafeEqual(received, expected)
  );
}

function assertKey(key: Uint8Array): void {
  if (key.byteLength !== connectorKeyBytes) throw new Error('the connector key must be 32 bytes');
}

export interface PendingHandshake {
  hello: ClientHello;
  serverNonce: Uint8Array;
  expectedClientProof: Buffer;
}

export function answerClientHello(options: {
  key: Uint8Array;
  hello: ClientHello;
  ideVersion: string;
  catalogHash: Uint8Array;
  serverNonce?: Uint8Array;
}): { serverHello: ServerHello; pending: PendingHandshake } {
  const serverNonce = options.serverNonce ?? randomBytes(connectorWire.nonceBytes);
  if (serverNonce.byteLength !== connectorWire.nonceBytes) {
    throw new Error('the server nonce must be 32 bytes');
  }
  const serverHello = create(ServerHelloSchema, {
    ideVersion: options.ideVersion,
    catalogHash: options.catalogHash,
    serverNonce,
    serverProof: connectorServerProof(options.key, options.hello.clientNonce, serverNonce),
  });
  return {
    serverHello,
    pending: {
      hello: options.hello,
      serverNonce,
      expectedClientProof: connectorClientProof(
        options.key,
        serverNonce,
        options.hello.clientNonce,
      ),
    },
  };
}

export function catalogHashesMatch(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === connectorWire.catalogHashBytes &&
    right.byteLength === connectorWire.catalogHashBytes &&
    timingSafeEqual(left, right)
  );
}

export function versionMismatchMessage(connectorVersion: string): string {
  return `This connector belongs to AoE2RMSIDE ${connectorVersion}. In this IDE, open View > MCP > Connect an AI app and set this app up again.`;
}
