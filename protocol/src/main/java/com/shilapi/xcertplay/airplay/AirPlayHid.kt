package com.shilapi.xcertplay.airplay

/** One normalized touch contact (0..1 coordinates). */
data class AirPlayContact(
    val id: Int,
    val x: Double,
    val y: Double,
    val down: Boolean,
)

/** Momentary knob/button state for the head-unit rotary controller. */
data class AirPlayKnobState(
    val select: Boolean = false,
    val home: Boolean = false,
    val back: Boolean = false,
    val x: Int = 0,
    val y: Int = 0,
    val wheel: Int = 0,
)

/** CarPlay HID device descriptors and report encoders. */
object AirPlayHid {
    const val TOUCH_HID_UID = 0x2a2a2a2a
    const val KNOB_HID_UID = 0x2a2a2a2b
    const val MEDIA_HID_UID = 0x2a2a2a2c
    const val TELEPHONY_HID_UID = 0x2a2a2a2d
    const val KEYBOARD_HID_UID = 0x2a2a2a2e

    private const val TOUCH_CONTACTS = 2
    private const val BYTES_PER_FINGER = 6

    fun touchHidDevice(xMax: Int, yMax: Int, displayUuid: String): Map<String, Any?> =
        hidDeviceEntry(TOUCH_HID_UID, "xcertplay Touchscreen", multitouchDescriptor(xMax, yMax), displayUuid)

    fun knobHidDevice(displayUuid: String): Map<String, Any?> =
        hidDeviceEntry(KNOB_HID_UID, "xcertplay Knob", knobDescriptor, displayUuid)

    fun mediaHidDevice(displayUuid: String): Map<String, Any?> =
        hidDeviceEntry(MEDIA_HID_UID, "xcertplay Media", mediaDescriptor, displayUuid)

    fun telephonyHidDevice(displayUuid: String): Map<String, Any?> =
        hidDeviceEntry(TELEPHONY_HID_UID, "xcertplay Telephony", telephonyDescriptor, displayUuid)

    fun keyboardHidDevice(displayUuid: String): Map<String, Any?> =
        hidDeviceEntry(KEYBOARD_HID_UID, "xcertplay Keyboard", keyboardDescriptor, displayUuid)

    /** Modifiers stay empty: iOS keeps them held after their release, so only plain keys are sent. */
    fun keyboardReport(keyCode: Int): ByteArray =
        byteArrayOf(0, 0, keyCode.toByte(), 0, 0, 0, 0, 0)

    fun touchReport(contacts: List<AirPlayContact>): ByteArray {
        val report = ByteArray(BYTES_PER_FINGER * TOUCH_CONTACTS)
        for (slot in 0 until TOUCH_CONTACTS) {
            val offset = slot * BYTES_PER_FINGER
            report[offset] = slot.toByte()
            val contact = contacts.getOrNull(slot) ?: continue
            report[offset + 1] = if (contact.down) 0x01 else 0x00
            writeU16Le(report, offset + 2, Math.round(contact.x.coerceAtLeast(0.0)).toInt())
            writeU16Le(report, offset + 4, Math.round(contact.y.coerceAtLeast(0.0)).toInt())
        }
        return report
    }

    fun knobReport(state: AirPlayKnobState): ByteArray {
        val report = ByteArray(4)
        report[0] = (
            (if (state.select) 0x01 else 0) or
                (if (state.home) 0x02 else 0) or
                (if (state.back) 0x04 else 0)
            ).toByte()
        report[1] = clampAxis(state.x)
        report[2] = clampAxis(state.y)
        report[3] = clampAxis(state.wheel)
        return report
    }

    fun mediaReport(index: Int): ByteArray = byteArrayOf(index.toByte())

    fun telephonyReport(index: Int): ByteArray = byteArrayOf(index.toByte())

    private fun hidDeviceEntry(
        uid: Int,
        name: String,
        descriptor: ByteArray,
        displayUuid: String,
    ): Map<String, Any?> = linkedMapOf(
        "hidProductID" to 1L,
        "hidVendorID" to 2L,
        "hidCountryCode" to 0L,
        "uuid" to uid.toString(16),
        "name" to name,
        "displayUUID" to displayUuid,
        "hidDescriptor" to descriptor,
    )

