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

// 以下是回显与待确认消息的关联规则（见 delivery.go 文件头），直接测 deliveries，不起启动器。
func userFrame(t *testing.T, uuid string, content any) frame {
	t.Helper()
	m := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}}
	if uuid != "" {
		m["uuid"] = uuid
	}
	b, _ := json.Marshal(m)
	f, err := parseFrame(b)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func echoFrame(t *testing.T, uuid string, content any) frame {
	f := userFrame(t, uuid, content)
	f["isReplay"] = json.RawMessage("true")
	return f
}

func trackedDeliveries(t *testing.T, frames ...frame) *deliveries {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	d := &deliveries{tracking: true, stallAfter: time.Minute}
	for _, f := range frames {
		d.forwarded(f, "active", true)
	}
	return d
}

func pendingTexts(d *deliveries) []string {
	out := []string{}
	for _, p := range d.pending {
		out = append(out, p.text)
	}
	return out
}

func TestOnlySecondEchoAcksOnlySecondMessage(t *testing.T) {
	short, long := "继续", "继续原任务，先不要改配置"
	for name, order := range map[string][]string{"短在前": {short, long}, "长在前": {long, short}} {
		t.Run(name, func(t *testing.T) {
			d := trackedDeliveries(t, userFrame(t, "", order[0]), userFrame(t, "", order[1]))
			d.observe(echoFrame(t, "", order[1]))
			if got := pendingTexts(d); len(got) != 1 || got[0] != order[0] {
				t.Fatalf("只收到第二条的精确回显，只能销第二条，第一条仍 pending：%v", got)
			}
			if d.unacked() != 1 || !d.blocking() {
				t.Fatalf("第一条没确认，执行体不能算空闲：unacked=%d", d.unacked())
			}
		})
	}
}

func TestEchoMustEqualNotContainPendingMessage(t *testing.T) {
	for name, echo := range map[string]any{
		"回显包含待确认正文":   "继续原任务，先不要改配置",
		"前缀包装":        "[引导] 继续",
		"后缀包装":        "继续 （已读）",
		"完全不匹配":       "另一件事",
		"空回显":         "",
		"只有图片":        []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}},
		"文本加图片的混合内容":  []any{map[string]any{"type": "text", "text": "继续"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}},
		"文本块拼接后只是子串": []any{map[string]any{"type": "text", "text": "继续"}, map[string]any{"type": "text", "text": "原任务"}},
	} {
		t.Run(name, func(t *testing.T) {
			d := trackedDeliveries(t, userFrame(t, "", "继续"))
			d.observe(echoFrame(t, "", echo))
			if len(d.pending) != 1 {
				t.Fatalf("不精确相等的回显不能销账：%v", pendingTexts(d))
			}
		})
	}
	// 唯一允许的包装规则：首尾空白不算。
	d := trackedDeliveries(t, userFrame(t, "", "继续"))
	d.observe(echoFrame(t, "", " 继续\n"))
	if len(d.pending) != 0 {
		t.Fatal("只差首尾空白的回显应当销账")
	}
}

func TestOneEchoAcksAtMostOneOfDuplicateMessages(t *testing.T) {
	d := trackedDeliveries(t, userFrame(t, "", "继续"), userFrame(t, "", "继续"))
	d.observe(echoFrame(t, "", "继续"))
	if len(d.pending) != 1 {
		t.Fatalf("同正文两条，一次回显只能销一条：%d", len(d.pending))
	}
	d.observe(echoFrame(t, "", "继续"))
	if len(d.pending) != 0 {
		t.Fatal("第二次回显销第二条")
	}
	d.observe(echoFrame(t, "", "继续"))
	if len(d.pending) != 0 {
		t.Fatal("多余的回显不能凭空销别的")
	}
}

func TestUUIDIdentityBeatsTextAndNeverCrossAcks(t *testing.T) {
	// 回显带 uuid：销的是 uuid 相同那条，不是更早的同正文无 uuid 消息。
	d := trackedDeliveries(t, userFrame(t, "", "继续"), userFrame(t, "u2", "继续"))
	d.observe(echoFrame(t, "u2", "继续"))
	if len(d.pending) != 1 || d.pending[0].uuid != "" {
		t.Fatalf("应只销 uuid=u2 那条：%+v", d.pending)
	}
	// 双方 uuid 不同，正文一样也不是同一条。
	d = trackedDeliveries(t, userFrame(t, "u1", "继续"))
	d.observe(echoFrame(t, "other", "继续"))
	if len(d.pending) != 1 {
		t.Fatal("uuid 不同不能靠正文顶替")
	}
	// 带 uuid 的图片消息：正文不可用，只能靠 uuid 销账。
	img := []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}}
	d = trackedDeliveries(t, userFrame(t, "img1", img), userFrame(t, "", "继续"))
	d.observe(echoFrame(t, "", img))
	if len(d.pending) != 2 {
		t.Fatal("没有 uuid 的纯图片回显不能销任何一条")
	}
	d.observe(echoFrame(t, "img1", img))
	if got := pendingTexts(d); len(got) != 1 || got[0] != "继续" {
		t.Fatalf("按 uuid 只销图片那条：%v", got)
	}
}

func TestMessagesWithoutIdentityAreNotTracked(t *testing.T) {
	img := []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}}
	mixed := []any{map[string]any{"type": "text", "text": "看图"}, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "data": "x"}}}
	d := trackedDeliveries(t, userFrame(t, "", ""), userFrame(t, "", "  \n"), userFrame(t, "", img))
	if len(d.pending) != 0 || d.blocking() {
		t.Fatalf("空正文、纯图片且无 uuid 无法判定，不记账也不挡路由：%v", pendingTexts(d))
	}
	// 混合内容无 uuid：同样无法判定，其回显也不能被当成纯文本“看图”去销别的消息。
	d = trackedDeliveries(t, userFrame(t, "", mixed), userFrame(t, "", "看图"))
	if len(d.pending) != 1 {
		t.Fatalf("混合内容无 uuid 不记账，纯文本照常记：%v", pendingTexts(d))
	}
	d.observe(echoFrame(t, "", mixed))
	if len(d.pending) != 1 {
		t.Fatal("混合内容的回显不能销纯文本“看图”")
	}
}

func TestNonReplayAndSubagentFramesNeverAck(t *testing.T) {
	d := trackedDeliveries(t, userFrame(t, "", "继续"))
	d.observe(userFrame(t, "", "继续"))
	sub := echoFrame(t, "", "继续")
	sub.set("parent_tool_use_id", "toolu_1")
	d.observe(sub)
	if len(d.pending) != 1 {
		t.Fatal("非 isReplay 或子代理帧不能销账")
	}
}
