package com.shilapi.xcertplay.airplay

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class AirPlayKeyboardTest {
    @Test
    fun keyReportCarriesTheKeyAndNoModifiers() {
        assertArrayEquals(
            byteArrayOf(0, 0, 0x2a, 0, 0, 0, 0, 0),
            AirPlayHid.keyboardReport(0x2a),
        )
    }

    @Test
    fun keyCodeZeroIsAnEmptyReport() {
        assertArrayEquals(ByteArray(8), AirPlayHid.keyboardReport(0))
    }

    @Test
    fun keyboardIsAdvertisedAfterTheExistingInputDevices() {
        val info = AirPlayInfoPlist.build(
            AirPlayConfig(
                deviceName = "test",
                deviceId = "02:00:00:00:00:02",
                btMac = "02:00:00:00:00:02",
                sourceVersion = "366.0",
                main = AirPlayDisplayConfig(widthPixels = 1280, heightPixels = 720),
            ),
        )

        @Suppress("UNCHECKED_CAST")
        val devices = info["hidDevices"] as List<Map<String, Any?>>
        assertEquals(
            listOf("2a2a2a2a", "2a2a2a2b", "2a2a2a2c", "2a2a2a2d", "2a2a2a2e"),
            devices.map { it["uuid"] },
        )
        val descriptor = devices.last()["hidDescriptor"] as ByteArray
        assertArrayEquals(
            "Generic Desktop page, Keyboard usage",
            byteArrayOf(0x05, 0x01, 0x09, 0x06),
            descriptor.copyOf(4),
        )
    }
}
