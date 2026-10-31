use std::time::Duration;

use bluer::agent::{Agent, ReqError};
use bluer::{Adapter, AdapterEvent, Address, DiscoveryFilter, DiscoveryTransport, Session};
use futures::{pin_mut, FutureExt, StreamExt};

use crate::cli::{confirm_line, passkey_line, scan_line};
use crate::{log, require_powered};

const SCAN_TIME: Duration = Duration::from_secs(10);
const FIND_TIME: Duration = Duration::from_secs(20);
const PAIR_TIME: Duration = Duration::from_secs(45);

struct Seen {
    address: Address,
    name: Option<String>,
    paired: bool,
    in_range: bool,
    printed: bool,
}

// Collects scan events so each in-range device prints once, as soon as its name is known.
pub struct ScanReport {
    seen: Vec<Seen>,
}

impl ScanReport {
    pub fn new() -> Self {
        ScanReport { seen: Vec::new() }
    }

    pub fn observe(&mut self, address: Address, name: Option<&str>, paired: bool, in_range: bool) -> Option<String> {
        let index = match self.seen.iter().position(|s| s.address == address) {
            Some(index) => index,
            None => {
                self.seen.push(Seen { address, name: None, paired, in_range: false, printed: false });
                self.seen.len() - 1
            }
        };
        let entry = &mut self.seen[index];
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            entry.name = Some(name.to_string());
        }
        entry.paired = paired;
        entry.in_range |= in_range;
        if entry.printed || !entry.in_range || entry.name.is_none() {
            return None;
        }
        entry.printed = true;
        Some(scan_line(address, entry.name.as_deref(), paired))
    }

    pub fn finish(self) -> Vec<String> {
        self.seen
            .into_iter()
            .filter(|s| s.in_range && !s.printed)
            .map(|s| scan_line(s.address, s.name.as_deref(), s.paired))
            .collect()
    }
}

fn br_edr() -> DiscoveryFilter {
    DiscoveryFilter { transport: DiscoveryTransport::BrEdr, ..Default::default() }
}

pub async fn scan(adapter: &Adapter) -> Result<(), String> {
    require_powered(adapter).await?;
    adapter.set_discovery_filter(br_edr()).await.map_err(|e| format!("cannot set the discovery filter: {e}"))?;
    log("scanning for 10s — keep the iPhone's Bluetooth settings page open");
    let events = adapter
        .discover_devices_with_changes()
        .await
        .map_err(|e| format!("cannot start scanning: {e}"))?;
    pin_mut!(events);
    let mut report = ScanReport::new();
    let deadline = tokio::time::sleep(SCAN_TIME);
    pin_mut!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            event = events.next() => match event {
                Some(AdapterEvent::DeviceAdded(address)) => {
                    let Ok(device) = adapter.device(address) else { continue };
                    let name = device.name().await.ok().flatten();
                    let paired = device.is_paired().await.unwrap_or(false);
                    let in_range = matches!(device.rssi().await, Ok(Some(_)));
                    if let Some(line) = report.observe(address, name.as_deref(), paired, in_range) {
                        println!("{line}");
                    }
                }
                Some(_) => {}
                None => break,
            }
        }
    }
    for line in report.finish() {
        println!("{line}");
    }
    Ok(())
}

async fn find(adapter: &Adapter, address: Address) -> Result<(), String> {
    let not_found = || format!(
        "device {address} was not found; make sure it is discoverable (Bluetooth settings open) and try again"
    );
    let events = adapter
        .discover_devices_with_changes()
        .await
        .map_err(|e| format!("cannot start scanning: {e}"))?;
    pin_mut!(events);
    let wait = async {
        while let Some(event) = events.next().await {
            if let AdapterEvent::DeviceAdded(found) = event {
                if found != address {
                    continue;
                }
                let Ok(device) = adapter.device(found) else { continue };
                if matches!(device.rssi().await, Ok(Some(_))) {
                    return true;
                }
            }
        }
        false
    };
    match tokio::time::timeout(FIND_TIME, wait).await {
        Ok(true) => Ok(()),
        _ => Err(not_found()),
    }
}

pub async fn pair(session: &Session, adapter: &Adapter, address: Address, force: bool) -> Result<(), String> {
    require_powered(adapter).await?;
    adapter.set_discovery_filter(br_edr()).await.map_err(|e| format!("cannot set the discovery filter: {e}"))?;
    if force {
        let _ = adapter.remove_device(address).await;
    } else if let Ok(device) = adapter.device(address) {
        if device.is_paired().await.unwrap_or(false) {
            println!("{address} is already paired; nothing to do.");
            log("start the server with --wireless and it will find the iPhone (or check --list)");
            return Ok(());
        }
    }

    let agent = Agent {
        request_default: true,
        request_confirmation: Some(Box::new(|req| {
            async move {
                println!("{}", confirm_line(req.passkey));
                Ok(())
            }
            .boxed()
        })),
        display_passkey: Some(Box::new(|req| {
            async move {
                println!("{}", passkey_line(req.passkey));
                Ok(())
            }
            .boxed()
        })),
        request_pin_code: Some(Box::new(|_| {
            async move {
                log("the device requested a legacy PIN code; this helper supports numeric pairing only");
                Err(ReqError::Rejected)
            }
            .boxed()
        })),
        ..Default::default()
    };
    let _agent = session
        .register_agent(agent)
        .await
        .map_err(|e| format!("cannot register the pairing agent: {e}"))?;

    let failed = |e: bluer::Error| format!("pairing failed: {e}; remove any stale pairing from the phone and retry");
    let work = async {
        find(adapter, address).await?;
        let device = adapter.device(address).map_err(failed)?;
        device.pair().await.map_err(failed)?;
        device.set_trusted(true).await.map_err(|e| format!("cannot trust {address}: {e}"))
    };
    match tokio::time::timeout(PAIR_TIME, work).await {
        Ok(result) => result?,
        Err(_) => {
            return Err("pairing timed out after 45s; make sure the iPhone is awake and unlocked with Settings > Bluetooth open, then retry".into())
        }
    }
    println!("paired with {address}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::parse_address;

    const ADDR: &str = "AA:BB:CC:DD:EE:FF";
    fn addr() -> bluer::Address { parse_address(ADDR).unwrap() }

    #[test] fn cached_device_out_of_range_prints_nothing() {
        let mut report = ScanReport::new();
        assert_eq!(report.observe(addr(), Some("JBL"), true, false), None);
        assert!(report.finish().is_empty());
    }
    #[test] fn in_range_device_prints_once() {
        let mut report = ScanReport::new();
        assert_eq!(report.observe(addr(), Some("iPhone"), false, true).as_deref(), Some("AA:BB:CC:DD:EE:FF iPhone [new]"));
        assert_eq!(report.observe(addr(), Some("iPhone"), false, true), None);
    }
    #[test] fn name_arriving_late_is_used() {
        let mut report = ScanReport::new();
        assert_eq!(report.observe(addr(), None, false, true), None);
        assert_eq!(report.observe(addr(), Some("iPhone"), false, true).as_deref(), Some("AA:BB:CC:DD:EE:FF iPhone [new]"));
        assert!(report.finish().is_empty());
    }
    #[test] fn device_that_never_gets_a_name_prints_at_the_end() {
        let mut report = ScanReport::new();
        assert_eq!(report.observe(addr(), None, false, true), None);
        assert_eq!(report.finish(), vec!["AA:BB:CC:DD:EE:FF [new]".to_string()]);
    }
}
