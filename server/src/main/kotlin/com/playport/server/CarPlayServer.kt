package com.playport.server

import com.shilapi.xcertplay.airplay.AirPlayConfig
import com.shilapi.xcertplay.airplay.AirPlayContact
import com.shilapi.xcertplay.airplay.AirPlayDeviceInfo
import com.shilapi.xcertplay.airplay.AirPlayDisplayConfig
import com.shilapi.xcertplay.airplay.AirPlayKnobState
import com.shilapi.xcertplay.airplay.AirPlayMediaHandler
import com.shilapi.xcertplay.airplay.AirPlaySession
import com.shilapi.xcertplay.airplay.AirPlaySessionListener
import com.shilapi.xcertplay.airplay.CarPlayMediaEngine
import com.shilapi.xcertplay.airplay.PairingStore
import com.shilapi.xcertplay.mfi.MfiAuthenticator
import com.shilapi.xcertplay.transport.BlockingDuplexByteStream
import com.shilapi.xcertplay.transport.Iap2WirelessCarPlayEndpoint
import com.shilapi.xcertplay.transport.Iap2WirelessControlClient
import com.shilapi.xcertplay.transport.Iap2WirelessControlTerminal
import com.shilapi.xcertplay.transport.Iap2IdentificationConfig
import com.shilapi.xcertplay.mfi.Iap2MfiAuthenticationClient
import com.shilapi.xcertplay.iap2.session.Iap2Session
import java.io.Closeable
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean
import org.slf4j.LoggerFactory

/**
 * The desktop CarPlay receiver: RTSP listener, mDNS advertisement, media bridge to browsers and
 * (optionally) the wireless Bluetooth bootstrap.
 */
class CarPlayServer(val config: ServerConfig, private val configStore: ConfigStore? = null) : Closeable {
    private val log = LoggerFactory.getLogger("playport")

    val identity = AirPlayIdentityStore.loadOrCreate(config.stateDir)
    val deviceId: String = AirPlayIdentityStore.deviceId(identity)
    val bindAddress: InetAddress = Networks.resolve(config.bindAddress)

    val display = DisplayState(
        config.displayWidth,
        config.displayHeight,
        config.displayFps,
        config.uiScale,
        config.hevc,
    )
    val hub = WebHub(config, display)
    val bridge = WebBridge(hub)
    val media = CarPlayMediaEngine(bridge, microphoneEnabled = true, audioCaptureDirectory = null)

    private val pairings = loadPairings()
    val mfi: MfiAuthenticator by lazy { MfiIdentity.load(config) }

    @Volatile private var activeSession: AirPlaySession? = null
    @Volatile private var serverSocket: ServerSocket? = null
    @Volatile private var advertiser: ServiceAdvertiser? = null
    @Volatile private var wireless: WirelessBootstrap? = null
    @Volatile private var lastBootstrapAt = System.currentTimeMillis()
    @Volatile private var bootstrapStale = false
    private val typist = KeyboardTypist(send = { activeSession?.sendKeyboard(it) })
    private val closed = AtomicBoolean(false)

    val airPlayConfig: AirPlayConfig
        get() = AirPlayConfig(
            deviceName = config.deviceName,
            deviceId = deviceId,
            btMac = deviceId,
            sourceVersion = config.sourceVersion,
            main = com.shilapi.xcertplay.airplay.CarPlayUiScale.apply(
                AirPlayDisplayConfig(
                    widthPixels = display.width,
                    heightPixels = display.height,
                    fps = display.fps,
                ),
                display.uiScale,
            ),
            rightHandDrive = config.rightHandDrive,
            port = config.airPlayPort,
            entertainmentSampleRate = 48_000,
            hevc = display.hevc,
            microphone = false,
            manufacturer = config.manufacturer,
            model = config.model,
            oemLabel = config.deviceName,
        )

    private val listener = object : AirPlaySessionListener {
        override fun onSessionActive(session: AirPlaySession) {
            log.info("CarPlay session active peer={}", session.host)
            activeSession = session
            bootstrapStale = false
            hub.setSessionState(true, null)
        }

        override fun onSessionEnded(session: AirPlaySession) {
            log.info("CarPlay session ended peer={}", session.host)
            if (activeSession === session) {
                activeSession = null
                bootstrapStale = true
            }
            typist.clear()
            bridge.endMicrophone()
            hub.setSessionState(false, null)
        }

        override fun onDeviceInfo(session: AirPlaySession, info: AirPlayDeviceInfo) {
            log.info("iPhone connected name={} model={} deviceId={}", info.name, info.model, info.deviceId)
            hub.setSessionState(true, info.name)
        }

        override fun onTransportError(message: String) {
            log.warn("AirPlay transport error: {}", message)
        }

        override fun onCommand(session: AirPlaySession, type: String, params: Map<String, Any?>) {
            log.debug("AirPlay command type={} params={}", type, params.keys.sorted().joinToString(","))
        }

        override fun onDebugLog(message: String) {
            log.debug(message)
        }
    }

