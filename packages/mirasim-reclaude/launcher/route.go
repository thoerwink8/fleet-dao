package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type selection struct{ mode, sessionID, index string }
type routeResolver struct{ home, cwd, sessionID, index string }

func flagValue(args []string, name string) string {
	for i, a := range args {
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
		if strings.HasPrefix(a, name+"=") {
			return strings.TrimPrefix(a, name+"=")
		}
	}
	return ""
}

func sessionArgument(args []string) string {
	for _, k := range []string{"--session-id", "--resume", "-r"} {
		if s := flagValue(args, k); s != "" {
			return s
		}
	}
	return ""
}

func isClaudeModel(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return true
	}
	for _, p := range []string{"claude-", "opus", "sonnet", "haiku"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func safeID(id string) bool {
	return id != "" && id != "." && id != ".." && !strings.ContainsAny(id, "/\\\x00")
}

func (r *routeResolver) resolve(native string) (selection, error) {
	if r.index != "" {
		return readSelection(r.index, r.sessionID)
	}
	if !safeID(native) {
		return selection{}, fmt.Errorf("无法确定当前 Mirasim 会话，未发送请求")
	}
	names, err := os.ReadDir(filepath.Join(r.home, "plugin-index"))
	if err != nil {
		return selection{}, fmt.Errorf("路由索引目录读失败，未发送请求")
	}
	indexes := []string{}
	for _, n := range names {
		s := n.Name()
		if !n.IsDir() && strings.HasSuffix(s, ".json") && !strings.HasSuffix(s, ".queue.json") && !strings.HasSuffix(s, ".deleted.json") {
			indexes = append(indexes, filepath.Join(r.home, "plugin-index", s))
		}
	}
	if len(indexes) == 0 {
		return selection{}, fmt.Errorf("没有可读的路由索引，未发送请求")
	}
	// native ID 可以与 Mirasim ID 不同。映射歧义只允许由实际工作目录排除，不能取首条。
	type record struct {
		SessionID string `json:"sessionId"`
		NativeID  string `json:"nativeSessionId"`
		Workdir   string `json:"workdir"`
		Workspace string `json:"workspacePath"`
	}
	candidates := []record{}
	records, err := filepath.Glob(filepath.Join(r.home, "sessions", "claude", "*", "record.json"))
	if err != nil {
		return selection{}, fmt.Errorf("列会话记录失败")
	}
	for _, p := range records {
		b, err := os.ReadFile(p)
		if err != nil {
			return selection{}, fmt.Errorf("会话记录读失败，未发送请求")
		}
		var x record
		if json.Unmarshal(b, &x) != nil {
			return selection{}, fmt.Errorf("会话记录格式错误，未发送请求")
		}
		if x.SessionID == native || x.NativeID == native {
			if !safeID(x.SessionID) {
				return selection{}, fmt.Errorf("会话身份格式错误")
			}
			candidates = append(candidates, x)
		}
	}
	if len(candidates) > 1 {
		filtered := []record{}
		for _, x := range candidates {
			if samePath(x.Workdir, r.cwd) {
				filtered = append(filtered, x)
			}
		}
		candidates = filtered
		if len(candidates) != 1 {
			return selection{}, fmt.Errorf("原生会话匹配多个 Mirasim 会话，未发送请求")
		}
	}
	sid, workspace := native, ""
	if len(candidates) == 1 {
		sid = candidates[0].SessionID
		workspace = candidates[0].Workspace
	}
	type match struct {
		p    string
		mode string
	}
	matches := []match{}
	for _, p := range indexes {
		s, err := readSelection(p, sid)
		if err != nil {
			return selection{}, err
		}
		if s.mode != "default" {
			matches = append(matches, match{p, s.mode})
		}
	}
	if len(matches) > 1 {
		filtered := []match{}
		for _, m := range matches {
			if indexForWorkspace(m.p, workspace) || indexForWorkspace(m.p, r.cwd) {
				filtered = append(filtered, m)
			}
		}
		if len(filtered) != 1 {
			return selection{}, fmt.Errorf("多个工作区对同一会话记录路由，未发送请求")
		}
		matches = filtered
	}
	p := ""
	if len(matches) == 1 {
		p = matches[0].p
	} else {
		for _, candidate := range indexes {
			if indexForWorkspace(candidate, workspace) || indexForWorkspace(candidate, r.cwd) {
				if p != "" && p != candidate {
					return selection{}, fmt.Errorf("默认路由的工作区不唯一")
				}
				p = candidate
			}
		}
		if p == "" && len(indexes) == 1 {
			p = indexes[0]
		}
		if p == "" {
			return selection{}, fmt.Errorf("找不到当前会话所属索引，未发送请求")
		}
	}
	r.index, r.sessionID = p, sid
	return readSelection(p, sid)
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	aa, ea := filepath.Abs(a)
	bb, eb := filepath.Abs(b)
	return ea == nil && eb == nil && filepath.Clean(aa) == filepath.Clean(bb)
}

func indexForWorkspace(p, workspace string) bool {
	return workspace != "" && filepath.Base(p) == workspaceIndexName(workspace)
}

func readSelection(p, sid string) (selection, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return selection{}, fmt.Errorf("当前会话路由索引读失败，未发送请求")
	}
	var d map[string]json.RawMessage
	if json.Unmarshal(b, &d) != nil || d == nil {
		return selection{}, fmt.Errorf("路由索引不是有效 JSON，未发送请求")
	}
	routes := map[string]string{}
	if b, ok := d["routes"]; ok {
		if json.Unmarshal(b, &routes) != nil || routes == nil {
			return selection{}, fmt.Errorf("路由表格式错误，未发送请求")
		}
	}
	mode, found := routes["claude:"+sid]
	if !found {
		mode = "default"
	} else if mode != "local" && mode != "cloud" {
		return selection{}, fmt.Errorf("当前会话路由值不认识，未发送请求")
	}
	return selection{mode: mode, sessionID: sid, index: p}, nil
}
