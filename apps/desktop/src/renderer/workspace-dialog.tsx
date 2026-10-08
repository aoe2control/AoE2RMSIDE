import { useRef } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from './i18n';
import type { ConfirmationChoice, WorkspaceConfirmation } from './workspace-controller';

interface WorkspaceDialogProps {
  confirmation: WorkspaceConfirmation | null;
  answer(choice: ConfirmationChoice): void;
}

export function WorkspaceDialog({ confirmation, answer }: WorkspaceDialogProps) {
  const primaryAction = useRef<HTMLButtonElement>(null);
  const { t } = useI18n();
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open && confirmation) answer('cancel');
      }}
      open={confirmation !== null}
    >
      <AlertDialogContent
        initialFocus={confirmation?.initialFocus === 'primary' ? primaryAction : true}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.title ?? t('dialog.confirm.title')}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer('cancel')}>
            {t('dialog.confirm.cancel')}
          </AlertDialogCancel>
          {confirmation?.secondaryLabel ? (
            <Button onClick={() => answer('secondary')} variant="secondary">
              {confirmation.secondaryLabel}
            </Button>
          ) : null}
          <AlertDialogAction
            onClick={() => answer('primary')}
            ref={primaryAction}
            variant={
              confirmation?.primaryVariant ??
              (confirmation?.destructive ? 'destructive' : 'default')
            }
          >
            {confirmation?.primaryLabel ?? t('dialog.confirm.continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
