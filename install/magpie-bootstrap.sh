#!/bin/sh
# 幂等准备。逻辑在 magpie-bootstrap.mjs。--dry-run 不改配置。
set -eu
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec node "$here/magpie-bootstrap.mjs" "$@"
