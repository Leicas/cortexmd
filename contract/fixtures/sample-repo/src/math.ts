import { clamp } from "./util";

// Multi-line signature: must collapse whitespace + trim before hashing.
export function add(a: number,
                    b: number): number {
  return a + b;
}

// Generics + default parameter value + varargs (rest param).
export function reduceSum<T>(items: T[],
                            seed: number = 0,
                            ...extra: number[]): number {
  let total = seed;
  for (const _ of items) {
    total = add(total, 1);
  }
  return clamp(total, 0, 100);
}

export interface Point {
  x: number;
  y: number;
}

export class Vec2 {
  constructor(public p: Point) {}

  length(): number {
    return add(this.p.x, this.p.y);
  }
}
