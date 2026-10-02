package main

import (
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"testing"
)

// 金样：2026-09-24 本机 Mirasim 0.0.354 实际写出的 --settings 文件形态（令牌已换假值）。
const mirasimSettings = `{"autoCompactWindow":900000,"switchModelsOnFlag":false,"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:53982/Y-tok","ANTHROPIC_AUTH_TOKEN":"a","ANTHROPIC_API_KEY":"b","KEEP_ME":"1"},"outputStyle":"Concise"}`

func envOf(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var d map[string]any
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	e, _ := d["env"].(map[string]any)
	return e
}

func TestStripSettingsRemovesLoopbackInjection(t *testing.T) {
	out, changed, err := stripSettings([]byte(mirasimSettings))
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	if got := envOf(t, out); !reflect.DeepEqual(got, map[string]any{"KEEP_ME": "1"}) {
		t.Fatalf("env = %v", got)
	}
	var d map[string]any
	json.Unmarshal(out, &d)
	if d["autoCompactWindow"] != float64(900000) || d["outputStyle"] != "Concise" {
		t.Fatalf("其余键被动了：%v", d)
	}
}

func TestStripSettingsKeepsNonLoopbackUpstream(t *testing.T) {
	in := `{"env":{"ANTHROPIC_BASE_URL":"https://gw.example.com/v1","ANTHROPIC_AUTH_TOKEN":"a"}}`
	out, changed, err := stripSettings([]byte(in))
	if err != nil || changed || string(out) != in {
		t.Fatalf("changed=%v err=%v out=%s", changed, err, out)
	}
}

func TestStripSettingsNoEnvOrBadJSON(t *testing.T) {
	for _, in := range []string{`{"outputStyle":"x"}`, `not json`} {
		out, changed, _ := stripSettings([]byte(in))
		if changed || string(out) != in {
			t.Fatalf("%q: changed=%v out=%s", in, changed, out)
		}
	}
}

func TestStripEnvCaseInsensitive(t *testing.T) {
	in := []string{"anthropic_base_url=http://localhost:1/x", "ANTHROPIC_API_KEY=k", "Anthropic_Auth_Token=t", "PATH=/bin", "HTTPS_PROXY=http://127.0.0.1:57529"}
	out, changed := stripEnv(in)
	sort.Strings(out)
	if !changed || !reflect.DeepEqual(out, []string{"HTTPS_PROXY=http://127.0.0.1:57529", "PATH=/bin"}) {
		t.Fatalf("changed=%v out=%v", changed, out)
	}
	keep := []string{"ANTHROPIC_BASE_URL=https://gw.example.com", "ANTHROPIC_API_KEY=k"}
	if out, changed := stripEnv(keep); changed || !reflect.DeepEqual(out, keep) {
		t.Fatalf("非回环上游被剥了：%v", out)
	}
}

func TestRewriteArgsFileAndInline(t *testing.T) {
	f, _ := os.CreateTemp(t.TempDir(), "s-*.json")
	f.WriteString(mirasimSettings)
	f.Close()

	args := []string{"-p", "--settings", f.Name(), "--model", "m", "--settings=" + mirasimSettings}
	out, temps, changed, err := rewriteArgs(args)
	if err != nil {
		t.Fatal(err)
	}
	if len(temps) != 1 {
		t.Fatalf("临时副本数量 = %d", len(temps))
	}
	tmp := temps[0]
	defer os.Remove(tmp)
	if !changed || tmp == "" || out[2] != tmp {
		t.Fatalf("changed=%v tmp=%q out=%v", changed, tmp, out)
	}
	b, _ := os.ReadFile(tmp)
	if got := envOf(t, b); !reflect.DeepEqual(got, map[string]any{"KEEP_ME": "1"}) {
		t.Fatalf("临时文件 env = %v", got)
	}
	orig, _ := os.ReadFile(f.Name())
	if string(orig) != mirasimSettings {
		t.Fatal("改了 Mirasim 的原文件")
	}
	if out[0] != "-p" || out[3] != "--model" || out[4] != "m" {
		t.Fatalf("其余参数被动了：%v", out)
	}
	var inline map[string]any
	if err := json.Unmarshal([]byte(out[5][len("--settings="):]), &inline); err != nil {
		t.Fatal(err)
	}
	if _, has := inline["env"].(map[string]any)["ANTHROPIC_BASE_URL"]; has {
		t.Fatal("内联 settings 没剥")
	}
}

func TestRewriteArgsUnreadableFileFails(t *testing.T) {
	args := []string{"--settings", "Z:/no/such.json"}
	out, temps, changed, err := rewriteArgs(args)
	if err == nil || changed || len(temps) != 0 || out != nil {
		t.Fatalf("读失败没有明确失败：err=%v changed=%v", err, changed)
	}
}

func TestInvalidSettingsNeverBecomeValidStrippedSettings(t *testing.T) {
	for _, in := range []string{`null`, `{"env":null}`, `{"env":[]}`, `{"env":{"ANTHROPIC_BASE_URL":42}}`, mirasimSettings + ` {"later":true}`} {
		if _, _, err := stripSettings([]byte(in)); err == nil {
			t.Fatalf("无效 settings 被当作可用：%s", in)
		}
	}
}
