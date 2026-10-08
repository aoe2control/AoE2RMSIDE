import { createRoot } from 'react-dom/client';
import 'pixi.js/unsafe-eval';
import './monaco-workers';
import './styles.css';
import { productIdentity } from '../shared/edition';
import '../shared/i18n/bundled-catalogs';
import { applyLocaleState, englishLocaleState, I18nProvider } from './i18n';
import { loadMonacoMessages } from './monaco-locale';
import { installQuietFocus } from './quiet-focus';

installQuietFocus();

document.title = productIdentity.displayName;

const root = document.getElementById('root');
if (!root) throw new Error('renderer root is missing');

const localeState = await window.rmside.getLocaleState().catch(() => englishLocaleState);
applyLocaleState(localeState);

await loadMonacoMessages(localeState.locale);
const { App } = await import('./app');

createRoot(root).render(
  <I18nProvider initial={localeState}>
    <App />
  </I18nProvider>,
);
