import { registerTranslationCatalogs } from './translator';

registerTranslationCatalogs(
  import.meta.glob<unknown>(['./catalogs/*.json', '!./catalogs/en.json'], {
    eager: true,
    import: 'default',
  }),
);
