package com.playport.server

import com.shilapi.xcertplay.transport.BlockingDuplexByteStream
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * A [BlockingDuplexByteStream] over a child process' standard input/output.
 *
 * Used for the Bluetooth bridge helper: the helper owns the RFCOMM channel and pipes its
 * bytes through stdin/stdout while this side speaks the iAP2 link.
 */
class ProcessByteStream(
    private val process: Process,
    private val label: String,
) : BlockingDuplexByteStream, Closeable {
    private val inbound = LinkedBlockingQueue<ByteArray>()
    private val input: InputStream = process.inputStream
    private val output: OutputStream = process.outputStream
    private val writeLock = Any()
    @Volatile private var ended = false

    init {
        Thread({ pump() }, "$label-reader").apply {
            isDaemon = true
            start()
        }
        Thread({ drainErrors() }, "$label-stderr").apply {
            isDaemon = true
            start()
        }
    }

    private fun pump() {
        val buffer = ByteArray(8192)
        try {
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) inbound.put(buffer.copyOf(count))
            }
        } catch (_: Exception) {
            // Falls through to the end marker.
        } finally {
            ended = true
            inbound.offer(ByteArray(0))
        }
    }

    private fun drainErrors() {
        val logger = org.slf4j.LoggerFactory.getLogger("bt-bridge")
        try {
            process.errorStream.bufferedReader().forEachLine { line ->
                if (line.isNotBlank()) logger.info("$label: $line")
            }
        } catch (_: Exception) {
        }
    }

    override fun send(data: ByteArray) {
        synchronized(writeLock) {
            output.write(data)
            output.flush()
        }
    }

    override fun recv(maxBytes: Int, timeoutMillis: Long): ByteArray? {
        val chunk = if (timeoutMillis == Long.MAX_VALUE) {
            inbound.take()
        } else {
            inbound.poll(timeoutMillis, TimeUnit.MILLISECONDS) ?: return null
        }
        if (chunk.isEmpty()) {
            if (ended) return ByteArray(0)
            return recv(maxBytes, timeoutMillis)
        }
        if (chunk.size <= maxBytes) return chunk
        // Push the remainder back for the next call.
        inbound.put(chunk.copyOfRange(maxBytes, chunk.size))
        return chunk.copyOf(maxBytes)
    }

    override fun close() {
        runCatching { output.close() }
        runCatching { input.close() }
        process.destroy()
    }
}
