import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Folder, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { WorkspaceSwitchFolder } from '../shared/api';
import { useI18n } from './i18n';

export function FolderSwitcher({
  folderPath,
  onOpenFolder,
  onSwitch,
  tabStop,
}: {
  folderPath: string;
  onOpenFolder(): void;
  onSwitch(id: string): void;
  tabStop: boolean;
}) {
  const { t } = useI18n();
  const [folders, setFolders] = useState<WorkspaceSwitchFolder[]>([]);
  const [open, setOpen] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const sequence = ++request.current;
    window.rmside.switchFolders().then(
      (next) => {
        if (sequence !== request.current) return;
        const others = next.filter((folder) => !folder.open);
        setFolders((current) => (sameFolders(current, others) ? current : others));
      },
      () => {},
    );
  }, []);
  useEffect(() => {
    refresh();
  }, [folderPath, refresh]);

  return (
    <DropdownMenu
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refresh();
      }}
    >
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={t('explorer.switch-folder.label')}
                  className="explorer-folder-switch"
                  size="icon-xs"
                  tabIndex={tabStop ? 0 : -1}
                  variant="ghost"
                />
              }
            />
          }
        >
          <ChevronDown aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{t('explorer.switch-folder.tooltip')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="explorer-folder-switch-menu">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('explorer.switch-folder.recent')}</DropdownMenuLabel>
          {folders.length > 0 ? (
            folders.map((folder) => (
              <FolderSwitchItem
                folder={folder}
                key={folder.id}
                onSelect={() => onSwitch(folder.id)}
              />
            ))
          ) : (
            <DropdownMenuItem disabled>{t('explorer.switch-folder.empty')}</DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenFolder}>
          <FolderOpen aria-hidden="true" /> {t('app-menu.file.open-folder')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function sameFolders(
  current: readonly WorkspaceSwitchFolder[],
  next: readonly WorkspaceSwitchFolder[],
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (folder, index) =>
        folder.id === next[index]!.id &&
        folder.name === next[index]!.name &&
        folder.path === next[index]!.path,
    )
  );
}

function FolderSwitchItem({
  folder,
  onSelect,
}: {
  folder: WorkspaceSwitchFolder;
  onSelect(): void;
}) {
  return (
    <DropdownMenuItem
      aria-description={folder.path}
      className="explorer-folder-switch-item"
      label={folder.name}
      onClick={onSelect}
    >
      <Folder aria-hidden="true" />
      <Tooltip>
        <TooltipTrigger render={<span className="explorer-folder-switch-name" />}>
          {folder.name}
        </TooltipTrigger>
        <TooltipContent align="start" className="path-tooltip" side="right">
          {folder.path}
        </TooltipContent>
      </Tooltip>
    </DropdownMenuItem>
  );
}
