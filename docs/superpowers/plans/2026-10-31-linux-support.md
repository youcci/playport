# Linux Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run PlayPort's full wireless CarPlay flow on Linux with BlueZ, through a Rust helper that has the same command-line interface as `macos/bt-bridge`.

**Architecture:** The JVM server keeps spawning a helper and speaking iAP2 over its stdin/stdout, so it needs only a new lookup path, a stricter interface filter and wording fixes. The new `linux/bt-bridge` uses `bluer` to register a client-role BlueZ profile, which does the SDP lookup and hands over the RFCOMM socket, and to pair through a BlueZ agent.

**Tech Stack:** Rust 2021, `bluer` 0.17 (features `bluetoothd`, `rfcomm`), `tokio`, `futures`; Kotlin/JVM with JUnit 4 for the server.

**Spec:** `docs/superpowers/specs/2026-10-31-linux-support-design.md`. Read it before starting any task.

## Global Constraints

- No file under `protocol/` changes. `macos/bt-bridge` does not change.
- Helper stdout carries only what the spec's table specifies. All logging and hints go to stderr, prefixed `bt-bridge: `. Any failure prints to stderr and exits 1.
- Committed files must not contain a real phone's Bluetooth address or the machine's LAN address. Use `AA:BB:CC:DD:EE:FF` in tests and docs.
- **Hardware safety for subagents:** you may run `--print-address`, `--list`, `--scan`, the `--address` smoke check in Task 3, and `--pair` only against a device `--list` already shows as paired. Never run `--force-pair`, `--pair` against an unpaired device, `bluetoothctl remove`, `sudo` or `ufw`.
- Work on branch `linux-support`. Never push. Commit messages are plain imperative sentences with no `feat:` prefix, matching `git log`, and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A device name with non-ASCII characters, such as `Ana’s iPhone`: output keeps it unchanged, so the server's `iphone` match still works. Pinned in Task 2.
- A device with no name: `--list` prints a bare address and `--scan` prints `ADDR [new]`, never a double space. Pinned in Tasks 2 and 4.
- An address typed in lowercase, or malformed (`A:B:C:D:E:F`, `+A:BB:CC:DD:EE:FF`, hyphens): lowercase is accepted, the rest are rejected before any Bluetooth call. `bluer`'s own parser accepts the first two malformed forms. Pinned in Task 2.
- `bluetoothd` or D-Bus unreachable: stdout stays empty and the helper exits 1 without hanging, even with stdin held open, because the server reads stdout as data. Pinned in Task 2.
- The phone's link drops while stdin is idle, or the server dies while the phone is sending: the pump ends promptly rather than hanging, because the server won't respawn a running helper. Pinned in Task 3.

---

### Task 1: Server finds the Linux helper and skips container interfaces

**Files:**
- Modify: `server/src/main/kotlin/com/playport/server/Networks.kt:15-20`
- Modify: `server/src/main/kotlin/com/playport/server/WirelessBootstrap.kt:19-20,46,57,128-129,142`
- Modify: `server/src/main/kotlin/com/playport/server/ProcessByteStream.kt:13`
- Modify: `server/src/main/kotlin/com/playport/server/ServerConfig.kt:140`
- Test: `server/src/test/kotlin/com/playport/server/NetworksTest.kt`

**Interfaces:**
- Produces: `Networks.isVirtualInterfaceName(name: String): Boolean`. The server looks for the helper at `linux/bt-bridge/bt-bridge`, which Task 2's `build.sh` creates.

- [ ] **Step 1: Write the failing test**

Follow the style of `WireTest.kt` (`org.junit.Test`, `org.junit.Assert.*`), in class `NetworksTest`:

```kotlin
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew :server:test --tests '*NetworksTest*' --console=plain`
Expected: compile failure, `Unresolved reference 'isVirtualInterfaceName'`.

- [ ] **Step 3: Implement `isVirtualInterfaceName` in `Networks`**

