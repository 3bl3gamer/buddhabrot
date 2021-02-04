#!/bin/bash

function build {
    # https://habr.com/ru/post/454868/
    clang \
        --target=wasm32 \
        -Ofast `#https://stackoverflow.com/a/45688463` \
        -flto \
        -nostdlib \
        -Wl,--no-entry \
        -Wl,--export-all \
        -Wl,--lto-O3 \
        -Wl,-z,stack-size=1024 \
        -o "$2" \
        "$1"
}

build render.c render.wasm
build image_data.c image_data.wasm
