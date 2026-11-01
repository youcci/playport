use bluer::Address;

#[derive(Debug, PartialEq)]
pub enum Command {
    PrintAddress,
    List,
    Scan,
    Pair { address: Address, force: bool },
    Bridge { address: Address },
}

pub const USAGE: &str = "usage: bt-bridge --print-address | --list | --scan | --pair <addr> | --force-pair <addr> | --address <addr>";

pub fn parse_args(args: &[String]) -> Result<Command, String> {
    let usage = || USAGE.to_string();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["--print-address"] => Ok(Command::PrintAddress),
        ["--list"] => Ok(Command::List),
        ["--scan"] => Ok(Command::Scan),
        ["--pair", text] => Ok(Command::Pair { address: parse_address(text)?, force: false }),
        ["--force-pair", text] => Ok(Command::Pair { address: parse_address(text)?, force: true }),
        ["--address", text] => Ok(Command::Bridge { address: parse_address(text)? }),
        _ => Err(usage()),
    }
}

pub fn parse_address(text: &str) -> Result<Address, String> {
    let well_formed = text.len() == 17
        && text.bytes().enumerate().all(|(i, b)| {
            if i % 3 == 2 { b == b':' } else { b.is_ascii_hexdigit() }
        });
    if !well_formed {
        return Err(format!("invalid Bluetooth address '{text}'; expected AA:BB:CC:DD:EE:FF"));
    }
    text.parse().map_err(|_| format!("invalid Bluetooth address '{text}'; expected AA:BB:CC:DD:EE:FF"))
}

fn join(parts: &[&str]) -> String {
    parts.iter().copied().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

pub fn device_line(address: Address, name: Option<&str>) -> String {
    join(&[&address.to_string(), name.unwrap_or("")])
}

pub fn scan_line(address: Address, name: Option<&str>, paired: bool) -> String {
    let kind = if paired { "[paired]" } else { "[new]" };
    join(&[&address.to_string(), name.unwrap_or(""), kind])
}

pub fn confirm_line(passkey: u32) -> String {
    format!("confirm this code on the iPhone: {passkey:06}")
}

pub fn passkey_line(passkey: u32) -> String {
    format!("enter this passkey on the iPhone: {passkey:06}")
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