    private fun multitouchDescriptor(xMax: Int, yMax: Int): ByteArray {
        val bytes = ArrayList<Int>()
        bytes.addAll(intArrayOf(0x05, 0x0d, 0x09, 0x04, 0xa1, 0x01).toList())
        repeat(TOUCH_CONTACTS) { bytes.addAll(fingerCollection(xMax, yMax).toList()) }
        bytes.add(0xc0)
        return bytes.map { it.toByte() }.toByteArray()
    }

    private fun fingerCollection(xMax: Int, yMax: Int): IntArray = intArrayOf(
        0x05, 0x0d, 0x09, 0x22, 0xa1, 0x02,
        0x09, 0x38, 0x75, 0x08, 0x95, 0x01, 0x81, 0x02,
        0x15, 0x00, 0x25, 0x01, 0x09, 0x33, 0x75, 0x01, 0x95, 0x01, 0x81, 0x02,
        0x95, 0x07, 0x81, 0x03,
        0x05, 0x01, 0x26, xMax and 0xff, (xMax shr 8) and 0xff, 0x09, 0x30, 0x75, 0x10, 0x95, 0x01, 0x81, 0x02,
        0x26, yMax and 0xff, (yMax shr 8) and 0xff, 0x09, 0x31, 0x81, 0x02, 0xc0,
    )

    private val knobDescriptor = descriptor(
        0x05, 0x01, 0x09, 0x08, 0xa1, 0x01,
        0x05, 0x09, 0x09, 0x01, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x01, 0x81, 0x02,
        0x05, 0x0c, 0x0a, 0x23, 0x02, 0x0a, 0x24, 0x02, 0x95, 0x02, 0x81, 0x02,
        0x95, 0x05, 0x81, 0x01,
        0x05, 0x01, 0x09, 0x01, 0xa1, 0x00,
        0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x02, 0x81, 0x02, 0xc0,
        0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x01, 0x81, 0x06, 0xc0,
    )

    private val mediaDescriptor = descriptor(
        0x05, 0x0c, 0x09, 0x01, 0xa1, 0x01,
        0x15, 0x00, 0x25, 0x06, 0x05, 0x0c,
        0x0a, 0x00, 0x00, 0x0a, 0xb0, 0x00, 0x0a, 0xb1, 0x00, 0x0a, 0xcd, 0x00,
        0x0a, 0xb5, 0x00, 0x0a, 0xb6, 0x00, 0x0a, 0x9e, 0x02,
        0x75, 0x08, 0x95, 0x01, 0x81, 0x00, 0xc0,
    )

    private val telephonyDescriptor = descriptor(
        0x05, 0x0b, 0x09, 0x07, 0xa1, 0x01,
        0x15, 0x00, 0x25, 0x11, 0x05, 0x0b,
        0x09, 0x00, 0x09, 0x20, 0x09, 0x21, 0x09, 0x26, 0x09, 0x2f,
        0x09, 0xb0, 0x09, 0xb1, 0x09, 0xb2, 0x09, 0xb3, 0x09, 0xb4, 0x09, 0xb5,
        0x09, 0xb6, 0x09, 0xb7, 0x09, 0xb8, 0x09, 0xb9, 0x09, 0xba, 0x09, 0xbb,
        0x05, 0x07, 0x09, 0x2a,
        0x75, 0x08, 0x95, 0x01, 0x81, 0x00, 0xc0,
    )

    /** Standard USB boot keyboard: modifiers, a reserved byte and six key codes. */
    private val keyboardDescriptor = descriptor(
        0x05, 0x01, 0x09, 0x06, 0xa1, 0x01,
        0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
        0x95, 0x01, 0x75, 0x08, 0x81, 0x01,
        0x95, 0x06, 0x75, 0x08, 0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00,
        0xc0,
    )

    private fun descriptor(vararg bytes: Int): ByteArray = ByteArray(bytes.size) { bytes[it].toByte() }

    private fun clampAxis(value: Int): Byte = value.coerceIn(-127, 127).toByte()

    private fun writeU16Le(target: ByteArray, offset: Int, value: Int) {
        target[offset] = (value and 0xff).toByte()
        target[offset + 1] = ((value ushr 8) and 0xff).toByte()
    }
}
