# Linux support for PlayPort: design

Date: 2026-10-31
Status: approved in conversation; implementation authorized on this spec landing
Branch: `linux-support` on the `mvmcjr/playport` fork, for a later PR to `youcci/playport`

## Goal

Run PlayPort's full wireless CarPlay flow on Linux with BlueZ, using a native helper that has the
same command-line interface as `macos/bt-bridge`.

**Success:** a real CarPlay session on the Omarchy/Arch development machine, with the iPhone's video
in the browser and working touch input, brought up by following the README.

## Assumptions and non-goals

- The macOS path keeps working unchanged. It cannot be tested on the development machine, and the PR
  description must say so.
- Omarchy/Arch is the only tested distribution. The README must not imply wider testing.
- The diff stays small enough for upstream to review.
- `protocol/` is not changed. The README says it stays close to DiPlay so upstream fixes merge easily.
- Not in scope: a firewall port-range flag, Linux Wi-Fi auto-detection, an avahi advertising backend,
  replacing the Swift helper, and opening the PR.

## Evidence already gathered

All from throwaway probes on the development machine with a paired iPhone:

- BlueZ's profile API in client role reaches the iPhone's iAP2 service
  (`00000000-deca-fade-deca-deafdecacafe`, RFCOMM channel 1) in about 450 ms. Sending the 6-byte link
  marker `ff 55 02 00 ee 10` returns the same 6 bytes.
- `bluer` 0.17.4 builds here. Its pairing agent and BR/EDR discovery APIs compile but have not been
  run.
- With the server running, avahi resolves the JmDNS advertisement (`PlayPort`, LAN address, port 7000,
  TXT records) and logs no complaints. iPhone discovery over mDNS is not yet tested.

Identification, MFi authentication, the Wi-Fi handoff and media are all untested on Linux.

## Architecture

```
PlayPort server (JVM)  --spawns-->  linux/bt-bridge/bt-bridge  --D-Bus-->  bluetoothd
        ^                                     |                                |
        |          stdin/stdout (raw iAP2)    |   RFCOMM socket fd from BlueZ  |
        +-------------------------------------+<-------------------------------+
```

The helper is a drop-in replacement. The server keeps launching a helper as it does today and needs
no OS check: its lookup picks the first executable path, and only the helper you built exists.

Alternatives rejected:

- **One cross-platform Rust helper replacing Swift:** cannot be tested on macOS, and changes a path
  that works upstream.
- **JVM talking to BlueZ directly:** the JVM has no RFCOMM sockets, so it would need native code
  anyway.
- **C with libbluetooth:** workable, but `bluer` gives BlueZ's profile API, which does the SDP lookup
  and hands over the socket.

## Component: `linux/bt-bridge`

### Layout

```
linux/bt-bridge/Cargo.toml
linux/bt-bridge/Cargo.lock
linux/bt-bridge/src/main.rs     (split into modules only if it becomes hard to follow)
linux/bt-bridge/build.sh
```

`build.sh` follows `macos/bt-bridge/build.sh`: `set -e`, `cd` to its own directory, run
`cargo build --release --locked`, copy the binary to `linux/bt-bridge/bt-bridge`, and print
`built: <path>`.

`.gitignore` gains `linux/bt-bridge/bt-bridge` and `linux/bt-bridge/target/`.

Dependencies: `bluer` with features `bluetoothd` and `rfcomm`, `tokio`, `futures`. Building needs
`cargo`, `pkg-config` and the D-Bus development headers. Running needs `libdbus` and `bluetoothd`.

### Command-line interface

All logging and hints go to stderr, prefixed `bt-bridge: `. Stdout carries only what this table
specifies. Any failure prints a clear message to stderr and exits 1. Unknown arguments print the usage
line to stderr and exit 1. A malformed address is rejected before any Bluetooth call.

| Command | Behaviour |
|---|---|
| `--print-address` | Prints the default adapter's address as exactly `XX:XX:XX:XX:XX:XX`, then exits 0. |
| `--list` | Prints `ADDR Name` for each paired device, one per line, then exits 0. |
| `--scan` | Runs a 10 s BR/EDR scan and prints `ADDR Name [paired\|new]` as devices are seen, flushing each line. Cached devices not seen in this scan are not listed. |
| `--pair <addr>` | If already paired, prints `<addr> is already paired; nothing to do.` and a hint to start the server with `--wireless`, then exits 0. Otherwise discovers the device for up to 20 s, pairs and marks it trusted. The whole operation is limited to 45 s. Prints `paired with <addr>` on success. |
| `--force-pair <addr>` | Removes any existing BlueZ pairing, then behaves as `--pair`. |
| `--address <addr>` | Opens the iAP2 channel and pipes bytes over stdin/stdout. See below. |

**Pairing agent:** registered as the default agent for the duration of the command. On a numeric
comparison request it prints `confirm this code on the iPhone: NNNNNN` to stdout, flushes, and accepts
on this side, so the user checks the code and approves on the phone. This matches the macOS helper.
On a passkey notification it prints `enter this passkey on the iPhone: NNNNNN`. A legacy PIN request
fails with a message saying only numeric pairing is supported. Pairing failures suggest removing the
stale entry from the phone and retrying.

### `--address` rules

These come from how the server's iAP2 layer behaves.

1. **Paired check.** Fail if the device is not paired, pointing at `--pair`.
2. **Connect.** Register a client-role profile for the iAP2 UUID with authentication required and
   auto-connect off, then call `connect_profile`. Accept the `ConnectRequest` *while* `connect_profile`
   is still running. Accepting afterwards makes BlueZ's `NewConnection` call fail with `NoReply` and
   `connect_profile` return `br-connection-refused`, as the first probe showed. The connect has a
   30 s limit.
