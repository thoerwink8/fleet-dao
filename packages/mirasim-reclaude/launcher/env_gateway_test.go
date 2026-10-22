package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 夹具默认往进程环境里放平台网关；要模拟「Mirasim 这次没给网关」就把这两个键清空（后写的覆盖前面的）。
var noEnvGateway = []string{"ANTHROPIC_BASE_URL=", "ANTHROPIC_AUTH_TOKEN="}

// 平台网关也可能只经进程环境传、--settings 不带 env（启动器两处都认，防别的版本这么传）。
// 会话没单独选路由（跟随全局档位）时，环境里有网关就是平台，必须原样保留，不能剥成自有。
func TestDefaultRouteKeepsGatewayGivenOnlyInEnv(t *testing.T) {
	f := newFixture(t, "")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startAppSettings(t, f, `{"outputStyle":"Concise"}`, "XDG_CACHE_HOME="+cache)
	x := a.turn(t, "follow-global")
	if x["route"] != "cloud" {
		t.Fatalf("跟随全局且环境里有平台网关，应走平台：%v", x)
	}
	dir := cache
	switch runtime.GOOS {
	case "windows":
		dir = filepath.Join(f.home, "cache")
	case "darwin":
		dir = filepath.Join(f.home, "Library", "Caches")
	}
	b, err := os.ReadFile(filepath.Join(dir, "reclaude-mirasim", "launch.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "route=default gateway=kept") {
		t.Fatalf("launch 行应记 gateway=kept：\n%s", b)
	}
}

// 明确选平台、网关只在环境里：照常起，不当成注入缺失。
func TestCloudRouteAcceptsGatewayGivenOnlyInEnv(t *testing.T) {
	f := newFixture(t, "cloud")
	a := startAppSettings(t, f, `{"outputStyle":"Concise"}`)
	if x := a.turn(t, "platform"); x["route"] != "cloud" {
		t.Fatalf("选平台且环境里有网关，应走平台：%v", x)
	}
}

// 跟随全局、Mirasim 这次没给网关（全局档位是自有）：走自有。
func TestDefaultRouteWithoutAnyGatewayRunsOwn(t *testing.T) {
	f := newFixture(t, "")
	a := startAppSettings(t, f, `{"outputStyle":"Concise"}`, noEnvGateway...)
	if x := a.turn(t, "own"); x["route"] != "local" {
		t.Fatalf("没有任何网关应走自有：%v", x)
	}
}

// 选自有时环境里的平台网关照样剥掉。
func TestLocalRouteStripsGatewayGivenOnlyInEnv(t *testing.T) {
	f := newFixture(t, "local")
	a := startAppSettings(t, f, `{"outputStyle":"Concise"}`)
	if x := a.turn(t, "own"); x["route"] != "local" {
		t.Fatalf("选自有应剥掉环境里的网关：%v", x)
	}
}
