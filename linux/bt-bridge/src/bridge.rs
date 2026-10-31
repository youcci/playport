use std::future::Future;
use std::time::Duration;

use bluer::rfcomm::{Profile, ProfileHandle, Role, Stream};
use bluer::{Address, Device, Session, Uuid};
use futures::StreamExt;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::{log, open_adapter, require_powered};

const IAP2: Uuid = Uuid::from_u128(0x00000000_deca_fade_deca_deafdecacafe);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
pub enum DrainEnd<T> {
    Opened(T),
    StdinClosed,
}

#[derive(Debug, PartialEq)]
pub enum PumpEnd {
    StdinClosed,
    RfcommClosed,
}

// Link markers sent before the channel opens are stale by the time it does, so they are dropped.
pub async fn drain_until<I: AsyncRead + Unpin, T>(
    stdin: &mut I,
    open: impl Future<Output = T>,
) -> DrainEnd<T> {
    let mut open = std::pin::pin!(open);
    let mut buf = [0u8; 4096];
    loop {
        tokio::select! {
            opened = &mut open => return DrainEnd::Opened(opened),
            read = stdin.read(&mut buf) => match read {
                Ok(0) | Err(_) => return DrainEnd::StdinClosed,
                Ok(_) => {}
            },
        }
    }
}

pub async fn pump<I, O, R>(mut stdin: I, mut stdout: O, rfcomm: R) -> Result<PumpEnd, String>
where
    I: AsyncRead + Unpin,
    O: AsyncWrite + Unpin,
    R: AsyncRead + AsyncWrite + Unpin,
{
    let (mut rfcomm_read, mut rfcomm_write) = tokio::io::split(rfcomm);

    let to_rfcomm = async {
        let mut buf = [0u8; 4096];
        loop {
            let n = stdin.read(&mut buf).await.map_err(|e| format!("stdin read failed: {e}"))?;
            if n == 0 {
                return Ok(PumpEnd::StdinClosed);
            }
            rfcomm_write
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("RFCOMM write failed: {e}"))?;
            rfcomm_write.flush().await.map_err(|e| format!("RFCOMM write failed: {e}"))?;
        }
    };
    let to_stdout = async {
        let mut buf = [0u8; 4096];
        loop {
            let n = rfcomm_read.read(&mut buf).await.map_err(|e| format!("RFCOMM read failed: {e}"))?;
            if n == 0 {
                return Ok(PumpEnd::RfcommClosed);
            }
            stdout.write_all(&buf[..n]).await.map_err(|e| format!("stdout write failed: {e}"))?;
            stdout.flush().await.map_err(|e| format!("stdout write failed: {e}"))?;
        }
    };

    tokio::select! {
        end = to_rfcomm => end,
        end = to_stdout => end,
    }
}

async fn connect(
    session: &Session,
    device: &Device,
    address: Address,
) -> Result<(ProfileHandle, Stream), String> {
    let profile = Profile {
        uuid: IAP2,
        role: Some(Role::Client),
        require_authentication: Some(true),
        auto_connect: Some(false),
        ..Default::default()
    };
    let mut handle = session
        .register_profile(profile)
        .await
        .map_err(|e| format!("cannot register the iAP2 profile: {e}"))?;

    // BlueZ needs the request accepted while connect_profile is still running.
    let opened = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let (_, stream) = tokio::try_join!(
            async { device.connect_profile(&IAP2).await.map_err(|e| e.to_string()) },
            async { handle.next().await.ok_or("profile closed".to_string())?.accept().map_err(|e| e.to_string()) },
        )?;
        Ok::<_, String>(stream)
    })
    .await
    .map_err(|_| format!("timed out after 30s connecting to {address}; is it in range?"))?
    .map_err(|e| format!("RFCOMM open failed: {e}"))?;
    Ok((handle, opened))
}

