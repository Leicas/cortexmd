"""Python fixture: default args, *args/**kwargs varargs, multi-line signature."""


def clamp(value, lo=0, hi=1):
    """Clamp value into [lo, hi]."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def reduce_sum(items,
               seed=0,
               *extra,
               **opts):
    total = seed
    for _ in items:
        total = total + 1
    return clamp(total, 0, 100)


class Vec2:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def length(self):
        return reduce_sum([self.x, self.y])
