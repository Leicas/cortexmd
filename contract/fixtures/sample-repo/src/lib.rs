//! Rust fixture: generics, multi-line signature, cross-module call.

mod helper;

use helper::clamp;

/// Generic, multi-line signature: collapsed before hashing.
pub fn reduce_sum<T>(
    items: &[T],
    seed: i64,
) -> i64 {
    let mut total = seed;
    for _ in items {
        total = add(total, 1);
    }
    clamp(total, 0, 100)
}

pub fn add(a: i64, b: i64) -> i64 {
    a + b
}

pub struct Vec2 {
    pub x: i64,
    pub y: i64,
}

impl Vec2 {
    pub fn length(&self) -> i64 {
        add(self.x, self.y)
    }
}
