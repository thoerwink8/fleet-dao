#!/usr/bin/env bash
# 本机档装机入口（#451）：在 fleet-local 里以 root 跑，等价于 FLEET_PROFILE=local bash deploy/france.sh "$@"——
# 包这一层只是不用每次都记 FLEET_PROFILE 这个变量名（deploy/lib/profile.sh 讲了为什么是环境变量、不是配置文件里
# 一项）。装什么、跳过什么见 deploy/local/desired-config.json 里每一项的「说明」，和 docs/ops.md「本机环境
# （fleet-local）」那节。
#   bash deploy/local/install.sh           装：缺的补上，已有的不动
#   bash deploy/local/install.sh --check   只读回和自检，不改任何东西
set -Eeuo pipefail
DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec env FLEET_PROFILE=local bash "$DIR/../france.sh" "$@"