Case-insensitive prefix check over `utun`, `awdl`, `llw`, `bridge`, `ap1`, `docker`, `br-`, `veth`, `virbr`. Have `detectLanAddress` call it in place of the inline `name.startsWith` chain.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew :server:test --tests '*NetworksTest*' --console=plain`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Add the helper path and fix the wording**

- `resolveBridgePath`: add `Path.of("linux/bt-bridge/bt-bridge")` after the two macOS paths.
- `WirelessBootstrap.kt:19-20` doc comment: `Requires the platform's bt-bridge helper (macos/bt-bridge or linux/bt-bridge) with the iPhone already paired, and the server on the network the phone's Wi-Fi reaches.`
- `:46`: `"(automatic detection only works on macOS, which hides the SSID from processes without Location Services permission)."`
- `:57`: `"build it with macos/bt-bridge/build.sh or linux/bt-bridge/build.sh, or pass --bt-bridge"`
- `:142`: `/** Helpers around the platform's bt-bridge executable. */`
- `ProcessByteStream.kt:13`: `Used for the Bluetooth bridge helper: ...`, keeping the rest of the sentence.
- `ServerConfig.kt:140`: `--bt-bridge <path>        Path to the bt-bridge helper`

- [ ] **Step 6: Run the full build**

Run: `./gradlew build --console=plain`
Expected: `BUILD SUCCESSFUL`, with 98 tests in total (96 existing plus 2 new).

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "Find the Linux bt-bridge helper and skip container interfaces"
```

---

### Task 2: Helper scaffold, CLI and read-only commands

**Files:**
- Create: `linux/bt-bridge/Cargo.toml`, `linux/bt-bridge/Cargo.lock`, `linux/bt-bridge/build.sh`
- Create: `linux/bt-bridge/src/main.rs`, `linux/bt-bridge/src/cli.rs`
- Test: unit tests in `linux/bt-bridge/src/cli.rs`, integration tests in `linux/bt-bridge/tests/cli.rs`
- Modify: `.gitignore`

**Interfaces:**
- Produces, in `cli.rs` (`Command` derives `Debug`, `PartialEq`):

```rust
pub enum Command { PrintAddress, List, Scan, Pair { address: Address, force: bool }, Bridge { address: Address } }
pub const USAGE: &str = "usage: bt-bridge --print-address | --list | --scan | --pair <addr> | --force-pair <addr> | --address <addr>";
pub fn parse_args(args: &[String]) -> Result<Command, String>;
pub fn parse_address(text: &str) -> Result<Address, String>;
pub fn device_line(address: Address, name: Option<&str>) -> String;
pub fn scan_line(address: Address, name: Option<&str>, paired: bool) -> String;
pub fn confirm_line(passkey: u32) -> String;
pub fn passkey_line(passkey: u32) -> String;
```

- Produces, in `main.rs`:

```rust
pub async fn open_adapter() -> Result<(Session, Adapter), String>;
pub async fn require_powered(adapter: &Adapter) -> Result<(), String>;
```

- [ ] **Step 1: Create the package**

`Cargo.toml`: package `bt-bridge`, version `0.1.0`, edition `2021`, `publish = false`. Dependencies: `bluer = { version = "0.17", features = ["bluetoothd", "rfcomm"] }`, `futures = "0.3"`, `tokio = { version = "1", features = ["io-std", "io-util", "macros", "rt-multi-thread", "time"] }`. `[profile.release] strip = true`.

`build.sh`, mode 755, mirroring `macos/bt-bridge/build.sh`:

```sh
#!/bin/sh
# Builds the Linux Bluetooth RFCOMM bridge helper.
set -e
cd "$(dirname "$0")"
cargo build --release --locked
cp target/release/bt-bridge bt-bridge
echo "built: $(pwd)/bt-bridge"
```

`.gitignore`: under the existing helper-binary entry, add `linux/bt-bridge/bt-bridge` and `linux/bt-bridge/target/`, and rename its comment to cover both helpers.

- [ ] **Step 2: Write the failing unit tests in `cli.rs`**

