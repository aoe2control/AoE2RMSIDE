import type { ComponentProps } from 'react';
import { FolderOpenIcon } from '@animateicons/react/lucide';
import { Button } from '@/components/ui/button';
import { SelectItem } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useAnimatedIconHover } from './animated-icon';
import { useI18n } from './i18n';

export function SelectGameFolderButton({
  className,
  onMouseEnter,
  onMouseLeave,
  selecting = false,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'size' | 'variant'> & {
  selecting?: boolean;
}) {
  const { t } = useI18n();
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  return (
    <Button
      {...props}
      className={cn('select-game-folder-button', className)}
      data-selecting={selecting || undefined}
      onMouseEnter={(event) => {
        animationHandlers.onMouseEnter();
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        animationHandlers.onMouseLeave();
        onMouseLeave?.(event);
      }}
      size="sm"
      type="button"
      variant="secondary"
    >
      <FolderOpenIcon aria-hidden="true" duration={0.4} ref={iconRef} size={14} />
      <span>
        {selecting ? t('run-menu.game-folder.selecting') : t('run-menu.game-folder.select')}
      </span>
    </Button>
  );
}

export function SelectGameFolderItem({ disabled, value }: { disabled?: boolean; value: string }) {
  const { t } = useI18n();
  const { animationHandlers, iconRef } = useAnimatedIconHover();
  const selectGameFolderLabel = t('run-menu.game-folder.select');
  return (
    <SelectItem
      className="select-game-folder-item"
      disabled={disabled}
      onMouseEnter={animationHandlers.onMouseEnter}
      onMouseLeave={animationHandlers.onMouseLeave}
      value={value}
    >
      <FolderOpenIcon
        aria-hidden="true"
        className="self-center"
        duration={0.4}
        ref={iconRef}
        size={14}
      />
      {selectGameFolderLabel}
    </SelectItem>
  );
}
