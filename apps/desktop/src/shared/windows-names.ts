export function isReservedWindowsDeviceName(name: string): boolean {
  const stem = (name.split('.')[0] ?? '').replace(/[ .]+$/u, '');
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/iu.test(stem);
}

export function isSafeWindowsPathPart(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !/[<>:"/\\|?*\u0000-\u001f]/u.test(value) &&
    !/[. ]$/u.test(value) &&
    !isReservedWindowsDeviceName(value)
  );
}
