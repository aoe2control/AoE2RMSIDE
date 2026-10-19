import { useEffect, useRef } from 'react';
import { motionDuration } from './motion';
import { attachSeparatorPill, type SeparatorOrientation } from './separator-pill';

const fallbackFollowMilliseconds = 70;

export function SeparatorPill({ orientation }: { orientation: SeparatorOrientation }) {
  const trackElement = useRef<HTMLSpanElement>(null);
  const pillElement = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const track = trackElement.current;
    const pill = pillElement.current;
    const separator = track?.parentElement;
    if (!track || !pill || !separator) return undefined;
    return attachSeparatorPill(separator, track, pill, orientation, {
      smoothing: () =>
        motionDuration('--motion-duration-separator-pill-follow', fallbackFollowMilliseconds),
    });
  }, [orientation]);
  return (
    <span
      aria-hidden="true"
      className="separator-pill-track"
      data-orientation={orientation}
      ref={trackElement}
    >
      <span className="separator-pill" ref={pillElement} />
    </span>
  );
}