pub async fn run(address: Address) -> Result<(), String> {
    let (session, adapter) = open_adapter().await?;
    require_powered(&adapter).await?;
    let device = adapter
        .device(address)
        .map_err(|e| format!("cannot look up device {address}: {e}"))?;
    if !device.is_paired().await.unwrap_or(false) {
        return Err(format!("device {address} is not paired; pair it with bt-bridge --pair first"));
    }

    log(&format!("RFCOMM channel opening to {address}"));
    let mut stdin = tokio::io::stdin();
    let (_handle, stream) = match drain_until(&mut stdin, connect(&session, &device, address)).await {
        DrainEnd::StdinClosed => {
            log("stdin closed");
            return Ok(());
        }
        DrainEnd::Opened(opened) => opened?,
    };
    log("RFCOMM channel open");

    match pump(stdin, tokio::io::stdout(), stream).await? {
        PumpEnd::RfcommClosed => log("RFCOMM channel closed"),
        PumpEnd::StdinClosed => log("stdin closed"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt, BufWriter};
    use tokio::time::{sleep, timeout};

    const MARKER: [u8; 6] = [0xff, 0x55, 0x02, 0x00, 0xee, 0x10];
    const LIMIT: Duration = Duration::from_secs(1);

    #[tokio::test]
    async fn bytes_before_open_are_discarded() {
        let (mut writer, mut stdin) = duplex(64);
        writer.write_all(&MARKER).await.unwrap();
        let open = async {
            sleep(Duration::from_millis(50)).await;
            7
        };
        let end = timeout(LIMIT, drain_until(&mut stdin, open)).await.unwrap();
        assert_eq!(end, DrainEnd::Opened(7));

        writer.write_all(b"after").await.unwrap();
        let mut buf = [0u8; 16];
        let n = timeout(LIMIT, stdin.read(&mut buf)).await.unwrap().unwrap();
        assert_eq!(&buf[..n], b"after");
    }

    #[tokio::test]
    async fn stdin_eof_before_open_stops_waiting() {
        let (writer, mut stdin) = duplex(64);
        drop(writer);
        let end = timeout(LIMIT, drain_until(&mut stdin, std::future::pending::<()>()))
            .await
            .unwrap();
        assert_eq!(end, DrainEnd::StdinClosed);
    }

    #[tokio::test]
    async fn pump_moves_bytes_both_ways_and_flushes_stdout() {
        let (mut stdin_writer, stdin) = duplex(64);
        let (stdout_inner, mut stdout_reader) = duplex(64);
        let stdout = BufWriter::new(stdout_inner);
        let (rfcomm, mut peer) = duplex(64);
        let task = tokio::spawn(pump(stdin, stdout, rfcomm));

        stdin_writer.write_all(&MARKER).await.unwrap();
        let mut buf = [0u8; 6];
        timeout(LIMIT, peer.read_exact(&mut buf)).await.unwrap().unwrap();
        assert_eq!(buf, MARKER);

        peer.write_all(b"reply").await.unwrap();
        let mut out = [0u8; 5];
        timeout(LIMIT, stdout_reader.read_exact(&mut out)).await.unwrap().unwrap();
        assert_eq!(&out, b"reply");
        assert!(!task.is_finished());
        task.abort();
    }

    #[tokio::test]
    async fn pump_ends_when_rfcomm_closes_while_stdin_is_idle() {
        let (_stdin_writer, stdin) = duplex(64);
        let (stdout, _stdout_reader) = duplex(64);
        let (rfcomm, peer) = duplex(64);
        drop(peer);
        let end = timeout(LIMIT, pump(stdin, stdout, rfcomm)).await.unwrap();
        assert_eq!(end, Ok(PumpEnd::RfcommClosed));
    }

    #[tokio::test]
    async fn pump_ends_when_stdin_closes() {
        let (stdin_writer, stdin) = duplex(64);
        let (stdout, _stdout_reader) = duplex(64);
        let (rfcomm, _peer) = duplex(64);
        drop(stdin_writer);
        let end = timeout(LIMIT, pump(stdin, stdout, rfcomm)).await.unwrap();
        assert_eq!(end, Ok(PumpEnd::StdinClosed));
    }

    #[tokio::test]
    async fn pump_fails_when_stdout_is_gone() {
        let (_stdin_writer, stdin) = duplex(64);
        let (stdout, stdout_reader) = duplex(64);
        drop(stdout_reader);
        let (rfcomm, mut peer) = duplex(64);
        peer.write_all(b"x").await.unwrap();
        let end = timeout(LIMIT, pump(stdin, stdout, rfcomm)).await.unwrap();
        assert!(end.is_err());
    }
}
