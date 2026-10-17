package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// 第一条 user 后保持运行并继续读 stdin，模拟长工具和后台任务期间的 CLI。
// 每帧回显完整输入，只有 finish 才结束回合，避免靠旧回合 result 放行而误报成功。
func fakeSteerClaude(sid, mode string) {
	dec, enc := json.NewDecoder(os.Stdin), json.NewEncoder(os.Stdout)
	for {
		var f map[string]any
		if err := dec.Decode(&f); err != nil {
			if err != io.EOF {
				os.Exit(9)
			}
			return
		}
		_ = enc.Encode(map[string]any{"type": "test_received", "frame": f, "pid": os.Getpid(), "route": mode})
		if f["type"] == "control_request" {
			if f["request"].(map[string]any)["subtype"] == "deferred" {
				continue
			}
			_ = enc.Encode(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": f["request_id"], "response": map[string]any{}}})
			continue
		}
		if f["type"] != "user" {
			continue
		}
		msg, _ := f["message"].(map[string]any)
		switch msg["content"] {
		case "hold":
			_ = enc.Encode(map[string]any{"type": "system", "subtype": "task_started", "task_id": "long-tool", "session_id": sid})
			_ = enc.Encode(map[string]any{"type": "control_request", "request_id": "permission-1", "request": map[string]any{"subtype": "can_use_tool"}})
		case "finish":
			_ = enc.Encode(map[string]any{"type": "system", "subtype": "task_notification", "task_id": "long-tool", "session_id": sid})
			_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid})
		case "result-background":
			_ = enc.Encode(map[string]any{"type": "system", "subtype": "task_started", "task_id": "long-tool", "session_id": sid})
			_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid})
		case "result-permission":
			_ = enc.Encode(map[string]any{"type": "control_request", "request_id": "permission-1", "request": map[string]any{"subtype": "can_use_tool"}})
			_ = enc.Encode(map[string]any{"type": "result", "subtype": "success", "session_id": sid})
		case "exit-busy":
			os.Exit(17)
		}
	}
}

