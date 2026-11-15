#!/bin/sh
# 只读核对。逻辑在 magpie-verify.mjs。
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec node "$here/magpie-verify.mjs" "$@"
