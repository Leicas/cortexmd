// Default parameter values + a tiny helper imported cross-file by math.ts.
export function clamp(value: number,
                      lo: number = 0,
                      hi: number = 1): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// Empty-bodied arrow const export — exercises the const-export kind.
export const identity = (x: number): number => x;