```rust
fn args(list: &[&str]) -> Vec<String> { list.iter().map(|s| s.to_string()).collect() }
const ADDR: &str = "AA:BB:CC:DD:EE:FF";
fn addr() -> Address { parse_address(ADDR).unwrap() }

#[test] fn parses_every_command() {
    assert_eq!(parse_args(&args(&["--print-address"])), Ok(Command::PrintAddress));
    assert_eq!(parse_args(&args(&["--list"])), Ok(Command::List));
    assert_eq!(parse_args(&args(&["--scan"])), Ok(Command::Scan));
    assert_eq!(parse_args(&args(&["--pair", ADDR])), Ok(Command::Pair { address: addr(), force: false }));
    assert_eq!(parse_args(&args(&["--force-pair", ADDR])), Ok(Command::Pair { address: addr(), force: true }));
    assert_eq!(parse_args(&args(&["--address", ADDR])), Ok(Command::Bridge { address: addr() }));
}
#[test] fn rejects_missing_or_unknown_arguments() {
    for bad in [&[][..], &["--nope"], &["--pair"], &["--address"], &["--list", "extra"]] {
        assert_eq!(parse_args(&args(bad)), Err(USAGE.to_string()));
    }
}
#[test] fn address_accepts_lowercase_and_prints_uppercase() {
    assert_eq!(parse_address("aa:bb:cc:dd:ee:ff").unwrap().to_string(), ADDR);
}
#[test] fn address_rejects_malformed() {
    for bad in ["", "AA:BB:CC:DD:EE", "AA-BB-CC-DD-EE-FF", "A:B:C:D:E:F",
                "+A:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:FG", "AA:BB:CC:DD:EE:FF:00"] {
        assert!(parse_address(bad).is_err(), "{bad}");
    }
}
#[test] fn device_line_keeps_non_ascii_names() {
    assert_eq!(device_line(addr(), Some("Ana’s iPhone")), "AA:BB:CC:DD:EE:FF Ana’s iPhone");
}
#[test] fn device_line_without_a_name_is_a_bare_address() {
    assert_eq!(device_line(addr(), None), ADDR);
    assert_eq!(device_line(addr(), Some("")), ADDR);
}
#[test] fn scan_line_marks_paired_and_new() {
    assert_eq!(scan_line(addr(), Some("iPhone"), false), "AA:BB:CC:DD:EE:FF iPhone [new]");
    assert_eq!(scan_line(addr(), Some("iPhone"), true), "AA:BB:CC:DD:EE:FF iPhone [paired]");
    assert_eq!(scan_line(addr(), None, false), "AA:BB:CC:DD:EE:FF [new]");
}
#[test] fn pairing_codes_are_zero_padded() {
    assert_eq!(confirm_line(1234), "confirm this code on the iPhone: 001234");
    assert_eq!(passkey_line(7), "enter this passkey on the iPhone: 000007");
}
```

- [ ] **Step 3: Write the failing integration tests in `tests/cli.rs`**

Helper `run_without_bus(args: &[&str]) -> std::process::Output` spawns `env!("CARGO_BIN_EXE_bt-bridge")` with `DBUS_SYSTEM_BUS_ADDRESS=unix:path=/nonexistent/playport-test-bus`, `Stdio::piped()` for all three streams, keeps stdin open while polling `try_wait` for up to 10 s (panicking if the process is still running), then collects output.

```rust
#[test] fn every_bluetooth_command_fails_cleanly_without_a_bus() {
    for args in [&["--print-address"][..], &["--list"], &["--scan"],
                 &["--pair", "AA:BB:CC:DD:EE:FF"], &["--address", "AA:BB:CC:DD:EE:FF"]] {
        let output = run_without_bus(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(String::from_utf8_lossy(&output.stderr).starts_with("bt-bridge: "), "{args:?}");
    }
}
#[test] fn malformed_address_and_no_arguments_print_to_stderr() {
    for args in [&["--address", "nope"][..], &[]] {
        let output = run_without_bus(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(String::from_utf8_lossy(&output.stderr).starts_with("bt-bridge: "), "{args:?}");
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd linux/bt-bridge && cargo test`
Expected: compile errors for the missing `cli` items.

- [ ] **Step 5: Implement `cli.rs`**

`parse_address` must validate strictly before calling `bluer`: exactly 17 characters, `:` at every third position, ASCII hex digits elsewhere. `bluer`'s `FromStr` alone accepts `A:B:C:D:E:F` and `+A:...`. Build lines from non-empty parts joined by single spaces. Codes use `{:06}`.

- [ ] **Step 6: Implement `main.rs`**

`#[tokio::main] async fn main()` parses `std::env::args().skip(1)`, dispatches, and always ends in `std::process::exit`: 0 on `Ok`, or 1 after `eprintln!("bt-bridge: {message}")` on `Err`. Add a one-line comment saying why: tokio's stdin read runs on a blocking thread that would otherwise hold up runtime shutdown.

