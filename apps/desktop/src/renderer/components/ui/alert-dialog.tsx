import * as React from 'react';
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';

import { cn } from '@/lib/utils';
import { isRepeatedActivation, useDialogInitialFocus } from '@/dialog-initial-focus';
import { useModalSurface } from '@/modal-surfaces';
import { useLeavingSurface } from '@/motion';
import { Button } from '@/components/ui/button';

const AlertDialogDismissContext = React.createContext<(() => void) | null>(null);

function AlertDialog({
  actionsRef,
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: AlertDialogPrimitive.Root.Props) {
  const internalActionsRef = React.useRef<AlertDialogPrimitive.Root.Actions | null>(null);
  const resolvedActionsRef = actionsRef ?? internalActionsRef;
  const dismiss = React.useCallback(
    () => resolvedActionsRef.current?.close(),
    [resolvedActionsRef],
  );
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  useModalSurface(open ?? uncontrolledOpen);

  return (
    <AlertDialogDismissContext.Provider value={dismiss}>
      <AlertDialogPrimitive.Root
        actionsRef={resolvedActionsRef}
        data-slot="alert-dialog"
        defaultOpen={defaultOpen}
        onOpenChange={(nextOpen, eventDetails) => {
          onOpenChange?.(nextOpen, eventDetails);
          if (open === undefined && !eventDetails.isCanceled) setUncontrolledOpen(nextOpen);
        }}
        open={open}
        {...props}
      />
    </AlertDialogDismissContext.Provider>
  );
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  const dismiss = React.useContext(AlertDialogDismissContext);
  const { onPointerDown, ...overlayProps } = props;
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(
        'motion-backdrop fixed inset-0 isolate z-50 bg-black/80 supports-backdrop-filter:backdrop-blur-xs',
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented && event.button === 0) dismiss?.();
      }}
      {...overlayProps}
    />
  );
}

function AlertDialogContent({
  className,
  size = 'default',
  initialFocus,
  onKeyDownCapture,
  ref,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: 'default' | 'sm';
}) {
  const focus = useDialogInitialFocus(initialFocus, ref);
  const popupRef = useLeavingSurface(focus.ref);
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        initialFocus={focus.initialFocus}
        onKeyDownCapture={(event) => {
          onKeyDownCapture?.(event);
          if (isRepeatedActivation(event)) event.preventDefault();
        }}
        ref={popupRef}
        data-slot="alert-dialog-content"
        data-size={size}
        className={cn(
          'motion-dialog group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl bg-popover p-4 text-popover-foreground ring-1 ring-foreground/10 outline-none data-[size=default]:max-w-xs data-[size=sm]:max-w-64 data-[size=default]:sm:max-w-sm',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        'grid grid-rows-[auto_1fr] place-items-center gap-1 text-center has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        'flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "mb-2 inline-flex size-8 items-center justify-center rounded-md bg-muted sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        'font-heading text-sm font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        'text-xs/relaxed text-balance text-muted-foreground md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" className={cn(className)} {...props} />;
}

function AlertDialogCancel({
  className,
  variant = 'secondary',
  size = 'default',
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
