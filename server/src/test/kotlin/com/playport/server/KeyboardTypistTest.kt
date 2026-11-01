package com.playport.server

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class KeyboardTypistTest {
    private val sent = mutableListOf<Int>()
    private val typist = KeyboardTypist(send = { sent += it }, pause = {})

    private fun typeAll() {
        while (typist.typeNext()) Unit
    }

    @Test
    fun pressesAndReleasesEachKeyInOrder() {
        typist.offer(listOf(0x04, 0x05))
        typeAll()
        assertEquals(listOf(0x04, 0, 0x05, 0), sent)
    }

    @Test
    fun acceptsEveryKeyTheViewerSends() {
        val plain = (0x04..0x28) + 0x2a + (0x2c..0x31) + (0x33..0x38)
        typist.offer(plain)
        typeAll()
        assertEquals(plain, sent.filterIndexed { index, _ -> index % 2 == 0 })
    }

    @Test
    fun ignoresAnythingElseIncludingModifiers() {
        typist.offer(listOf(0xe1, 0xe2, 0x29, 0x2b, 0x32, 0x39, 0, 3, -1, 256 + 0x04))
        assertFalse(typist.typeNext())
        assertEquals(emptyList<Int>(), sent)
    }

    @Test
    fun dropsKeysBeyondThePendingLimit() {
        typist.offer(List(MAX_PENDING_KEYS + 5) { 0x04 })
        typeAll()
        assertEquals(MAX_PENDING_KEYS * 2, sent.size)
    }

    @Test
    fun clearForgetsPendingKeys() {
        typist.offer(listOf(0x04, 0x05))
        typist.clear()
        assertFalse(typist.typeNext())
    }

    @Test
    fun clientMessageCarriesKeys() {
        val json = Json { ignoreUnknownKeys = true }
        val message = json.decodeFromString(ClientMessage.serializer(), """{"type":"keys","keys":[4,40]}""")
        assertEquals(listOf(4, 40), message.keys)
    }
}
