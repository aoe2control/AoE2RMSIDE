import * as React from 'react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';

import { cn } from '@/lib/utils';
import { useDialogInitialFocus } from '@/dialog-initial-focus';
import {
  DialogLayerContext,
  refusesCoveredDismissal,
  useDialogLayer,
  useStackedBackdrop,
  useStackedPopup,
} from '@/dialog-stack';
import { useModalSurface } from '@/modal-surfaces';
import { useLeavingSurface } from '@/motion';
import { Button } from '@/components/ui/button';

function Dialog({ open, defaultOpen, onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const modalOpen = (open ?? uncontrolledOpen) && props.modal !== false;
  useModalSurface(modalOpen);
  const stacking = useDialogLayer('dialog', modalOpen);
  return (
    <DialogLayerContext.Provider value={stacking}>
      <DialogPrimitive.Root
        data-slot="dialog"
        defaultOpen={defaultOpen}
        onOpenChange={(nextOpen, eventDetails) => {
          if (!nextOpen && refusesCoveredDismissal(stacking.layer, eventDetails.reason)) {
            eventDetails.cancel();
            return;
          }
          onOpenChange?.(nextOpen, eventDetails);
          if (open === undefined && !eventDetails.isCanceled) setUncontrolledOpen(nextOpen);
        }}
        open={open}
        {...props}
      />
    </DialogLayerContext.Provider>
  );
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  const stackedBackdrop = useStackedBackdrop();
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      data-dialog-backdrop={stackedBackdrop}
      className={cn(
        'motion-backdrop fixed inset-0 isolate z-50 bg-black/80 supports-backdrop-filter:backdrop-blur-xs',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({ className, initialFocus, ref, ...props }: DialogPrimitive.Popup.Props) {
  const stacked = useStackedPopup(ref);
  const focus = useDialogInitialFocus(initialFocus, stacked.ref);
  const popupRef = useLeavingSurface(focus.ref);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        initialFocus={focus.initialFocus}
        ref={popupRef}
        data-slot="dialog-content"
        data-dialog-cover={stacked.cover}
        className={cn(
          'motion-dialog fixed top-1/2 left-1/2 z-50 grid w-full max-w-xs -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-sm',
          className,
        )}
        {...props}
      />
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('grid gap-1 text-center sm:text-left', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-heading text-sm font-medium', className)}
      {...props}
    />
  );
}

function DialogClose({
  className,
  variant = 'ghost',
  size = 'default',
  ...props
}: DialogPrimitive.Close.Props & Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
};
