package com.playport.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworksTest {
    @Test
    fun keepsRealInterfaces() {
        listOf("eno1", "wlp9s0", "en0", "br0").forEach {
            assertFalse(it, Networks.isVirtualInterfaceName(it))
        }
    }

    @Test
    fun skipsVirtualInterfaces() {
        listOf(
            "docker0", "br-5a39bebad8d8", "veth1234", "virbr0",
            "utun3", "awdl0", "llw0", "bridge100", "ap1", "DOCKER0",
        ).forEach {
            assertTrue(it, Networks.isVirtualInterfaceName(it))
        }
    }
}
