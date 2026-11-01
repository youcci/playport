use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn run_without_bus(args: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_bt-bridge"))
        .args(args)
        .env("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/nonexistent/playport-test-bus")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _stdin = child.stdin.take();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            panic!("bt-bridge {args:?} is still running after 10s");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    child.stdout.take().unwrap().read_to_end(&mut stdout).unwrap();
    child.stderr.take().unwrap().read_to_end(&mut stderr).unwrap();
    Output { status: child.wait().unwrap(), stdout, stderr }
}

fn assert_clean_failure(args: &[&str]) {
    let output = run_without_bus(args);
    assert_eq!(output.status.code(), Some(1), "{args:?}");
    assert!(output.stdout.is_empty(), "{args:?}");
    assert!(String::from_utf8_lossy(&output.stderr).starts_with("bt-bridge: "), "{args:?}");
}

#[test]
fn every_bluetooth_command_fails_cleanly_without_a_bus() {
    for args in [&["--print-address"][..], &["--list"], &["--scan"],
                 &["--pair", "AA:BB:CC:DD:EE:FF"], &["--address", "AA:BB:CC:DD:EE:FF"]] {
        assert_clean_failure(args);
    }
}

#[test]
fn malformed_address_and_no_arguments_print_to_stderr() {
    for args in [&["--address", "nope"][..], &[]] {
        assert_clean_failure(args);
    }
}
