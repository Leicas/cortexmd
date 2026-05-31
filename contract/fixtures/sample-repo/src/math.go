// Go fixture: multi-line signature, variadic params, cross-symbol call.
package sample

// Multi-line signature + variadic param (Go's varargs).
func ReduceSum(
	seed int,
	items ...int,
) int {
	total := seed
	for range items {
		total = Add(total, 1)
	}
	return Clamp(total, 0, 100)
}

func Add(a int, b int) int {
	return a + b
}

func Clamp(value int, lo int, hi int) int {
	if value < lo {
		return lo
	}
	if value > hi {
		return hi
	}
	return value
}
