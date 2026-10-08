import type { ExternalLinkTarget } from './api';
import { t, type MessageId } from './i18n/translator';
import type { OutputAction } from './output-message';

export interface ActionRef {
  readonly id: MessageId;
  readonly link?: ExternalLinkTarget;
}

export type CatalogHeadline<F> = MessageId | ((facts: F) => string);
export type CatalogText<F> = MessageId | ((facts: F) => string | null);
export type CatalogAction<F> = ActionRef | ((facts: F) => ActionRef | OutputAction | null);

export const step = (id: MessageId): ActionRef => ({ id });
export const linkStep = (id: MessageId, link: ExternalLinkTarget): ActionRef => ({ id, link });

export function resolveHeadline<F>(headline: CatalogHeadline<F>, facts: F): string {
  return typeof headline === 'function' ? headline(facts) : t(headline);
}

export function resolveCatalogText<F>(text: CatalogText<F> | undefined, facts: F): string | null {
  if (text === undefined) return null;
  const value = typeof text === 'function' ? text(facts) : t(text);
  return value && value.trim() ? value.trim() : null;
}

export function resolveCatalogAction<F>(
  action: CatalogAction<F> | undefined,
  facts: F,
): OutputAction | null {
  if (action === undefined) return null;
  const value = typeof action === 'function' ? action(facts) : action;
  if (!value) return null;
  if ('label' in value) return value;
  return { label: t(value.id), ...(value.link ? { link: value.link } : {}) };
}