3. **Before the channel opens.** Keep reading stdin and discard the bytes. They are only link markers,
   the server resends one each second, and the phone's handling of a queued backlog is unknown. Stdin
   must keep draining because the server's writes block its only link worker with no timeout.
4. **Stdout is pure.** It carries RFCOMM bytes only, flushed per chunk. The server treats the first 6
   bytes as the marker and kills the link on a mismatch.
5. **Exit promptly.** Exit when RFCOMM closes or errors, or when stdin reaches EOF. The server has no
   keepalive and does not respawn while `running` is set, so a hung helper stalls reconnection. Exit
   with `std::process::exit` rather than returning from `main`, because tokio's stdin read runs on a
   blocking thread that would otherwise hold up runtime shutdown.
6. **Termination.** The server stops the helper by closing stdin and sending SIGTERM. Default SIGTERM
   behaviour is sufficient.

The iAP2 layer reassembles arbitrary chunks and has no RFCOMM size assumption, so the helper does no
framing.

## Server changes

No file under `protocol/` changes. Paths are under `server/src/main/kotlin/com/playport/server/`.

| File | Change |
|---|---|
| `WirelessBootstrap.kt:128` | Add `linux/bt-bridge/bt-bridge` to the helper paths in `resolveBridgePath`. |
| `Networks.kt:16` | Move the name check into a small pure function and also skip the prefixes `docker`, `br-`, `veth` and `virbr`. Existing macOS prefixes stay. |
| `WirelessBootstrap.kt:19,46,57,142` | Make the wording platform-neutral. Line 57 names both build scripts. |
| `ProcessByteStream.kt:13`, `ServerConfig.kt:140` | Same wording fix. |

`WifiInfo.kt` stays as it is. Its macOS commands already fail harmlessly on Linux through
`runCatching`, and its comment accurately describes macOS-only detection.

Deliberately unchanged, and why:

- **mDNS:** the JmDNS advertisement works next to avahi.
- **iAP tunnel's secondary socket:** the `::` bind on the primary's port is expected to fail on Linux
  with `bindv6only=0`. The failure is only logged and the IPv4 primary still accepts the phone. The
  hardware session confirms this.
- **Random media ports:** pinning them means changing six sockets in `protocol/`. The README documents
  allowing the iPhone's IP instead. The trade-off is that this opens every port to the phone.
- **Wi-Fi auto-detection:** Wi-Fi is down on the development machine, so it could not be tested. Linux
  users pass `--wifi-ssid` and `--wifi-passphrase`.
- **Wi-Fi channel 0:** the hardware session settles this. If the phone refuses 0, the Linux docs mark
  `--wifi-channel` as required, with no code change.

## README changes

- **Quick start:** steps 3 to 5 get macOS and Linux versions side by side. Linux uses
  `linux/bt-bridge/build.sh`, `--scan`, `--pair` and a ufw rule, with a note to stay on the phone's
  Settings > Bluetooth page.
- **Run command:** a note explains that a wired host also needs `--bind <lan-ip>` plus the Wi-Fi
  flags, and that the phone's Wi-Fi must reach that subnet, including multicast.
- **Also updated:** platform badge, intro, requirements table, `--bt-bridge` default, troubleshooting,
  project layout and test counts.
- **Status and limitations:** "Linux is not supported yet" becomes a statement of what was actually
  tested, on Omarchy/Arch only.

## Testing

### Automated (no hardware)

- **Kotlin, written first:** a unit test for the interface name check. `eno1`, `wlp9s0`, `en0` and
  `br0` are kept. `docker0`, `br-5a39bebad8d8`, `veth1234`, `virbr0`, `utun3`, `awdl0`, `llw0`,
  `bridge100` and `ap1` are skipped. `./gradlew build` must pass.
- **Rust:** unit tests for argument parsing, address validation and the `--scan` and `--list` output
  formats. `cargo test` must pass, and no test may need Bluetooth hardware.

### Hardware (needs the user and the iPhone)

1. **Helper basics:** builds from clean, `--print-address` returns the adapter address, `--list` shows
   the iPhone.
2. **Pairing:** `--scan` finds the phone, `--pair` exits cleanly when already paired, and `--force-pair`
   shows a code and re-pairs after the device is forgotten on the phone.
3. **Connection:** `--address` completes the marker exchange, and the helper exits when stdin closes
   and when Bluetooth drops on the phone.
4. **Full session:** `--wireless` brings up the CarPlay prompt, video appears in the browser and touch
   works.
5. **Reconnection:** the server reconnects after the phone's link drops.
6. **Recorded results:** whether the phone accepts channel 0, and whether it discovers the server over
   mDNS.

**Done** means all of the above passes. If the full session fails at a later stage, stop and report it
rather than working around it. The PR waits.

The user runs the ufw rule because it needs `sudo`, and gets the matching removal command.

## Repository handling

- Work happens on `linux-support`. Nothing is pushed or opened as a PR without the user asking.
- This spec and the implementation plan get their own commits and are removed before the PR, so
  upstream sees only the Linux support.
- Committed files must not contain the test phone's address or the development machine's LAN address.

## Risks

- **Phone-side stages on Linux:** identification, MFi and the handoff have never run here. The marker
  exchange shows the transport works, not that iOS accepts the whole session from a BlueZ host.
- **Host on Ethernet:** the development machine is wired, so the phone must reach it across the Wi-Fi
  and LAN segments, including multicast.
- **Audio routing:** WirePlumber lists the paired iPhone as a Bluetooth audio device. No inputs or
  outputs from it have appeared so far, but it may affect the phone's audio routing.
