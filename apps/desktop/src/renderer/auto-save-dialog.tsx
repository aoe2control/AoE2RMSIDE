import { useId } from 'react';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Slider } from '@/components/ui/slider';
import { autoSaveDelayTenths, clampAutoSaveDelayTenths } from '../shared/auto-save';
import { useI18n } from './i18n';

export function AutoSaveDialog({
  open,
  onOpenChange,
  enabled,
  onEnabledChange,
  delayTenths,
  onDelayTenthsChange,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  enabled: boolean;
  onEnabledChange(enabled: boolean): void;
  delayTenths: number;
  onDelayTenthsChange(tenths: number): void;
}) {
  const { t, translator } = useI18n();
  const delayLabelId = useId();
  const seconds = (tenths: number) =>
    translator.formatNumber(tenths / 10, {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'short',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="auto-save-dialog" data-testid="auto-save-dialog">
        <DialogClose
          aria-label={t('settings.auto-save.close-label')}
          className="theme-settings-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t('settings.auto-save.title')}</DialogTitle>
        </DialogHeader>
        <section className="theme-settings-section">
          <SegmentedControl<'off' | 'on'>
            label={t('settings.auto-save.title')}
            data-testid="auto-save-switch"
            onValueChange={(value) => onEnabledChange(value === 'on')}
            options={[
              { value: 'off', label: t('settings.auto-save.off') },
              { value: 'on', label: t('settings.auto-save.on') },
            ]}
            value={enabled ? 'on' : 'off'}
          />
        </section>
        <section className="theme-settings-section">
          <h3 className="theme-settings-label" id={delayLabelId}>
            {t('settings.auto-save.delay')}
          </h3>
          <div className="auto-save-delay">
            <Slider
              aria-labelledby={delayLabelId}
              data-testid="auto-save-delay"
              getAriaLabel={() => t('settings.auto-save.delay')}
              getAriaValueText={(_formatted, value) => seconds(value)}
              max={autoSaveDelayTenths.maximum}
              min={autoSaveDelayTenths.minimum}
              onValueChange={(value) => onDelayTenthsChange(clampAutoSaveDelayTenths(value))}
              step={autoSaveDelayTenths.step}
              value={delayTenths}
            />
            <span aria-hidden="true" className="auto-save-delay-value">
              {seconds(delayTenths)}
            </span>
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
