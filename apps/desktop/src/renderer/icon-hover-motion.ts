export interface IconPose {
  scale: number;
  rotate: number;
  y: number;
}

export type IconPoseChannel = keyof IconPose;

const channels: readonly IconPoseChannel[] = ['scale', 'rotate', 'y'];

export const iconHoverVariants = {
  normal: { scale: 1, rotate: 0, y: 0 },
  animate: {
    scale: [1, 1.05, 0.98, 1],
    rotate: [0, -2, 2, 0],
    y: [0, -2, 1, 0],
    transition: { duration: 0.9, ease: 'easeInOut' },
  },
} as const;

export const easeInOutCurve = [0.42, 0, 0.58, 1] as const;

export const iconHoverReturnSprings: Record<
  IconPoseChannel,
  { stiffness: number; damping: number; mass: number; restSpeed: number }
> = {
  scale: { stiffness: 550, damping: 30, mass: 1, restSpeed: 10 },
  rotate: { stiffness: 500, damping: 25, mass: 1, restSpeed: 10 },
  y: { stiffness: 500, damping: 25, mass: 1, restSpeed: 10 },
};

export const iconHoverRestDelta = 0.005;

const velocitySampleMs = 30;

const calcBezier = (t: number, a1: number, a2: number) =>
  ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  if (x1 === y1 && x2 === y2) return (t) => t;
  const solve = (x: number) => {
    let lower = 0;
    let upper = 1;
    let current = 0;
    let error = 0;
    let iteration = 0;
    do {
      current = lower + (upper - lower) / 2;
      error = calcBezier(current, x1, x2) - x;
      if (error > 0) upper = current;
      else lower = current;
    } while (Math.abs(error) > 1e-7 && ++iteration < 12);
    return current;
  };
  return (t) => (t === 0 || t === 1 ? t : calcBezier(solve(t), y1, y2));
}

export const easeInOut = cubicBezier(...easeInOutCurve);

export function sampleKeyframes(
  values: readonly number[],
  elapsed: number,
  duration: number,
  ease: (t: number) => number = easeInOut,
): number {
  const last = values.length - 1;
  if (last <= 0) return values[0] ?? 0;
  if (elapsed <= 0) return values[0]!;
  if (elapsed >= duration) return values[last]!;
  const position = (elapsed / duration) * last;
  const segment = Math.min(last - 1, Math.floor(position));
  const from = values[segment]!;
  const to = values[segment + 1]!;
  return from + (to - from) * ease(position - segment);
}

export function returnSpring(
  from: number,
  to: number,
  velocity: number,
  { stiffness, damping, mass, restSpeed }: (typeof iconHoverReturnSprings)[IconPoseChannel],
): (t: number) => { value: number; done: boolean } {
  const dampingRatio = damping / (2 * Math.sqrt(stiffness * mass));
  if (dampingRatio >= 1) throw new Error('icon hover springs are underdamped');
  const delta = to - from;
  const angular = Math.sqrt(stiffness / mass) / 1000;
  const initialVelocity = -velocity / 1000;
  const damped = angular * Math.sqrt(1 - dampingRatio * dampingRatio);
  const a = (initialVelocity + dampingRatio * angular * delta) / damped;
  const b = dampingRatio * angular * a + delta * damped;
  const c = dampingRatio * angular * delta - a * damped;
  return (t) => {
    const envelope = Math.exp(-dampingRatio * angular * t);
    const sine = Math.sin(damped * t);
    const cosine = Math.cos(damped * t);
    const value = to - envelope * (a * sine + delta * cosine);
    const speed = envelope * (b * sine + c * cosine) * 1000;
    const done = Math.abs(speed) <= restSpeed && Math.abs(to - value) <= iconHoverRestDelta;
    return { value: done ? to : value, done };
  };
}

export function springDuration(spring: (t: number) => { done: boolean }): number {
  let time = 0;
  while (!spring(time).done && time < 20_000) time += 50;
  return time >= 20_000 ? Infinity : time;
}

export interface IconHoverMotionOptions {
  render(pose: IconPose | null): void;
  duration?: number;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  reducedMotion?: () => boolean;
}

export interface IconHoverMotion {
  start(): void;
  stop(): void;
  dispose(): void;
}

interface ChannelState {
  value: number;
  previous: number | undefined;
  updatedAt: number;
  previousUpdatedAt: number;
}

type Driver = (elapsed: number) => { pose: IconPose; done: boolean };

