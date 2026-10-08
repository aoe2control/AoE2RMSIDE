const activeMatchReplacementConsentKey = 'rmside.live-test.active-match-replacement-consent.v1';
const acceptedActiveMatchReplacementConsent = 'accepted';

type PreferenceReader = Pick<Storage, 'getItem'>;
type PreferenceWriter = Pick<Storage, 'setItem'>;

export function hasAcceptedActiveMatchReplacement(storage: PreferenceReader): boolean {
  try {
    return (
      storage.getItem(activeMatchReplacementConsentKey) === acceptedActiveMatchReplacementConsent
    );
  } catch {
    return false;
  }
}

export function rememberActiveMatchReplacement(storage: PreferenceWriter): boolean {
  try {
    storage.setItem(activeMatchReplacementConsentKey, acceptedActiveMatchReplacementConsent);
    return true;
  } catch {
    return false;
  }
}

export function forgetActiveMatchReplacement(storage: Pick<Storage, 'removeItem'>): boolean {
  try {
    storage.removeItem(activeMatchReplacementConsentKey);
    return true;
  } catch {
    return false;
  }
}
