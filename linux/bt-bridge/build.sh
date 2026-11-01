#!/bin/sh
# Builds the Linux Bluetooth RFCOMM bridge helper.
set -e
cd "$(dirname "$0")"
cargo build --release --locked
cp target/release/bt-bridge bt-bridge
echo "built: $(pwd)/bt-bridge"
