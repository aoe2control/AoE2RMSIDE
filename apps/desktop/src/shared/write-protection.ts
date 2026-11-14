export interface WriteProtection {
  gameFolder: boolean;
  modFolders: boolean;
}

export type WriteProtectionTarget = keyof WriteProtection;

export const defaultWriteProtection: Readonly<WriteProtection> = Object.freeze({
  gameFolder: true,
  modFolders: true,
});
