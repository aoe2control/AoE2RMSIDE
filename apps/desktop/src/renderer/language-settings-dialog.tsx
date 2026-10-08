import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { LanguageOption } from '../shared/i18n/locale';
import { useI18n } from './i18n';
import { monacoWordsChangeAtNextStart } from './monaco-locale';

export function LanguageSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { state, t, setPreference } = useI18n();
  const nameOf = (tag: string) =>
    state.languages.find((language) => language.tag === tag)?.name ?? tag;
  const selected = state.languages.some((language) => language.tag === state.preference)
    ? state.preference
    : 'system';
  const systemLabel = t('settings.language.system', { language: nameOf(state.systemLocale) });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="language-settings-dialog">
        <DialogClose
          aria-label={t('settings.language.close-label')}
          className="language-settings-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t('settings.language.title')}</DialogTitle>
        </DialogHeader>
        <p className="language-settings-description">{t('settings.language.description')}</p>
        <Select
          onValueChange={(value) => {
            if (typeof value === 'string') void setPreference(value).catch(console.error);
          }}
          value={selected}
        >
          <SelectTrigger
            aria-label={t('settings.language.label')}
            className="language-settings-select"
          >
            <SelectValue>{selected === 'system' ? systemLabel : nameOf(selected)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{systemLabel}</SelectItem>
            {state.languages.map((option: LanguageOption) => (
              <SelectItem
                dir={option.direction}
                key={option.tag}
                lang={option.tag}
                value={option.tag}
              >
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {monacoWordsChangeAtNextStart(state.locale) ? (
          <p className="language-settings-description" role="status">
            {t('settings.language.editor-next-start')}
          </p>
        ) : null}
        <div className="language-settings-actions">
          <Button onClick={() => onOpenChange(false)} variant="secondary">
            {t('settings.language.close')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