- `open_adapter`: `Session::new()` then `default_adapter()`. Map errors to a message that mentions `bluetooth.service`.
- `require_powered`: if `adapter.is_powered()` is false, return `Bluetooth adapter is powered off; turn it on with: bluetoothctl power on`.
- `--print-address`: `println!` the adapter address.
- `--list`: `println!` a `device_line` for each device from `device_addresses()` where `is_paired()` is true.
- `Scan`, `Pair` and `Bridge`: for now call `open_adapter()` and return `Err("not implemented".into())`. Tasks 3 and 4 replace these.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd linux/bt-bridge && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all tests pass, no clippy warnings.

- [ ] **Step 8: Check the real build**

Run: `linux/bt-bridge/build.sh && linux/bt-bridge/bt-bridge --print-address && linux/bt-bridge/bt-bridge --list && git check-ignore linux/bt-bridge/bt-bridge linux/bt-bridge/target`
Expected: `built: ...`, one address matching `^[0-9A-F:]{17}$`, one `ADDR Name` line per paired device, and both paths reported as ignored.

- [ ] **Step 9: Commit**

```bash
git add .gitignore linux/bt-bridge
git commit -m "Add the Linux bt-bridge helper with its read-only commands"
```

---

### Task 3: `--address` bridge

**Files:**
- Create: `linux/bt-bridge/src/bridge.rs`, with unit tests in the same file
- Modify: `linux/bt-bridge/src/main.rs` (the `Bridge` arm)

**Interfaces:**
- Consumes: `open_adapter`, `require_powered`.
- Produces:

```rust
pub async fn run(address: Address) -> Result<(), String>;
pub enum DrainEnd<T> { Opened(T), StdinClosed }   // derives Debug, PartialEq
pub enum PumpEnd { StdinClosed, RfcommClosed }    // derives Debug, PartialEq
pub async fn drain_until<I: AsyncRead + Unpin, T>(stdin: &mut I, open: impl Future<Output = T>) -> DrainEnd<T>;
pub async fn pump<I, O, R>(stdin: I, stdout: O, rfcomm: R) -> Result<PumpEnd, String>
where I: AsyncRead + Unpin, O: AsyncWrite + Unpin, R: AsyncRead + AsyncWrite + Unpin;
```

- [ ] **Step 1: Write the failing tests**

All use `tokio::io::duplex` and wrap the call under test in `tokio::time::timeout(Duration::from_secs(1), ..)`, so a hang fails the test.

```rust
#[tokio::test] async fn bytes_before_open_are_discarded()
// Write the 6-byte marker to stdin. drain_until with an open future that sleeps 50 ms then returns 7
// gives DrainEnd::Opened(7). Then write b"after": the next read of stdin returns exactly b"after".

#[tokio::test] async fn stdin_eof_before_open_stops_waiting()
// Drop the stdin writer. drain_until with std::future::pending::<()>() gives DrainEnd::StdinClosed.

#[tokio::test] async fn pump_moves_bytes_both_ways_and_flushes_stdout()
// stdout is tokio::io::BufWriter::new(duplex), so bytes arrive only if pump flushes each chunk.
// Bytes written to stdin arrive on the rfcomm peer; bytes from the rfcomm peer arrive at stdout's
// reader, unchanged and without closing anything.

#[tokio::test] async fn pump_ends_when_rfcomm_closes_while_stdin_is_idle()
// Keep the stdin writer alive and drop the rfcomm peer: Ok(PumpEnd::RfcommClosed).

#[tokio::test] async fn pump_ends_when_stdin_closes()
// Keep the rfcomm peer alive and drop the stdin writer: Ok(PumpEnd::StdinClosed).

#[tokio::test] async fn pump_fails_when_stdout_is_gone()
// Drop stdout's reader, then write from the rfcomm peer: Err(_).
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd linux/bt-bridge && cargo test bridge`
Expected: compile errors for the missing items.

- [ ] **Step 3: Implement `drain_until` and `pump`**

`drain_until` loops a `tokio::select!` between the pinned `open` future and a read that discards, treating a read of 0 or an error as `StdinClosed`. `pump` uses `tokio::io::split` on `rfcomm` and a `tokio::select!` over two copy loops, so a stalled direction can't block the other. Flush stdout after every chunk. Read of 0 on rfcomm gives `RfcommClosed`, read of 0 on stdin gives `StdinClosed`, and any I/O error gives `Err` naming the direction.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd linux/bt-bridge && cargo test bridge`
Expected: 6 passed.

- [ ] **Step 5: Implement `run` and its private `connect`, and wire up the `Bridge` arm**

