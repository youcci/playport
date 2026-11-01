package com.playport.server

import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketException

/** LAN address discovery for mDNS advertisement and the AirPlay RTSP bind. */
object Networks {
    fun detectLanAddress(): InetAddress {
        val candidates = mutableListOf<InetAddress>()
        try {
            NetworkInterface.getNetworkInterfaces().toList().forEach { iface ->
                if (!iface.isUp || iface.isLoopback || iface.isPointToPoint) return@forEach
                if (isVirtualInterfaceName(iface.name)) return@forEach
                iface.inetAddresses.toList().forEach { address ->
                    if (address is Inet4Address && !address.isLoopbackAddress && !address.isLinkLocalAddress) {
                        candidates.add(address)
                    }
                }
            }
        } catch (error: SocketException) {
            throw IllegalStateException("No usable network interface: ${error.message}", error)
        }
        return candidates.firstOrNull() ?: InetAddress.getLoopbackAddress()
    }

    /** Tunnel, AirDrop, hotspot and container interfaces never carry the LAN the phone joins. */
    fun isVirtualInterfaceName(name: String): Boolean {
        val lower = name.lowercase()
        return VIRTUAL_PREFIXES.any { lower.startsWith(it) }
    }

    private val VIRTUAL_PREFIXES = listOf(
        "utun", "awdl", "llw", "bridge", "ap1", "docker", "br-", "veth", "virbr",
    )

    fun resolve(bindAddress: String?): InetAddress =
        if (bindAddress.isNullOrBlank()) detectLanAddress() else InetAddress.getByName(bindAddress)
}
