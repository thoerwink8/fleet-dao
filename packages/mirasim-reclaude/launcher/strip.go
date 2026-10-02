package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"strings"
)

// Mirasim（0.0.354 起）不再经进程 env 注入上游，而是把
// ANTHROPIC_BASE_URL=http://127.0.0.1:<端口>/<会话令牌> 写进 `--settings <临时文件>` 的 env 块。
// reclaude 只清进程 env，清不到这个文件 ⇒ claude 把请求交给 Mirasim 本地网关，
// 网关再以 Mirasim.exe 身份转发，reclaude 服务端判 non_cc_client 拒掉（还会上报，有设备解绑风险）。
// 剥掉这三个键，claude 就回落到 ~/.claude/settings.json 的 reclaude 代理 + OAuth 占位令牌。
var injectedKeys = []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"}

// 只剥指向本机回环的 BASE_URL（= Mirasim 网关）；指向别处的是人有意配的上游，不碰。
func isLoopbackURL(raw string) bool {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	switch strings.ToLower(u.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// stripSettings 返回剥过的 settings JSON；changed=false 时原样返回 in。
func settingsDocument(in []byte) (map[string]any, map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(in))
	dec.UseNumber()
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		return nil, nil, fmt.Errorf("settings 不是 JSON 对象")
	}
	if doc == nil {
		return nil, nil, fmt.Errorf("settings 不能为空")
	}
	var tail any
	if dec.Decode(&tail) != io.EOF {
		return nil, nil, fmt.Errorf("settings 有额外内容")
	}
	if _, found := doc["env"]; !found {
		return doc, nil, nil
	}
	env, ok := doc["env"].(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("settings env 不是对象")
	}
	for _, value := range env {
		if _, ok := value.(string); !ok {
			return nil, nil, fmt.Errorf("settings env 值不是字符串")
		}
	}
	return doc, env, nil
}

func stripSettings(in []byte) (out []byte, changed bool, err error) {
	doc, env, err := settingsDocument(in)
	if err != nil {
		return in, false, err
	}
	if env == nil {
		return in, false, nil
	}
	base, _ := env["ANTHROPIC_BASE_URL"].(string)
	if !isLoopbackURL(base) {
		return in, false, nil
	}
	for _, k := range injectedKeys {
		delete(env, k)
	}
	out, err = json.Marshal(doc)
	if err != nil {
		return in, false, err
	}
	return out, true, nil
}

// stripEnv 按同一判据清进程 env（Windows 上变量名不分大小写）。
func stripEnv(environ []string) (out []string, changed bool) {
	get := func(name string) string {
		for _, kv := range environ {
			if i := strings.IndexByte(kv, '='); i > 0 && strings.EqualFold(kv[:i], name) {
				return kv[i+1:]
			}
		}
		return ""
	}
	if !isLoopbackURL(get("ANTHROPIC_BASE_URL")) {
		return environ, false
	}
	for _, kv := range environ {
		i := strings.IndexByte(kv, '=')
		drop := false
		if i > 0 {
			for _, k := range injectedKeys {
				if strings.EqualFold(kv[:i], k) {
					drop = true
				}
			}
		}
		if !drop {
			out = append(out, kv)
		}
	}
	return out, true
}
