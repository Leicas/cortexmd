package com.example

import com.example.foo.Bar

class Greeter(val name: String) {
    fun hello(): String {
        return "hi"
    }
}

object Singleton {
    fun instance() {}
}

fun topLevel(x: Int): Int {
    return x + 1
}
