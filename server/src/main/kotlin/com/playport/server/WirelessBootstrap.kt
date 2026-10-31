package com.playport.server

import com.shilapi.xcertplay.iap2.session.Iap2Session
import com.shilapi.xcertplay.mfi.Iap2MfiAuthenticationClient
import com.shilapi.xcertplay.transport.Iap2IdentificationConfig
import com.shilapi.xcertplay.transport.Iap2WirelessCarPlayEndpoint
import com.shilapi.xcertplay.transport.Iap2WirelessControlClient
import com.shilapi.xcertplay.transport.Iap2WirelessControlTerminal
import com.shilapi.xcertplay.transport.Iap2WirelessIdentification
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import org.slf4j.LoggerFactory

/**
 * Wireless CarPlay bring-up: Bluetooth RFCOMM iAP2 bootstrap, Wi-Fi credentials handoff and the
 * tunneled iAP2 handover.
 *
 * Requires the platform's bt-bridge helper (macos/bt-bridge or linux/bt-bridge) with the iPhone
 * already paired, and the server on the network the phone's Wi-Fi reaches.
 */
class WirelessBootstrap(private val server: CarPlayServer) : Closeable {
    private val log = LoggerFactory.getLogger("wireless")
    @Volatile private var bridgeProcess: ProcessByteStream? = null
    @Volatile private var stopped = false
    @Volatile var running = false
        private set

    fun start() {
        Thread(::run, "wireless-bootstrap").apply {
            isDaemon = true
            start()
        }
    }

    private fun run() {
        running = true
        try {
            val config = server.config
            val wifi = WifiInfo.detect(config)
            if (wifi == null) {
                log.warn(
                    "wireless bootstrap skipped: no Wi-Fi network detected. " +
                        "Pass the Wi-Fi the iPhone should use: " +
                        "--wifi-ssid \"<name>\" --wifi-passphrase \"<password>\" " +
                        "(automatic detection only works on macOS, which hides the SSID from processes without Location Services permission).",
                )
                return
            }
            if (!wifi.ssid.isNullOrBlank() && config.wifiPassphrase.isNullOrBlank()) {
                log.warn("no --wifi-passphrase configured; the phone must already know network {}", wifi.ssid)
            }
            val bridgePath = resolveBridgePath(config.bluetoothBridge)
            if (bridgePath == null) {
                log.warn(
                    "wireless bootstrap skipped: bt-bridge helper not found; " +
                        "build it with macos/bt-bridge/build.sh or linux/bt-bridge/build.sh, or pass --bt-bridge",
                )
                return
            }
            val deviceAddress = config.bluetoothDeviceAddress?.takeIf { it.isNotBlank() }
                ?: BluetoothBridge.findPairedIphone(bridgePath)
            if (deviceAddress == null) {
                log.warn("wireless bootstrap skipped: no paired iPhone found; pass --bt-address AA:BB:CC:DD:EE:FF")
                return
            }
            val hostBluetoothMac = BluetoothBridge.localAddress(bridgePath) ?: server.deviceId
            log.info("wireless bootstrap: iPhone={} hostBt={} wifi={} ch={}", deviceAddress, hostBluetoothMac, wifi.ssid, wifi.channel)

            val stream = BluetoothBridge.open(bridgePath, deviceAddress).also { bridgeProcess = it }
            val channel = Iap2Session.openWireless(stream, traceContext = "wireless-rfcomm", onTrace = { log.debug(it) })
            log.info("wireless iAP2 CSM channel opened over RFCOMM")

            val identification = Iap2IdentificationConfig(
                name = server.config.deviceName,
                modelIdentifier = server.config.model,
                manufacturer = server.config.manufacturer,
                serialNumber = "CARPLAYWEB-" + server.deviceId.replace(":", ""),
                firmwareVersion = "1.0.0",
                hardwareVersion = "1.0",
                wireless = Iap2WirelessIdentification(hostBluetoothMac, wifi.ssid),
            )
            val endpoint = Iap2WirelessCarPlayEndpoint(
                ssid = wifi.ssid,
                passphrase = config.wifiPassphrase.orEmpty(),
                channel = wifi.channel,
                security = config.wifiSecurity,
                ipAddresses = listOf(server.bindAddress.hostAddress),
                airPlayPort = config.airPlayPort,
                deviceIdentifier = server.deviceId,
                publicKey = server.identity.publicKeyHex,
                sourceVersion = config.sourceVersion,
            )
            server.media.setIapTunnelHandler { tunnelStream ->
                server.handleWirelessTunnel(tunnelStream, identification, endpoint)
            }
            val result = Iap2WirelessControlClient(
                session = channel,
                mfi = Iap2MfiAuthenticationClient(server.mfi),
            ).run(
                identification = identification,
                endpoint = endpoint,
                timeoutMillis = Iap2WirelessControlClient.NO_TIMEOUT_MILLIS,
                onReady = { log.info("wireless bootstrap accepted by the iPhone; waiting for the Wi-Fi handoff") },
                onProgress = { log.debug("wireless $it") },
            )
            if (!stopped) {
                when (result.terminal) {
                    Iap2WirelessControlTerminal.CHANNEL_CLOSED ->
                        log.info(
                            "wireless RFCOMM channel closed stage={} handoffSeen={}",
                            result.stage,
                            result.wirelessCarPlayAvailableSeen,
                        )
                    Iap2WirelessControlTerminal.TIMED_OUT -> log.info("wireless bootstrap timed out")
                }
            }
        } catch (error: Exception) {
            if (!stopped) log.warn("wireless bootstrap failed: {}", error.message)
        } finally {
            running = false
        }
    }

    private fun resolveBridgePath(configured: Path?): Path? {
        val candidates = listOfNotNull(
            configured,
            Path.of("macos/bt-bridge/bt-bridge"),
            Path.of("macos/bt-bridge/.build/bt-bridge"),
            Path.of("linux/bt-bridge/bt-bridge"),
        )
        return candidates.firstOrNull { Files.isExecutable(it) }
    }

    override fun close() {
        stopped = true
        running = false
        bridgeProcess?.close()
        bridgeProcess = null
    }
}

/** Helpers around the platform's bt-bridge executable. */
object BluetoothBridge {
    private val log = LoggerFactory.getLogger("bt-bridge")

    fun localAddress(bridgePath: Path): String? = runCatching {
        val process = ProcessBuilder(bridgePath.toString(), "--print-address").start()
        val output = process.inputStream.bufferedReader().readText().trim()
        process.waitFor()
        output.takeIf { it.matches(Regex("[0-9A-Fa-f:]{17}")) }
    }.getOrNull()

    fun findPairedIphone(bridgePath: Path): String? = runCatching {
        val process = ProcessBuilder(bridgePath.toString(), "--list").start()
        val lines = process.inputStream.bufferedReader().readLines()
        process.waitFor()
        lines.firstOrNull { it.contains("iphone", ignoreCase = true) }
            ?.substringBefore(' ')
            ?.trim()
            ?.takeIf { it.matches(Regex("[0-9A-Fa-f:]{17}")) }
    }.onFailure { log.warn("paired-device lookup failed: {}", it.message) }
        .getOrNull()

    fun open(bridgePath: Path, deviceAddress: String): ProcessByteStream {
        val process = ProcessBuilder(bridgePath.toString(), "--address", deviceAddress)
            .redirectErrorStream(false)
            .start()
        return ProcessByteStream(process, "bt-bridge")
    }
}
