package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 按 --replay-user-messages 的真实行为回显：读进一条 user 先回显 isReplay，再出这一回合。
// swallow 模拟「写进了管道却没被读进」：不回显、不输出；bg 模拟主回合结束、后台任务还在跑。
func fakeReplayClaude(sid string) {
	dec, enc := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var f map[string]any
		if err := dec.Decode(&f); err != nil {
			if err != io.EOF {
				os.Exit(9)
			}
			return
		}
		if f["type"] != "user" {
			continue
		}
		msg, _ := f["message"].(map[string]any)
		if msg["content"] == "swallow" {
			continue
		}
		_ = enc.Encode(map[string]any{"type": "user", "message": msg, "session_id": sid, "parent_tool_use_id": nil, "isReplay": true, "pid": os.Getpid()})
		if msg["content"] == "bg" {
			_ = enc.Encode(map[string]any{"type": "system", "subtype": "task_started", "task_id": "bg-1", "session_id": sid})
		}
		_ = enc.Encode(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []any{}}, "session_id": sid})
		_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid, "is_error": false})
	}
}

func startReplayApp(t *testing.T, f fixture, cache string) *app {
	return startAppArgs(t, f, []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--replay-user-messages", "--model", "claude-sonnet-5", "--session-id", f.sid, "--settings", `{}`}, "MIRASIM_TEST_ROLE=replay", "XDG_CACHE_HOME="+cache, "RECLAUDE_MIRASIM_DELIVERY_STALL_MS=300")
}

// 10-16 的现场：主回合已结束、后台还在跑，新消息转给了执行体却没被读进。启动器要当场回报错，不能无声挂着。
func TestUnreadUserWhileIdleWithBackgroundReturnsVisibleError(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startReplayApp(t, f, cache)
	a.user(t, "bg")
	a.until(t, "result")
	a.user(t, "swallow")
	r := a.until(t, "result")
	if r["is_error"] != true || r["result"] != deliveryStallMessage || r["session_id"] != f.sid {
		t.Fatalf("没送到的消息必须回报错 result：%v", r)
	}
	log := launchLogOf(t, f, cache)
	for _, want := range []string{"event=user-forward path=active idle=true len=7", "event=user-stalled "} {
		if !strings.Contains(log, want) {
			t.Fatalf("日志缺 %q：%s", want, log)
		}
	}
}

func TestEchoedUsersAreAckedWithoutStallError(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startReplayApp(t, f, cache)
	a.user(t, "bg")
	a.until(t, "result")
	a.user(t, "after-background")
	echo := a.until(t, "user")
	if echo["isReplay"] != true {
		t.Fatalf("回显必须原样交给 Mirasim：%v", echo)
	}
	if r := a.until(t, "result"); r["is_error"] != false {
		t.Fatalf("回执到了不该报错：%v", r)
	}
	select {
	case x, ok := <-a.frames:
		if ok {
			t.Fatalf("已销账的消息又出了帧：%v", x)
		}
	case <-time.After(700 * time.Millisecond):
	}
	if log := launchLogOf(t, f, cache); strings.Count(log, "event=user-ack ") != 2 || strings.Contains(log, "event=user-stalled") {
		t.Fatalf("两条都应销账、不判卡住：%s", log)
	}
}

// 没确认读进的消息还在旧执行体里时，换路由不能重启它，下一条照常交给同一个执行体。
func TestUnackedUserKeepsCurrentChildAcrossRouteChange(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startReplayApp(t, f, cache)
	a.user(t, "first")
	first := a.until(t, "user")
	a.until(t, "result")
	a.user(t, "swallow")
	for deadline := time.Now().Add(3 * time.Second); !strings.Contains(launchLogOf(t, f, cache), "path=turn idle=true len=7"); {
		if time.Now().After(deadline) {
			t.Fatal("swallow 没有转给执行体")
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.route(t, "cloud")
	a.user(t, "next")
	next := a.until(t, "user")
	if next["pid"] != first["pid"] {
		t.Fatalf("有未销账的消息时不能换执行体：%v vs %v", next, first)
	}
	_ = a.in.Close()
	if err := waitEnded(t, a); err != nil {
		t.Fatal(err)
	}
	log := launchLogOf(t, f, cache)
	if strings.Count(log, "event=launch ") != 1 || strings.Contains(log, "event=switch ") || !strings.Contains(log, "event=user-unacked reason=exit n=1") {
		t.Fatalf("未销账时不能重选路重启，退出时要记下没送到的条数：%s", log)
	}
}
