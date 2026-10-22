package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 排查「启动慢」靠这几行耗时日志：每次拉起执行体、每个回合都要有毫秒数，且不带任何会话内容。
func TestLaunchLogRecordsTimingWithoutContent(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startApp(t, f, "XDG_CACHE_HOME="+cache)
	_ = a.turn(t, "secret-user-text")
	_ = a.in.Close()
	select {
	case <-a.ended:
	case <-time.After(3 * time.Second):
		t.Fatal("会话没有在输入结束后退出")
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
	log := string(b)
	for _, want := range []string{"event=route-resolved", "event=launch", "sinceProcessMs=", "event=target-spawned", "event=first-frame", "event=turn-first-output", "event=turn-result"} {
		if !strings.Contains(log, want) {
			t.Fatalf("耗时日志缺 %s：\n%s", want, log)
		}
	}
	for _, line := range strings.Split(log, "\n") {
		// 自有会话把 Mirasim 回环网关剥掉：对账靠这个词，且只记词、不记地址。
		if strings.Contains(line, "event=launch ") && !strings.Contains(line, " gateway=stripped ") {
			t.Fatalf("launch 行没记 gateway=stripped：%s", line)
		}
		if strings.Contains(line, "event=first-frame") || strings.Contains(line, "event=turn-result") {
			if !strings.Contains(line, " ms=") {
				t.Fatalf("没有毫秒数：%s", line)
			}
		}
	}
	if strings.Contains(log, "secret-user-text") || strings.Contains(log, "synthetic-only") || strings.Contains(log, "127.0.0.1:12345") {
		t.Fatalf("耗时日志泄漏了会话内容或凭据：\n%s", log)
	}
}
