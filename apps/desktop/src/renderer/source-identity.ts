export function sameSourceIdentity(left: string, right: string): boolean {
  if (left === right) return true;
  const leftKey = windowsFileKey(left);
  return leftKey !== null && leftKey === windowsFileKey(right);
}

function windowsFileKey(value: string): string | null {
  if (!/^file:\/\//iu.test(value)) return null;
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'file:' || uri.search || uri.hash || /%(?:2f|5c|00)/iu.test(uri.pathname))
      return null;
    const path = decodeURIComponent(uri.pathname);
    if (uri.hostname ? !/^\/[^/]+\//u.test(path) : !/^\/[a-z]:\//iu.test(path)) return null;
    return `${uri.hostname}${path}`.toLocaleLowerCase('en-US');
  } catch {
    return null;
  }
}
