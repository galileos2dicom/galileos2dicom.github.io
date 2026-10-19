#!/bin/bash
# Сборка wasm-библиотеки в pkg/.
# Нужны: rustup target add wasm32-unknown-unknown
#        cargo install wasm-bindgen-cli --version <версия wasm-bindgen из Cargo.toml>
# Необязательно: wasm-opt (binaryen) для уменьшения размера.
set -euo pipefail

# Сюда ставит cargo install
export PATH="$HOME/.cargo/bin:$PATH"

cargo build --release --target wasm32-unknown-unknown

wasm-bindgen --target no-modules --no-typescript --out-dir pkg \
    target/wasm32-unknown-unknown/release/galileos2dicom_web.wasm

if command -v wasm-opt > /dev/null; then
    wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int \
        -o pkg/galileos2dicom_web_bg.wasm pkg/galileos2dicom_web_bg.wasm
fi
