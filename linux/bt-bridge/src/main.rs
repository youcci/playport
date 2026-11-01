// playport Linux Bluetooth bridge. See macos/bt-bridge/main.swift for the commands it mirrors.

mod bridge;
mod pairing;
mod cli;

use bluer::{Adapter, Session};
use cli::Command;

pub fn log(message: &str) {
    eprintln!("bt-bridge: {message}");
}

pub async fn open_adapter() -> Result<(Session, Adapter), String> {
    let unavailable = |e: bluer::Error| {
        format!("cannot reach the Bluetooth adapter ({e}); is bluetooth.service running?")
    };
    let session = Session::new().await.map_err(unavailable)?;
    let adapter = session.default_adapter().await.map_err(unavailable)?;
    Ok((session, adapter))
}

pub async fn require_powered(adapter: &Adapter) -> Result<(), String> {
    match adapter.is_powered().await {
        Ok(true) => Ok(()),
        Ok(false) => Err("Bluetooth adapter is powered off; turn it on with: bluetoothctl power on".into()),
        Err(e) => Err(format!("cannot read the Bluetooth adapter state: {e}")),
    }
}

async fn print_address() -> Result<(), String> {
    let (_session, adapter) = open_adapter().await?;
    let address = adapter
        .address()
        .await
        .map_err(|e| format!("local Bluetooth address unavailable: {e}"))?;
    println!("{address}");
    Ok(())
}

async fn list_paired() -> Result<(), String> {
    let (_session, adapter) = open_adapter().await?;
    let unavailable = |e: bluer::Error| format!("paired device list unavailable: {e}");
    for address in adapter.device_addresses().await.map_err(unavailable)? {
        let device = adapter.device(address).map_err(unavailable)?;
        if device.is_paired().await.map_err(unavailable)? {
            let name = device.name().await.map_err(unavailable)?;
            println!("{}", cli::device_line(address, name.as_deref()));
        }
    }
    Ok(())
}

async fn run(command: Command) -> Result<(), String> {
    match command {
        Command::PrintAddress => print_address().await,
        Command::List => list_paired().await,
        Command::Bridge { address } => bridge::run(address).await,
        Command::Scan => {
            let (_session, adapter) = open_adapter().await?;
            pairing::scan(&adapter).await
        }
        Command::Pair { address, force } => {
            let (session, adapter) = open_adapter().await?;
            pairing::pair(&session, &adapter, address, force).await
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match cli::parse_args(&args) {
        Ok(command) => run(command).await,
        Err(message) => Err(message),
    };
    // Exit explicitly: tokio's stdin read runs on a blocking thread that would otherwise hold up runtime shutdown.
    match result {
        Ok(()) => std::process::exit(0),
        Err(message) => {
            eprintln!("bt-bridge: {message}");
            std::process::exit(1);
        }
    }
}