    fun start() {
        hub.inputHandler = ::routeInput
        hub.onApplyDisplay = ::applyDisplay
        hub.onMicrophoneData = { opus, payload -> bridge.sendMicrophonePayload(payload, opus) }
        startSupervisor()
        typist.start()
        hub.onViewerJoined = { streamType ->
            if (bridge.hasRecoveryHandler) {
                log.info("requesting keyframe for stream {}", streamType)
                bridge.requestKeyFrame(streamType)
            }
        }
        startAirPlayListener()
        advertiser = Advertisers.create(config.mdns, airPlayConfig, identity, bindAddress).also { it.start() }
        if (config.wireless) {
            wireless = WirelessBootstrap(this).also { it.start() }
        }
    }

    private fun startAirPlayListener() {
        val server = ServerSocket()
        server.reuseAddress = true
        server.bind(InetSocketAddress(bindAddress, config.airPlayPort))
        serverSocket = server
        Thread({ acceptLoop(server) }, "airplay-accept").apply {
            isDaemon = true
            start()
        }
        log.info("AirPlay RTSP listening on {}:{}", bindAddress.hostAddress, config.airPlayPort)
    }

    private fun acceptLoop(server: ServerSocket) {
        while (!closed.get()) {
            val socket: Socket = try {
                server.accept()
            } catch (error: Exception) {
                if (closed.get()) return
                log.warn("AirPlay accept failed: {}", error.message)
                continue
            }
            try {
                socket.tcpNoDelay = true
                socket.keepAlive = true
                socket.setSoLinger(true, 0)
                log.info("AirPlay connection accepted from {}", socket.remoteSocketAddress)
                val session = AirPlaySession(
                    socket = socket,
                    config = airPlayConfig,
                    identity = identity,
                    pairings = pairings,
                    mfi = mfi,
                    listener = listener,
                    media = media,
                )
                activeSession = session
                session.start()
            } catch (error: Exception) {
                log.warn("AirPlay session bring-up failed: {}", error.message)
                runCatching { socket.close() }
            }
        }
    }

    private fun routeInput(message: ClientMessage) {
        val session = activeSession ?: return
        try {
            when (message.type) {
                "touch" -> session.sendTouch(
                    message.contacts.map { AirPlayContact(it.id, it.x, it.y, it.down) },
                )
                "media" -> message.media?.let(session::sendMedia)
                "knob" -> message.knob?.let {
                    session.sendKnob(
                        AirPlayKnobState(
                            select = it.select,
                            home = it.home,
                            back = it.back,
                            x = it.x,
                            y = it.y,
                            wheel = it.wheel,
                        ),
                    )
                }
                "siri" -> session.invokeSiri()
                "telephony" -> message.telephony?.let(session::sendTelephony)
                "night" -> message.night?.let(session::setNightMode)
                "keys" -> typist.offer(message.keys)
                "keysCancel" -> typist.clear()
            }
        } catch (error: Exception) {
            log.warn("Input routing failed type={}: {}", message.type, error.message)
        }
    }

    /** Opens the tunneled iAP2 link after the phone hands the session over to Wi-Fi. */
    fun handleWirelessTunnel(
        stream: BlockingDuplexByteStream,
        identification: Iap2IdentificationConfig,
        endpoint: Iap2WirelessCarPlayEndpoint,
    ): Boolean {
        log.info("wireless iAP2 tunnel accepted")
        val channel = try {
            Iap2Session.openTunnel(stream, traceContext = "wireless-tunnel", onTrace = { log.debug(it) })
        } catch (error: Exception) {
            log.warn("could not open tunneled iAP2 link: {}", error.message)
            return false
        }
        Thread(
            {
                try {
                    val result = Iap2WirelessControlClient(
                        session = channel,
                        mfi = Iap2MfiAuthenticationClient(mfi),
                    ).run(
                        identification = identification,
                        endpoint = endpoint,
                        timeoutMillis = Iap2WirelessControlClient.NO_TIMEOUT_MILLIS,
                        onReady = { log.info("wireless iAP2 tunnel ready; CarPlay is live") },
                        onProgress = { log.debug("iAP tunnel $it") },
                    )
                    when (result.terminal) {
                        Iap2WirelessControlTerminal.TIMED_OUT -> log.info("tunneled iAP2 control timed out")
                        Iap2WirelessControlTerminal.CHANNEL_CLOSED -> log.info("tunneled iAP2 channel closed")
                    }
                } catch (error: Exception) {
                    log.warn("tunneled iAP2 control failed: {}", error.message)
                }
            },
            "wireless-tunnel-control",
        ).apply {
            isDaemon = true
            start()
        }
        return true
    }

