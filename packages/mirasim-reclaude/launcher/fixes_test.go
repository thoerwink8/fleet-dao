package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 启动器日志位置随平台变；夹具把缓存目录指进临时 home。
func launchLogOf(t *testing.T, f fixture, cache string) string {
	t.Helper()
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
	return string(b)
}

func waitEnded(t *testing.T, a *app) error {
	t.Helper()
	select {
	case err := <-a.ended:
		return err
	case <-time.After(8 * time.Second):
		t.Fatal("启动器没有退出")
	}
	return nil
}

// Mirasim 的用量探测：用启动命令起 stream-json，不带 --model 和会话 ID，第一帧就是 control_request get_usage。
// 没有会话就没有用户可选的路由，跟 Mirasim 的注入走，不能报「无法确定当前 Mirasim 会话」退出 1。
func TestUsageProbeWithoutSessionFollowsInjection(t *testing.T) {
	f := newFixture(t, "local")
	_ = os.RemoveAll(filepath.Join(f.home, ".mirasim"))
	cache := filepath.Join(f.home, "xdg-cache")
	a := startAppArgs(t, f, []string{"-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json"}, "XDG_CACHE_HOME="+cache)
	a.send(t, map[string]any{"type": "control_request", "request_id": "usage-1", "request": map[string]any{"subtype": "get_usage"}})
	r := a.until(t, "control_response")
	resp, _ := r["response"].(map[string]any)
	if resp["subtype"] != "success" || resp["request_id"] != "usage-1" {
		t.Fatalf("用量探测没有拿到回复：%v", r)
	}
	_ = a.in.Close()
	if err := waitEnded(t, a); err != nil {
		b, _ := os.ReadFile(a.errFile.Name())
		t.Fatalf("用量探测退出失败：%v %s", err, b)
	}
	log := launchLogOf(t, f, cache)
	if !strings.Contains(log, "event=launch route=gateway gateway=kept") {
		t.Fatalf("没有会话时应按注入原样交出：\n%s", log)
	}
	if strings.Contains(log, "error=") {
		t.Fatalf("用量探测被记成失败：\n%s", log)
	}
}

