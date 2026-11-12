/** Injected time source. Application code never calls Date.now() directly. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