    /**
     * Watches the wireless link: if no CarPlay session is active and no bootstrap attempt is
     * running, re-invites the phone (covers the phone leaving and re-entering Wi-Fi, failed
     * handshakes and stale sessions).
     */
    private fun startSupervisor() {
        if (!config.wireless) return
        Thread(
            {
                while (!closed.get()) {
                    try {
                        Thread.sleep(SUPERVISOR_INTERVAL_MS)
                        if (closed.get() || !config.wireless) return@Thread
                        if (activeSession != null) {
                            lastBootstrapAt = System.currentTimeMillis()
                            continue
                        }
                        val sinceBootstrap = System.currentTimeMillis() - lastBootstrapAt
                        if (!shouldReinvite(false, wireless?.running == true, bootstrapStale, sinceBootstrap, BOOTSTRAP_COOLDOWN_MS)) continue
                        log.info("no CarPlay session; re-inviting the iPhone over Bluetooth/Wi-Fi")
                        restartWireless()
                    } catch (interrupted: InterruptedException) {
                        Thread.currentThread().interrupt()
                        return@Thread
                    } catch (error: Exception) {
                        log.warn("connection supervisor error: {}", error.message)
                    }
                }
            },
            "carplay-supervisor",
        ).apply {
            isDaemon = true
            start()
        }
    }

    /**
     * Applies a new display configuration and restarts CarPlay so the phone re-negotiates the
     * display. Returns null on success or a human-readable error.
     */
    fun applyDisplay(width: Int, height: Int, fps: Int, uiScale: Int, hevc: Boolean): String? {
        DisplayState.validate(width, height, fps)?.let { return it }
        display.update(width, height, fps, uiScale, hevc)
        configStore?.save(PersistentConfig.of(config, display))
        log.info(
            "display changed to {}x{} @{}fps uiScale={} codec={} ({}); restarting CarPlay",
            width, height, fps, display.uiScale, if (display.hevc) "h265" else "h264", display.orientation,
        )
        activeSession?.close()
        restartWireless()
        return null
    }

    private fun restartWireless() {
        if (!config.wireless) return
        lastBootstrapAt = System.currentTimeMillis()
        bootstrapStale = false
        val current = wireless
        wireless = null
        current?.close()
        Thread(
            {
                Thread.sleep(750)
                if (closed.get()) return@Thread
                wireless = WirelessBootstrap(this).also { it.start() }
            },
            "wireless-restart",
        ).apply {
            isDaemon = true
            start()
        }
    }

    fun statusLine(): String = buildString {
        append("device=").append(config.deviceName)
        append(" address=").append(bindAddress.hostAddress)
        append(" airplay=").append(config.airPlayPort)
        append(" http=").append(config.httpPort)
        append(" viewers=").append(if (activeSession != null) "1+session" else "0")
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        typist.close()
        runCatching { wireless?.close() }
        runCatching { advertiser?.close() }
        runCatching { activeSession?.close() }
        runCatching { serverSocket?.close() }
    }

    // Pair records survive restarts so the phone reconnects without pairing again.
    private fun loadPairings(): PairingStore {
        val file = config.stateDir.resolve("pairings.properties")
        val properties = Properties()
        if (Files.isRegularFile(file)) {
            runCatching { Files.newInputStream(file).use(properties::load) }
        }
        val store = PairingStore { identifier, key ->
            properties.setProperty(identifier, key.joinToString("") { "%02x".format(it) })
            runCatching {
                Files.createDirectories(config.stateDir)
                Files.newOutputStream(file).use { properties.store(it, "playport paired controllers") }
            }
        }
        properties.forEach { (identifier, value) ->
            val bytes = (value as? String)?.hexToBytes()
            if (bytes != null) store.save(identifier.toString(), bytes)
        }
        return store
    }

    private fun String.hexToBytes(): ByteArray? {
        if (length % 2 != 0) return null
        return try {
            ByteArray(length / 2) { index -> substring(index * 2, index * 2 + 2).toInt(16).toByte() }
        } catch (_: NumberFormatException) {
            null
        }
    }

    companion object {
        /** AirPlay pair-setup PIN advertised for first-time connections. */
        const val PAIRING_PIN = "3939"
        private const val SUPERVISOR_INTERVAL_MS = 5_000L
        private const val BOOTSTRAP_COOLDOWN_MS = 20_000L
    }
}

/** True when the supervisor should re-invite the phone: no session, and a bootstrap that is stopped or went stale, past its cooldown. */
internal fun shouldReinvite(
    sessionActive: Boolean,
    bootstrapRunning: Boolean,
    bootstrapStale: Boolean,
    millisSinceBootstrap: Long,
    cooldownMillis: Long,
): Boolean =
    !sessionActive && (!bootstrapRunning || bootstrapStale) && millisSinceBootstrap >= cooldownMillis