func TestResultWithPendingWorkStillForwardsToCurrentChild(t *testing.T) {
	for _, pending := range []string{"background", "permission", "control"} {
		t.Run(pending, func(t *testing.T) {
			f := newFixture(t, "local")
			cache := filepath.Join(f.home, "xdg-cache")
			a := startApp(t, f, "MIRASIM_TEST_ROLE=steer", "XDG_CACHE_HOME="+cache)
			message := "result-" + pending
			if pending == "control" {
				message = "start"
			}
			a.user(t, message)
			first := a.receivedWithin(t, 5*time.Second)
			var permission map[string]any
			if pending == "permission" {
				permission = a.until(t, "control_request")
			}
			if pending == "control" {
				a.send(t, map[string]any{"type": "control_request", "request_id": "pending", "request": map[string]any{"subtype": "deferred"}})
				a.receivedWithin(t, time.Second)
				a.user(t, "finish")
				a.receivedWithin(t, time.Second)
			}
			a.until(t, "result")
			f.route(t, "cloud")
			a.user(t, "steer-after-result")
			echo := a.receivedWithin(t, time.Second)
			if echo["pid"] != first["pid"] || echo["route"] != "local" {
				t.Fatalf("旧回合尚有 %s 时必须留在当前执行体：%v", pending, echo)
			}
			if pending == "permission" {
				a.send(t, map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": permission["request_id"], "response": map[string]any{}}})
				a.receivedWithin(t, time.Second)
			}
			if pending == "control" {
				a.send(t, map[string]any{"type": "control_cancel_request", "request_id": "pending"})
				a.receivedWithin(t, time.Second)
			}
			a.user(t, "finish")
			a.receivedWithin(t, time.Second)
			a.until(t, "result")
			_ = a.in.Close()
			if err := waitEnded(t, a); err != nil {
				t.Fatal(err)
			}
			log := launchLogOf(t, f, cache)
			if strings.Count(log, "event=launch ") != 1 || strings.Count(log, "event=route-resolved ") != 1 {
				t.Fatalf("有未决任务时发生了重选路或重启：%s", log)
			}
		})
	}
}

func (a *app) receivedWithin(t *testing.T, budget time.Duration) map[string]any {
	t.Helper()
	deadline := time.NewTimer(budget)
	defer deadline.Stop()
	for {
		select {
		case f, ok := <-a.frames:
			if !ok {
				b, _ := os.ReadFile(a.errFile.Name())
				t.Fatalf("收到引导前执行体退出：%s", b)
			}
			a.received = append(a.received, f)
			if f["type"] == "result" {
				t.Fatal("引导必须在旧回合 result 之前送达")
			}
			if f["type"] == "test_received" {
				return f
			}
		case <-deadline.C:
			t.Fatal("运行中的执行体没有及时收到引导")
		}
	}
}

func TestBusySteersReachSameChildBeforeResult(t *testing.T) {
	for _, routeChange := range []string{"cloud", "corrupt"} {
		t.Run(routeChange, func(t *testing.T) {
			f := newFixture(t, "local")
			cache := filepath.Join(f.home, "xdg-cache")
			a := startApp(t, f, "MIRASIM_TEST_ROLE=steer", "XDG_CACHE_HOME="+cache)
			a.user(t, "hold")
			first := a.receivedWithin(t, 5*time.Second)
			permission := a.until(t, "control_request")
			if routeChange == "corrupt" {
				if err := os.WriteFile(f.index, []byte("{broken"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				f.route(t, routeChange)
			}
			for i := 0; i < 3; i++ {
				steer := map[string]any{"type": "user", "uuid": string(rune('a' + i)), "session_id": f.sid, "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "引导"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "synthetic"}}}}, "extra": map[string]any{"preserve": true}}
				a.send(t, steer)
				echo := a.receivedWithin(t, time.Second)
				if echo["pid"] != first["pid"] || echo["route"] != "local" || !reflect.DeepEqual(echo["frame"], steer) {
					t.Fatalf("引导必须完整且按序到同一执行体：%v", echo)
				}
			}
			// 仍有后台任务和权限请求时，引导不被阻塞；控制回复的 ID 映射保持有效。
			a.send(t, map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": permission["request_id"], "response": map[string]any{"behavior": "allow"}}})
			echo := a.receivedWithin(t, time.Second)
			if echo["frame"].(map[string]any)["response"].(map[string]any)["request_id"] != "permission-1" {
				t.Fatalf("权限回复未还原当前执行体 ID：%v", echo)
			}
			a.send(t, map[string]any{"type": "control_request", "request_id": "host-model", "request": map[string]any{"subtype": "set_model", "model": "claude-sonnet-5"}})
			a.receivedWithin(t, time.Second)
			a.until(t, "control_response")
			log := launchLogOf(t, f, cache)
			if strings.Count(log, "event=launch ") != 1 || strings.Count(log, "event=route-resolved ") != 1 || strings.Contains(log, "event=switch ") {
				t.Fatalf("运行中引导不能重选路或重建执行体：%s", log)
			}
			// 完成后才允许下一轮按最新路由重建进程。
			f.route(t, "cloud")
			a.user(t, "finish")
			a.receivedWithin(t, time.Second)
			a.until(t, "result")
			a.user(t, "next-idle-turn")
			next := a.receivedWithin(t, 5*time.Second)
			if next["pid"] == first["pid"] || next["route"] != "cloud" {
				t.Fatalf("空闲回合应切到最新路由的新执行体：%v", next)
			}
			a.user(t, "finish")
			a.until(t, "result")
			_ = a.in.Close()
			if err := waitEnded(t, a); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestBusyChildExitFailsWithoutReplayingSteers(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startApp(t, f, "MIRASIM_TEST_ROLE=steer", "XDG_CACHE_HOME="+cache)
	a.user(t, "hold")
	a.receivedWithin(t, 5*time.Second)
	a.until(t, "control_request")
	f.route(t, "cloud")
	a.user(t, "exit-busy")
	a.receivedWithin(t, time.Second)
	if waitEnded(t, a) == nil {
		t.Fatal("在途执行体退出不能报告成功")
	}
	log := launchLogOf(t, f, cache)
	if strings.Count(log, "event=launch ") != 1 || !strings.Contains(log, "执行体提前退出") {
		t.Fatalf("在途失败必须明确报错，不能换路重放：%s", log)
	}
}

func TestBusySteersDrainBeforeInputEOFCompletes(t *testing.T) {
	f := newFixture(t, "cloud")
	a := startApp(t, f, "MIRASIM_TEST_ROLE=steer")
	a.user(t, "hold")
	first := a.receivedWithin(t, 5*time.Second)
	permission := a.until(t, "control_request")
	a.send(t, map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": permission["request_id"], "response": map[string]any{}}})
	a.receivedWithin(t, time.Second)
	for _, text := range []string{"steer-1", "steer-2", "finish"} {
		a.user(t, text)
	}
	_ = a.in.Close()
	for _, text := range []string{"steer-1", "steer-2", "finish"} {
		echo := a.receivedWithin(t, time.Second)
		content := echo["frame"].(map[string]any)["message"].(map[string]any)["content"]
		if echo["pid"] != first["pid"] || content != text {
			t.Fatalf("EOF 前的引导未按序完整交给当前执行体：%v", echo)
		}
	}
	a.until(t, "result")
	if err := waitEnded(t, a); err != nil {
		t.Fatal(err)
	}
	for f := range a.frames {
		if f["type"] == "test_received" {
			t.Fatalf("EOF 收尾时重复投递：%v", f)
		}
	}
}

func TestQueuedUsersWaitForSDKReplayAndDrainBeforeEOF(t *testing.T) {
	f := newFixture(t, "local")
	a := startApp(t, f, "MIRASIM_TEST_REQUIRE_INIT=1", "MIRASIM_TEST_DELAY_REPLAY=1")
	a.send(t, map[string]any{"type": "control_request", "request_id": "host-init", "request": map[string]any{"subtype": "initialize"}})
	a.until(t, "control_response")
	first := a.turn(t, "first")
	f.route(t, "cloud")
	a.user(t, "after-replay-1")
	a.user(t, "after-replay-2")
	_ = a.in.Close()
	for _, text := range []string{"after-replay-1", "after-replay-2"} {
		echo := a.until(t, "assistant")["observed"].(map[string]any)
		if echo["initialized"] != true || echo["content"] != text || echo["pid"] == first["pid"] || echo["route"] != "cloud" || echo["resume"] != f.sid {
			t.Fatalf("恢复必须先初始化并保持原生会话，再按序交付用户消息：%v", echo)
		}
		a.until(t, "result")
	}
	if err := waitEnded(t, a); err != nil {
		t.Fatal(err)
	}
	responses := 0
	for _, f := range a.received {
		if f["type"] == "control_response" {
			responses++
		}
	}
	if responses != 1 {
		t.Fatalf("SDK replay 响应不应重复发给宿主：%d", responses)
	}
}
