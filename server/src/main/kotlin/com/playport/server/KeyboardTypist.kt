package com.playport.server

import java.io.Closeable
import java.util.concurrent.LinkedBlockingQueue
import org.slf4j.LoggerFactory

/** Most keys waiting to be typed; matches the viewer's paste limit. */
internal const val MAX_PENDING_KEYS = 1_000

private const val KEY_PAUSE_MILLIS = 10L

/**
 * Types keys into CarPlay one at a time, so a long paste doesn't hold up other input.
 *
 * Only plain keys get through. iOS keeps Shift, Option and the like held after their release, which
 * would corrupt everything typed after them until the session restarts.
 */
internal class KeyboardTypist(
    private val send: (Int) -> Unit,
    private val pause: () -> Unit = { Thread.sleep(KEY_PAUSE_MILLIS) },
) : Closeable {
    private val log = LoggerFactory.getLogger("keyboard")
    private val pending = LinkedBlockingQueue<Int>(MAX_PENDING_KEYS)
    @Volatile private var worker: Thread? = null

    fun offer(keys: List<Int>) {
        keys.filter(::isPlainKey).forEach { pending.offer(it) }
    }

    fun clear() = pending.clear()

    /** Types the next pending key, if there is one. */
    fun typeNext(): Boolean {
        val key = pending.poll() ?: return false
        type(key)
        return true
    }

    fun start() {
        worker = Thread(::run, "keyboard-typist").apply {
            isDaemon = true
            start()
        }
    }

    override fun close() {
        worker?.interrupt()
        worker = null
        clear()
    }

    private fun run() {
        try {
            while (true) {
                val key = pending.take()
                try {
                    type(key)
                } catch (error: RuntimeException) {
                    log.warn("could not type a key: {}", error.message)
                }
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    private fun type(key: Int) {
        send(key)
        pause()
        send(0)
        pause()
    }

    private fun isPlainKey(code: Int): Boolean =
        code in 0x04..0x28 || code == 0x2a || code in 0x2c..0x31 || code in 0x33..0x38
}
