import { randomUUID } from 'node:crypto';
import type { MainSourceCatalog } from './source-catalog-service';
import { SourceCatalogDiscoveryError } from './source-catalog-probes';

interface ReadinessDependencies {
  epoch(): string;
  prepare(uri: string): Promise<{ catalog: MainSourceCatalog; documentVersion: number }>;
  analyze(catalog: MainSourceCatalog, params: Record<string, unknown>): Promise<unknown>;
  validate(catalog: MainSourceCatalog): Promise<void>;
}

interface Proof {
  uri: string;
  epoch: string;
  catalogHash: string;
  documentVersion: number;
}

export class SourceCatalogReadiness {
  private readonly proofs = new Map<string, Proof>();
  private readonly attempts = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly dependencies: ReadinessDependencies) {}

  invalidate(uri?: string): void {
    for (const [token, proof] of this.proofs) {
      if (!uri || proof.uri === uri) this.proofs.delete(token);
    }
    if (uri) this.attempts.set(uri, ++this.sequence);
    else {
      this.sequence += 1;
      this.attempts.clear();
    }
    while (this.attempts.size > 32) this.attempts.delete(this.attempts.keys().next().value!);
  }

  async analyze(value: unknown): Promise<Record<string, unknown>> {
    const params = record(value);
    const uri = documentUri(params);
    this.invalidate(uri);
    const attempt = this.attempts.get(uri)!;
    const epoch = this.dependencies.epoch();
    const current = (): void => {
      if (epoch !== this.dependencies.epoch() || attempt !== this.attempts.get(uri)) throw stale();
    };
    const { catalog, documentVersion } = await this.dependencies.prepare(uri);
    current();
    const requiredSourceCatalog = {
      catalogHash: hex(catalog.catalogHash),
      sourceGraphHash: hex(catalog.rmsGraphHash),
      externalAssetHash: hex(catalog.externalAssetHash),
      documentVersion,
    };
    const result = record(
      await this.dependencies.analyze(catalog, { ...params, requiredSourceCatalog }),
    );
    current();
    await this.dependencies.validate(catalog);
    current();
    if (
      result.sourceCatalogHash !== requiredSourceCatalog.catalogHash ||
      result.sourceGraphHash !== requiredSourceCatalog.sourceGraphHash ||
      result.externalAssetHash !== requiredSourceCatalog.externalAssetHash ||
      result.documentRevision !== requiredSourceCatalog.sourceGraphHash ||
      result.profileId !== catalog.profileId
    ) {
      throw new Error('the analysis does not match the current include graph');
    }
    const token = randomUUID();
    while (this.proofs.size >= 32) this.proofs.delete(this.proofs.keys().next().value!);
    this.proofs.set(token, {
      uri,
      epoch,
      catalogHash: requiredSourceCatalog.catalogHash,
      documentVersion,
    });
    return { ...result, sourceCatalogProof: token };
  }

  async validate(value: unknown): Promise<boolean> {
    const params = record(value);
    const uri = documentUri(params);
    const token = params.sourceCatalogProof;
    if (typeof token !== 'string' || token.length > 64) throw stale();
    const proof = this.proofs.get(token);
    if (!proof || proof.uri !== uri || proof.epoch !== this.dependencies.epoch()) throw stale();
    try {
      const { catalog, documentVersion } = await this.dependencies.prepare(uri);
      if (
        this.proofs.get(token) !== proof ||
        proof.epoch !== this.dependencies.epoch() ||
        documentVersion !== proof.documentVersion ||
        hex(catalog.catalogHash) !== proof.catalogHash
      )
        throw stale();
      await this.dependencies.validate(catalog);
      if (this.proofs.get(token) !== proof || proof.epoch !== this.dependencies.epoch())
        throw stale();
      return true;
    } catch (error) {
      this.proofs.delete(token);
      throw error;
    }
  }
}

function stale(): Error {
  return new SourceCatalogDiscoveryError('stale', 'entry', 1, 0);
}
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('source catalog identity request is invalid');
  return value as Record<string, unknown>;
}
function documentUri(params: Record<string, unknown>): string {
  const uri = record(params.textDocument).uri;
  if (typeof uri !== 'string' || uri.length < 1 || uri.length > 4096)
    throw new Error('source catalog document identity is invalid');
  return uri;
}