export function createIconHoverMotion(options: IconHoverMotionOptions): IconHoverMotion {
  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const reducedMotion = options.reducedMotion ?? (() => false);
  const duration = iconHoverVariants.animate.transition.duration * (options.duration ?? 1) * 1000;
  const state = Object.fromEntries(
    channels.map((channel) => [
      channel,
      {
        value: iconHoverVariants.normal[channel],
        previous: undefined,
        updatedAt: 0,
        previousUpdatedAt: 0,
      },
    ]),
  ) as Record<IconPoseChannel, ChannelState>;
  let driver: Driver | null = null;
  let startedAt = 0;
  let frame: number | null = null;

  const atRest = () =>
    channels.every((channel) => state[channel].value === iconHoverVariants.normal[channel]);
  const cancel = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    driver = null;
  };
  const rest = () => {
    cancel();
    for (const channel of channels) {
      state[channel].value = iconHoverVariants.normal[channel];
      state[channel].previous = undefined;
    }
    options.render(null);
  };
  const elapsedAt = (at: number) => Math.max(0, Math.round(at - startedAt));
  const record = (pose: IconPose, at: number) => {
    for (const channel of channels) {
      const entry = state[channel];
      if (entry.updatedAt !== at) {
        entry.previous = entry.value;
        entry.previousUpdatedAt = entry.updatedAt;
      }
      entry.value = pose[channel];
      entry.updatedAt = at;
    }
  };
  const advance = (at: number) => {
    if (!driver || channels.every((channel) => state[channel].updatedAt === at)) return;
    record(driver(elapsedAt(at)).pose, at);
  };
  const velocityOf = (channel: IconPoseChannel, at: number) => {
    const { previous, previousUpdatedAt, updatedAt, value } = state[channel];
    if (previous === undefined || at - updatedAt > velocitySampleMs) return 0;
    const span = Math.min(updatedAt - previousUpdatedAt, velocitySampleMs);
    return span > 0 ? ((value - previous) * 1000) / span : 0;
  };
  const tick = () => {
    frame = null;
    if (!driver) return;
    const at = now();
    const { pose, done } = driver(elapsedAt(at));
    record(pose, at);
    if (done) {
      driver = null;
      options.render(atRest() ? null : pose);
      return;
    }
    options.render(pose);
    frame = requestFrame(tick);
  };
  const play = (next: Driver, at: number) => {
    if (frame !== null) cancelFrame(frame);
    driver = next;
    startedAt = at;
    frame = requestFrame(tick);
  };

  return {
    start() {
      if (reducedMotion()) {
        rest();
        return;
      }
      const at = now();
      advance(at);
      const tracks = iconHoverVariants.animate;
      play(
        (elapsed) => ({
          pose: {
            scale: sampleKeyframes(tracks.scale, elapsed, duration),
            rotate: sampleKeyframes(tracks.rotate, elapsed, duration),
            y: sampleKeyframes(tracks.y, elapsed, duration),
          },
          done: elapsed >= duration,
        }),
        at,
      );
    },
    stop() {
      if (reducedMotion()) {
        rest();
        return;
      }
      const at = now();
      advance(at);
      if (atRest()) {
        cancel();
        return;
      }
      const springs = channels.map((channel) => {
        const spring = returnSpring(
          state[channel].value,
          iconHoverVariants.normal[channel],
          velocityOf(channel, at),
          iconHoverReturnSprings[channel],
        );
        return { channel, spring, settlesAt: springDuration(spring) };
      });
      play((elapsed) => {
        const pose: IconPose = { ...iconHoverVariants.normal };
        for (const { channel, spring, settlesAt } of springs) {
          if (elapsed < settlesAt) pose[channel] = spring(elapsed).value;
        }
        return { pose, done: springs.every(({ settlesAt }) => elapsed >= settlesAt) };
      }, at);
    },
    dispose() {
      cancel();
    },
  };
}

export interface IconGeometryCenter {
  x: number;
  y: number;
}

export function iconLayerTransforms(
  pose: IconPose,
  center: IconGeometryCenter,
  viewBoxHeight: number,
): { outer: string; inner: string; innerOrigin: string } {
  const turn = `scale(${pose.scale}) rotate(${pose.rotate}deg)`;
  return {
    outer: `translateY(${pose.y}px) ${turn}`,
    inner: `translateY(${(pose.y / viewBoxHeight) * 100}%) ${turn}`,
    innerOrigin: `${center.x}% ${center.y}%`,
  };
}