`IAP2` is `Uuid::from_u128(0x00000000_deca_fade_deca_deafdecacafe)`.

`run`:
1. `open_adapter`, then `require_powered`.
2. If `device.is_paired()` is false or errors, fail with `device <addr> is not paired; pair it with bt-bridge --pair first`.
3. Log `RFCOMM channel opening to <addr>`.
4. `drain_until(&mut tokio::io::stdin(), connect(..))`. On `StdinClosed`, log `stdin closed` and return `Ok`.
5. Log `RFCOMM channel open`, then `pump` with `tokio::io::stdin()` and `tokio::io::stdout()`.
6. Log `RFCOMM channel closed` or `stdin closed` according to the `PumpEnd`, and return.

`connect` registers `Profile { uuid: IAP2, role: Some(Role::Client), require_authentication: Some(true), auto_connect: Some(false), ..Default::default() }`, then, inside `tokio::time::timeout` of 30 s:

```rust
tokio::try_join!(
    async { device.connect_profile(&IAP2).await.map_err(|e| e.to_string()) },
    async { handle.next().await.ok_or("profile closed".to_string())?.accept().map_err(|e| e.to_string()) },
)
```

- `try_join!` is deliberate. It accepts while `connect_profile` is still running, which BlueZ needs, and a `connect_profile` failure returns at once rather than waiting out the 30 s.
- Return the `ProfileHandle` alongside the stream and keep it alive in `run` for the whole pump. Dropping it unregisters the profile, which closes the connection.
- The timeout message is `timed out after 30s connecting to <addr>; is it in range?`.

- [ ] **Step 6: Run all tests and clippy**

Run: `cd linux/bt-bridge && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all pass, no warnings.

- [ ] **Step 7: Smoke-check against the phone, if it's reachable**

```bash
linux/bt-bridge/build.sh
ADDR=$(linux/bt-bridge/bt-bridge --list | grep -i iphone | cut -d' ' -f1)
(for i in 1 2 3 4 5 6; do printf '\xff\x55\x02\x00\xee\x10'; sleep 1; done) \
  | timeout 30 linux/bt-bridge/bt-bridge --address "$ADDR" | xxd | head -3
```

Expected: stderr shows the channel opening and open, and the output starts with `ff55 0200 ee10`. The helper exits by itself once the loop ends and stdin closes. If `--list` shows no iPhone or the phone is out of range, report the check as not run. Don't try to pair.

- [ ] **Step 8: Commit**

```bash
git add linux/bt-bridge
git commit -m "Bridge iAP2 over RFCOMM in the Linux helper"
```

---

### Task 4: `--scan`, `--pair` and `--force-pair`

**Files:**
- Create: `linux/bt-bridge/src/pairing.rs`, with unit tests in the same file
- Modify: `linux/bt-bridge/src/main.rs` (the `Scan` and `Pair` arms)

**Interfaces:**
- Consumes: `open_adapter`, `require_powered`, `scan_line`, `confirm_line`, `passkey_line`.
- Produces:

```rust
pub async fn scan(adapter: &Adapter) -> Result<(), String>;
pub async fn pair(session: &Session, adapter: &Adapter, address: Address, force: bool) -> Result<(), String>;
pub struct ScanReport;   // private fields
impl ScanReport {
    pub fn new() -> Self;
    pub fn observe(&mut self, address: Address, name: Option<&str>, paired: bool, in_range: bool) -> Option<String>;
    pub fn finish(self) -> Vec<String>;
}
```

- [ ] **Step 1: Write the failing `ScanReport` tests**

```rust
#[test] fn cached_device_out_of_range_prints_nothing()
// observe(addr, Some("JBL"), true, false) == None, and finish() is empty.

#[test] fn in_range_device_prints_once()
// The first observe with in_range = true returns Some("AA:BB:CC:DD:EE:FF iPhone [new]").
// A repeat returns None.

#[test] fn name_arriving_late_is_used()
// observe(addr, None, false, true) == None, because BlueZ reports the name after the address.
// Then observe(addr, Some("iPhone"), false, true) == Some(".. iPhone [new]"), and finish() is empty.

#[test] fn device_that_never_gets_a_name_prints_at_the_end()
// observe(addr, None, false, true) == None. finish() == vec!["AA:BB:CC:DD:EE:FF [new]"].
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd linux/bt-bridge && cargo test pairing`
Expected: compile errors.

- [ ] **Step 3: Implement `ScanReport`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd linux/bt-bridge && cargo test pairing`
Expected: 4 passed.