// 无关会话的 record.json 坏了，不能让所有新会话都起不来：自己的记录直接读到就不扫全部。
func TestCorruptUnrelatedRecordDoesNotBlockSession(t *testing.T) {
	f := newFixture(t, "local")
	other := filepath.Join(f.home, ".mirasim", "sessions", "claude", "other-session", "record.json")
	if err := os.MkdirAll(filepath.Dir(other), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(other, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	a := startApp(t, f)
	if x := a.turn(t, "first"); x["route"] != "local" {
		t.Fatalf("无关会话记录坏了不该挡住这个会话：%v", x)
	}
}

// default(保留网关) 与 cloud、实际都保留网关：切换不重启进程。
func TestSwitchBetweenEquivalentRoutesKeepsProcess(t *testing.T) {
	f := newFixture(t, "")
	a := startApp(t, f)
	x := a.turn(t, "first")
	f.route(t, "cloud")
	y := a.turn(t, "second")
	if x["route"] != "cloud" || y["route"] != "cloud" || x["pid"] != y["pid"] {
		t.Fatalf("default(保留)↔cloud 结果一样，不该重启：%v %v", x, y)
	}
	f.route(t, "")
	z := a.turn(t, "third")
	if z["pid"] != y["pid"] {
		t.Fatalf("cloud→default(保留) 不该重启：%v", z)
	}
}

// default(没网关) 与 local、实际都不带网关：切换不重启进程。
func TestSwitchBetweenEquivalentOwnRoutesKeepsProcess(t *testing.T) {
	f := newFixture(t, "")
	a := startAppSettings(t, f, `{"env":{"KEEP_ME":"yes"}}`, noEnvGateway...)
	x := a.turn(t, "first")
	f.route(t, "local")
	y := a.turn(t, "second")
	if x["route"] != "local" || y["route"] != "local" || x["pid"] != y["pid"] {
		t.Fatalf("default(无网关)↔local 结果一样，不该重启：%v %v", x, y)
	}
}

// 索引说自有、注入里却有带令牌的回环网关：先隔 300ms 重读索引，索引改成平台就跟着平台。
func TestLocalWithInjectedGatewayRereadsIndex(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startApp(t, f, "XDG_CACHE_HOME="+cache)
	go func() {
		time.Sleep(100 * time.Millisecond)
		b, _ := json.Marshal(map[string]any{"routes": map[string]string{"claude:" + f.sid: "cloud"}, "keys": []string{"claude:" + f.sid}})
		tmp := f.index + ".tmp"
		_ = os.WriteFile(tmp, b, 0600)
		replaceAtomically(tmp, f.index)
	}()
	if x := a.turn(t, "first"); x["route"] != "cloud" {
		t.Fatalf("重读后索引已是平台，应走平台：%v", x)
	}
	if log := launchLogOf(t, f, cache); strings.Contains(log, "event=route-conflict") {
		t.Fatalf("重读后不矛盾就不该记冲突：\n%s", log)
	}
}

// 重读 3 次仍矛盾：按索引执行，日志记 event=route-conflict。
func TestLocalWithInjectedGatewayStillConflictingFollowsIndexAndLogs(t *testing.T) {
	f := newFixture(t, "local")
	cache := filepath.Join(f.home, "xdg-cache")
	a := startApp(t, f, "XDG_CACHE_HOME="+cache)
	at := time.Now()
	if x := a.turn(t, "first"); x["route"] != "local" {
		t.Fatalf("仍矛盾时按索引走自有：%v", x)
	}
	if time.Since(at) < 800*time.Millisecond {
		t.Fatalf("矛盾时应重读 3 次（各隔 300ms），实际只用了 %v", time.Since(at))
	}
	log := launchLogOf(t, f, cache)
	if !strings.Contains(log, "event=route-conflict route=local injected=gateway sid="+f.sid) {
		t.Fatalf("没记 route-conflict：\n%s", log)
	}
	// 进程起来以后注入是旧快照，之后的回合不再拿它比。
	_ = a.turn(t, "second")
	if n := strings.Count(launchLogOf(t, f, cache), "event=route-conflict"); n != 1 {
		t.Fatalf("同一进程后续回合不该再判冲突：%d", n)
	}
}

// 多个索引：索引按 Mirasim 服务端工作区根目录的 base64url 命名，会话在哪个索引的 keys 里就属于哪个。
// 会话工作目录是根目录下的子目录时，旧代码拿 workspacePath/cwd 去比文件名，永远对不上。
func TestDefaultRouteWithSeveralIndexesFindsOwner(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "root")
	sub := filepath.Join(root, "repo", "sub")
	if err := os.MkdirAll(sub, 0700); err != nil {
		t.Fatal(err)
	}
	sid := "12345678-1234-4234-8234-123456789abc"
	dir := filepath.Join(home, "plugin-index")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	write := func(name string, v any) {
		b, _ := json.Marshal(v)
		if err := os.WriteFile(filepath.Join(dir, name), b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	owner := base64.RawURLEncoding.EncodeToString([]byte(root)) + ".json"
	write(owner, map[string]any{"keys": []string{"claude:" + sid}, "routes": map[string]string{}, "workdirs": map[string]string{"claude:" + sid: sub}})
	write(base64.RawURLEncoding.EncodeToString([]byte(filepath.Join(home, "elsewhere")))+".json", map[string]any{"keys": []string{"claude:someone-else"}, "routes": map[string]string{"claude:someone-else": "local"}})
	rec := filepath.Join(home, "sessions", "claude", sid, "record.json")
	_ = os.MkdirAll(filepath.Dir(rec), 0700)
	b, _ := json.Marshal(map[string]any{"sessionId": sid, "nativeSessionId": sid, "workdir": sub, "workspacePath": filepath.Join(home, "sessions", "claude", sid, "workspace")})
	_ = os.WriteFile(rec, b, 0600)
	r := routeResolver{home: home, cwd: sub}
	sel, err := r.resolve(sid)
	if err != nil {
		t.Fatalf("两个索引、会话没设路由时应找到它所属的索引：%v", err)
	}
	if sel.mode != "default" || filepath.Base(sel.index) != owner {
		t.Fatalf("选错索引：%+v", sel)
	}
	// 没登记在任何索引的 keys 里：退回按命名规则，从工作目录往上找根目录对应的索引文件。
	write(owner, map[string]any{"routes": map[string]string{"claude:" + sid: "cloud"}})
	r = routeResolver{home: home, cwd: sub}
	if sel, err = r.resolve(sid); err != nil || sel.mode != "cloud" || filepath.Base(sel.index) != owner {
		t.Fatalf("按根目录命名规则应找到索引：%+v %v", sel, err)
	}
}

// 原生 ID 对不上直接读到的记录时才扫全部；那时有读不了的记录就明确失败。
func TestUnmatchedNativeIDScansAndFailsOnCorruptRecord(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "plugin-index")
	_ = os.MkdirAll(dir, 0700)
	_ = os.WriteFile(filepath.Join(dir, "w.json"), []byte(`{"routes":{}}`), 0600)
	bad := filepath.Join(home, "sessions", "claude", "x", "record.json")
	_ = os.MkdirAll(filepath.Dir(bad), 0700)
	_ = os.WriteFile(bad, []byte("{broken"), 0600)
	r := routeResolver{home: home, cwd: home}
	if _, err := r.resolve("native-only"); err == nil {
		t.Fatal("扫全部时有坏记录，不能当没有这个会话")
	}
}

// BASE_URL 和令牌分处进程环境与 settings 时，两处都剥，不把 Mirasim 令牌留给 reclaude。
func TestOwnRouteStripsGatewaySplitAcrossEnvAndSettings(t *testing.T) {
	cases := []struct {
		name     string
		settings string
		env      []string
	}{
		{"地址在环境、令牌在 settings", `{"env":{"ANTHROPIC_AUTH_TOKEN":"mirasim-token","KEEP_ME":"1"}}`, []string{"ANTHROPIC_BASE_URL=http://127.0.0.1:1/x", "PATH=/bin"}},
		{"地址在 settings、令牌在环境", `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1/x","KEEP_ME":"1"}}`, []string{"ANTHROPIC_AUTH_TOKEN=mirasim-token", "PATH=/bin"}},
	}
	for _, c := range cases {
		args, env, temps, word, err := applyRouteSettings("local", []string{"--settings", c.settings}, c.env)
		for _, p := range temps {
			_ = os.Remove(p)
		}
		if err != nil {
			t.Fatalf("%s：%v", c.name, err)
		}
		if word != "stripped" {
			t.Fatalf("%s：gateway=%s", c.name, word)
		}
		if strings.Join(env, " ") != "PATH=/bin" {
			t.Fatalf("%s：环境没剥干净：%v", c.name, env)
		}
		var d map[string]map[string]any
		if err := json.Unmarshal([]byte(args[1]), &d); err != nil {
			t.Fatal(err)
		}
		if len(d["env"]) != 1 || d["env"]["KEEP_ME"] != "1" {
			t.Fatalf("%s：settings 没剥干净：%v", c.name, d)
		}
	}
	// 合并后生效的是人配的非回环上游：两处都不动。
	args, env, _, word, err := applyRouteSettings("local", []string{"--settings", `{"env":{"ANTHROPIC_BASE_URL":"https://gw.example.com"}}`}, []string{"ANTHROPIC_AUTH_TOKEN=t"})
	if err != nil || word != "none" || len(env) != 1 || !strings.Contains(args[1], "gw.example.com") {
		t.Fatalf("非回环上游被动了：%v %v %s %v", args, env, word, err)
	}
}
