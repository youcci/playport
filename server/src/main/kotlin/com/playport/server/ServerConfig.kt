package com.playport.server

import com.shilapi.xcertplay.transport.Iap2WirelessSecurity
import java.nio.file.Path
import java.security.SecureRandom

/** Static server configuration, assembled from CLI flags, environment and defaults. */
data class ServerConfig(
    val deviceName: String = "PlayPort",
    val model: String = "playport",
    val manufacturer: String = "playport",
    val sourceVersion: String = "366.0",
    val airPlayPort: Int = 7000,
    val httpPort: Int = 8080,
    val displayWidth: Int = 1280,
    val displayHeight: Int = 720,
    val displayFps: Int = 60,
    val uiScale: Int = com.shilapi.xcertplay.airplay.CarPlayUiScale.DEFAULT,
    val hevc: Boolean = false,
    val rightHandDrive: Boolean = false,
    val bindAddress: String? = null,
    val identityDir: Path,
    val stateDir: Path,
    val mfiRemoteServer: String? = null,
    val mfiRemoteToken: String? = null,
    val wireless: Boolean = false,
    val wifiSsid: String? = null,
    val wifiPassphrase: String? = null,
    val wifiChannel: Int = 0,
    val wifiSecurity: Iap2WirelessSecurity = Iap2WirelessSecurity.WPA_WPA2,
    val bluetoothDeviceAddress: String? = null,
    val bluetoothBridge: Path? = null,
    val mdns: String = "auto",
    val insecureHttp: Boolean = false,
    val accessToken: String = generateToken(),
) {
    val mfiDirectory: Path get() = identityDir.resolve("offline-mfi")

    companion object {
        private const val TOKEN_BYTES = 16

        fun generateToken(): String {
            val bytes = ByteArray(TOKEN_BYTES).also(SecureRandom()::nextBytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }

        /** Parses `--flag value` / `--flag=value` CLI arguments over the given defaults. */
        fun fromArgs(args: Array<String>, defaults: ServerConfig): ServerConfig {
            var config = defaults
            var index = 0
            fun nextValue(flag: String): String {
                val inline = args[index].substringAfter('=', "")
                if (inline.isNotEmpty()) return inline
                index++
                require(index < args.size) { "$flag requires a value" }
                return args[index]
            }
            while (index < args.size) {
                val arg = args[index]
                if (!arg.startsWith("--")) {
                    index++
                    continue
                }
                val flag = arg.substringBefore('=')
                when (flag) {
                    "--device-name" -> config = config.copy(deviceName = nextValue(flag))
                    "--model" -> config = config.copy(model = nextValue(flag))
                    "--manufacturer" -> config = config.copy(manufacturer = nextValue(flag))
                    "--airplay-port" -> config = config.copy(airPlayPort = nextValue(flag).toInt())
                    "--http-port" -> config = config.copy(httpPort = nextValue(flag).toInt())
                    "--width" -> config = config.copy(displayWidth = nextValue(flag).toInt())
                    "--height" -> config = config.copy(displayHeight = nextValue(flag).toInt())
                    "--fps" -> config = config.copy(displayFps = nextValue(flag).toInt())
                    "--ui-scale" -> config = config.copy(uiScale = com.shilapi.xcertplay.airplay.CarPlayUiScale.sanitize(nextValue(flag).toInt()))
                    "--hevc" -> config = config.copy(hevc = true)
                    "--rhd" -> config = config.copy(rightHandDrive = true)
                    "--bind" -> config = config.copy(bindAddress = nextValue(flag))
                    "--identity-dir" -> config = config.copy(identityDir = Path.of(nextValue(flag)))
                    "--state-dir" -> config = config.copy(stateDir = Path.of(nextValue(flag)))
                    "--mfi-server" -> config = config.copy(mfiRemoteServer = nextValue(flag))
                    "--mfi-token" -> config = config.copy(mfiRemoteToken = nextValue(flag))
                    "--wireless" -> config = config.copy(wireless = true)
                    "--wifi-ssid" -> config = config.copy(wifiSsid = nextValue(flag))
                    "--wifi-passphrase" -> config = config.copy(wifiPassphrase = nextValue(flag))
                    "--wifi-channel" -> config = config.copy(wifiChannel = nextValue(flag).toInt())
                    "--wifi-security" -> config = config.copy(
                        wifiSecurity = when (nextValue(flag).lowercase()) {
                            "open" -> Iap2WirelessSecurity.NONE
                            "wpa" -> Iap2WirelessSecurity.WPA_WPA2
                            "wpa2" -> Iap2WirelessSecurity.WPA_WPA2
                            "wpa3" -> Iap2WirelessSecurity.WPA3_ONLY
                            else -> Iap2WirelessSecurity.WPA_WPA2
                        },
                    )
                    "--bt-address" -> config = config.copy(bluetoothDeviceAddress = nextValue(flag))
                    "--bt-bridge" -> config = config.copy(bluetoothBridge = Path.of(nextValue(flag)))
                    "--mdns" -> config = config.copy(mdns = nextValue(flag).lowercase())
                    "--http" -> config = config.copy(insecureHttp = true)
                    "--token" -> config = config.copy(accessToken = nextValue(flag))
                    "--help" -> {
                        printUsage()
                        kotlin.system.exitProcess(0)
                    }
                }
                index++
            }
            return config
        }

        fun printUsage() {
            println(
                """
                playport server

                Usage: ./gradlew :server:run --args="[options]"

                Options:
                  --device-name <name>      AirPlay device name shown on the iPhone (default: playport)
                  --model <model>           AirPlay model string (default: playport)
                  --manufacturer <name>     Manufacturer string (default: playport)
                  --airplay-port <port>     AirPlay RTSP port (default: 7000)
                  --http-port <port>        Web UI / WebSocket port (default: 8080)
                  --width <px>              Display width negotiated with the phone (default: 1280)
                  --height <px>             Display height negotiated with the phone (default: 720)
                  --fps <n>                 Display refresh rate (default: 60)
                  --ui-scale <75|85|100|115>  CarPlay control size: larger canvas, smaller controls (default: 100)
                  --hevc                    Offer H.265/HEVC video (sharper at the same bitrate; browser must support it)
                  --rhd                     Right-hand-drive layout
                  --bind <address>          Bind address (default: auto-detect LAN address)
                  --identity-dir <path>     Directory containing offline-mfi/ (default: ./identity)
                  --state-dir <path>        AirPlay identity + pairing state (default: ~/.playport)
                  --mfi-server <url>        Remote MFi server address (alternative to offline identity)
                  --mfi-token <token>       Remote MFi bearer token
                  --wireless                Enable the Bluetooth wireless bootstrap
                  --wifi-ssid <ssid>        Wi-Fi network the phone should join (default: auto-detect)
                  --wifi-passphrase <pass>  Wi-Fi passphrase handed to the phone
                  --wifi-channel <n>        Wi-Fi channel (default: 0 = unknown)
                  --wifi-security <mode>    open | wpa | wpa2 (default: wpa2)
                  --bt-address <mac>        iPhone Bluetooth address for the wireless bootstrap
                  --bt-bridge <path>        Path to the bt-bridge helper
                  --mdns <backend>          auto | dns-sd | jmdns (default: auto)
                  --http                    Serve the UI over plain HTTP (WebCodecs then only works on localhost)
                  --token <token>           Browser access token (default: generated per start)
                """.trimIndent(),
            )
        }
    }
}