- [ ] **Step 5: Implement `scan` and `pair`, and wire up the arms**

Both call `require_powered` first, and both set `DiscoveryFilter { transport: DiscoveryTransport::BrEdr, ..Default::default() }`.

`scan`: log `scanning for 10s — keep the iPhone's Bluetooth settings page open`. Use `discover_devices_with_changes` for 10 s, because known devices are included and names arrive later as changes. On each `AdapterEvent::DeviceAdded`, pass `device.name()`, `is_paired()` and `rssi().is_some()` to `ScanReport::observe` and `println!` any line returned. Print `finish()` at the end.

`pair`:
1. If `force`, call `adapter.remove_device(address)` and ignore a failure from the device being unknown.
2. If not `force` and it's already paired: `println!("{address} is already paired; nothing to do.")`, log `start the server with --wireless and it will find the iPhone (or check --list)`, and return `Ok`.
3. Register `Agent { request_default: true, request_confirmation, display_passkey, request_pin_code, ..Default::default() }`, and hold its handle until the end.
   - `request_confirmation`: `println!` `confirm_line` and return `Ok(())`.
   - `display_passkey`: `println!` `passkey_line`.
   - `request_pin_code`: log `the device requested a legacy PIN code; this helper supports numeric pairing only` and return `Err(ReqError::Rejected)`.
4. Inside `tokio::time::timeout` of 45 s:
   - Discover for up to 20 s until the target address has an RSSI, then drop the stream so discovery stops before pairing. If it isn't found: `device <addr> was not found; make sure it is discoverable (Bluetooth settings open) and try again`.
   - `device.pair()`. On failure: `pairing failed: <error>; remove any stale pairing from the phone and retry`.
   - `device.set_trusted(true)`.
5. `println!("paired with {address}")`. The timeout message is `pairing timed out after 45s; make sure the iPhone is awake and unlocked with Settings > Bluetooth open, then retry`.

- [ ] **Step 6: Run all tests and clippy**

Run: `cd linux/bt-bridge && cargo test && cargo clippy --all-targets -- -D warnings`
Expected: all pass, no warnings. The Task 2 integration tests now cover the real `--scan` and `--pair` paths.

- [ ] **Step 7: Check the safe paths on real hardware**

```bash
linux/bt-bridge/build.sh
linux/bt-bridge/bt-bridge --scan
ADDR=$(linux/bt-bridge/bt-bridge --list | grep -i iphone | cut -d' ' -f1)
[ -n "$ADDR" ] && linux/bt-bridge/bt-bridge --pair "$ADDR"
```

Expected: `--scan` exits after about 10 s with lines in the `ADDR Name [paired|new]` format and no devices that are out of range. `--pair` prints `... is already paired; nothing to do.` and exits 0. Don't run `--force-pair`, and skip `--pair` if `ADDR` is empty. Real pairing is tested in Task 6.

- [ ] **Step 8: Commit**

```bash
git add linux/bt-bridge
git commit -m "Add scanning and pairing to the Linux helper"
```

---

### Task 5: README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the command names from Tasks 2 to 4, and the test total from Task 1.

- [ ] **Step 1: Update Quick start steps 3 to 6**

```sh
# 3. Build the Bluetooth bridge
macos/bt-bridge/build.sh             # macOS
linux/bt-bridge/build.sh             # Linux

# 4. Pair the iPhone once (keep Settings > Bluetooth open on the phone)
BRIDGE=macos/bt-bridge/bt-bridge     # on Linux: BRIDGE=linux/bt-bridge/bt-bridge
$BRIDGE --scan
$BRIDGE --pair AA:BB:CC:DD:EE:FF     # confirm the code on the iPhone

# 5. Prepare the host
#    macOS:
#    · System Settings → General → AirDrop & Handoff → turn OFF "AirPlay Receiver"
#    · System Settings → Privacy & Security → Bluetooth → enable your terminal app
#    · Allow incoming connections for java if the firewall asks
#    Linux:
#    · Allow the iPhone through your firewall; it connects in on port 7000 and on random
#      media ports. With ufw: sudo ufw allow from <iphone-ip>
#      (undo it with: sudo ufw delete allow from <iphone-ip>)
```

Keep step 6's command. Directly below the code block, add a short paragraph:

> On Linux, always pass `--wifi-ssid` and `--wifi-passphrase`, because the network isn't detected automatically. If the machine is on Ethernet, also pass `--bind <lan-ip>`. The iPhone's Wi-Fi must reach that subnet, including multicast.

- [ ] **Step 2: Update the other sections**

- **Badge, line 9:** `platform-macOS%20%7C%20Linux`.
- **Intro, line 17:** "on a Mac or Linux PC".
- **Requirements:**
  - Server: macOS 13+, or Linux with BlueZ (tested on Omarchy/Arch).
  - Java: JDK 21 (`brew install openjdk@21`, or your distribution's package).
  - Build tools: Xcode Command Line Tools on macOS; on Linux, `cargo`, `pkg-config` and the D-Bus development headers (Arch: `rust pkgconf dbus`).
  - Network: "iPhone and host on the same network".
- **Configuration:** `--bt-bridge` default becomes `macos/bt-bridge/bt-bridge` or `linux/bt-bridge/bt-bridge`. `--mdns` default becomes `auto` (`dns-sd` on macOS, JmDNS elsewhere). Note under `--wifi-ssid` that auto-detection is macOS only.
- **Troubleshooting:**
  - Label the existing `SIGABRT`, "never appears in Bluetooth settings" and "Port 7000" rows as macOS.
  - Add `adapter is powered off`: run `bluetoothctl power on`.
  - Add Linux `--pair` fails or times out: forget this computer on the iPhone, keep Settings → Bluetooth open, and retry with `--force-pair`.
  - Add Linux no CarPlay prompt or no video after the Bluetooth step: allow the iPhone through the firewall, as in Quick start step 5.
  - Add wrong address in the printed URL: pass `--bind <lan-ip>`.
  - Extend the `no Wi-Fi network detected` row to say Linux always needs the flags.
- **Project layout:** add `linux/      bt-bridge: Rust BlueZ RFCOMM helper for the wireless bootstrap`.
- **Development:** add `(cd linux/bt-bridge && cargo test)   # tests the Linux helper`.
- **Test counts:** lines 11, 133 and 321 change from 96 to 98.
- **Status and limitations:** replace "Linux is not supported yet ..." with `Linux support uses linux/bt-bridge and BlueZ, and has only been tested on Omarchy/Arch.`

- [ ] **Step 3: Verify**

Run: `grep -n "96\|not supported yet" README.md; grep -c "linux/bt-bridge" README.md; git diff --stat -- README.md`
Expected: no stale count or "not supported yet" line remains, `linux/bt-bridge` appears several times, and only `README.md` changed.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document Linux support in the README"
```

---

### Task 6: Hardware acceptance (run by the controller with the user, not a subagent)

**Files:**
- Modify: `README.md`, only if the results below require it

Do not delegate this task. It needs the user, the iPhone and `sudo`. Stop and report at the first failure; don't work around it.

- [ ] **Step 1: Helper basics.** From clean (`rm -rf linux/bt-bridge/target linux/bt-bridge/bt-bridge`), `build.sh` succeeds, `--print-address` returns the adapter address and `--list` shows the iPhone.
- [ ] **Step 2: Pairing.** With the phone's Settings > Bluetooth open, `--scan` lists the phone. `--pair` reports it's already paired. The user forgets this computer on the phone, then `--force-pair` shows a code and re-pairs after the user approves it on the phone.
- [ ] **Step 3: Connection.** The Task 3 smoke check returns the marker. The helper exits on stdin close, and also when Bluetooth is switched off on the phone during a run.
- [ ] **Step 4: Firewall.** The user runs `sudo ufw allow from <iphone-ip>`. Give them the removal command as well.
- [ ] **Step 5: Full session.** Follow the README's step 6 with `--bind`. Confirm that the phone joins, that the CarPlay prompt appears (this also shows whether the phone discovers the server over mDNS), that video appears in the browser and that touch works. Check the log for what happened with the iAP tunnel's secondary socket.
- [ ] **Step 6: Reconnection.** Drop the phone's link and confirm the server's supervisor reconnects.
- [ ] **Step 7: Record the results and update the docs.**
  - Note whether the phone accepted Wi-Fi channel 0. If it refused, mark `--wifi-channel` as required for Linux in the README's Quick start and troubleshooting.
  - Add what was validated on Linux to Status and limitations, in the same terms as the macOS sentence.
  - Commit any README change with the message `Record what was validated on Linux`.
