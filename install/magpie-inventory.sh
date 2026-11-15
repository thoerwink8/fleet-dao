#!/bin/sh
# 只读汇总。逻辑在 magpie-inventory.mjs。
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec node "$here/magpie-inventory.mjs" "$@"
