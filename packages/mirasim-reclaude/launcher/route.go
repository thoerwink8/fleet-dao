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

type sessionRecord struct {
	SessionID string `json:"sessionId"`
	NativeID  string `json:"nativeSessionId"`
	Workdir   string `json:"workdir"`
}

// findRecord 找原生会话对应的 Mirasim 会话记录。先直接读 sessions/claude/<native>/record.json，
// 命中就不扫全部：无关会话的记录坏了不能挡住所有新会话。对不上才扫全部，那时读不了才失败。
func (r *routeResolver) findRecord(native string) (sessionRecord, bool, error) {
	direct := filepath.Join(r.home, "sessions", "claude", native, "record.json")
	var x sessionRecord
	if err := readJSONFile(direct, &x); err == nil {
		if x.SessionID == native || x.NativeID == native {
			if !safeID(x.SessionID) {
				return sessionRecord{}, false, fmt.Errorf("会话身份格式错误")
			}
			return x, true, nil
		}
	} else if !isNotExist(err) {
		return sessionRecord{}, false, fmt.Errorf("当前会话记录读失败或格式错误，未发送请求")
	}
	// native ID 可以与 Mirasim ID 不同。映射歧义只允许由实际工作目录排除，不能取首条。
	records, err := filepath.Glob(filepath.Join(r.home, "sessions", "claude", "*", "record.json"))
	if err != nil {
		return sessionRecord{}, false, fmt.Errorf("列会话记录失败")
	}
	candidates := []sessionRecord{}
	for _, p := range records {
		if p == direct {
			continue
		}
		var x sessionRecord
		if err := readJSONFile(p, &x); err != nil {
			if isNotExist(err) {
				continue // 扫的时候会话被删了
			}
			return sessionRecord{}, false, fmt.Errorf("会话记录读失败或格式错误，未发送请求")
		}
		if x.SessionID == native || x.NativeID == native {
			if !safeID(x.SessionID) {
				return sessionRecord{}, false, fmt.Errorf("会话身份格式错误")
			}
			candidates = append(candidates, x)
		}
	}
	if len(candidates) > 1 {
		filtered := []sessionRecord{}
		for _, x := range candidates {
			if samePath(x.Workdir, r.cwd) {
				filtered = append(filtered, x)
			}
		}
		if len(filtered) != 1 {
			return sessionRecord{}, false, fmt.Errorf("原生会话匹配多个 Mirasim 会话，未发送请求")
		}
		candidates = filtered
	}
	if len(candidates) == 1 {
		return candidates[0], true, nil
	}
	return sessionRecord{}, false, nil
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
	paths := []string{}
	for _, n := range names {
		s := n.Name()
		if !n.IsDir() && strings.HasSuffix(s, ".json") && !strings.HasSuffix(s, ".queue.json") && !strings.HasSuffix(s, ".deleted.json") {
			paths = append(paths, filepath.Join(r.home, "plugin-index", s))
		}
	}
	if len(paths) == 0 {
		return selection{}, fmt.Errorf("没有可读的路由索引，未发送请求")
	}
	rec, found, err := r.findRecord(native)
	if err != nil {
		return selection{}, err
	}
	sid, workdir := native, ""
	if found {
		sid, workdir = rec.SessionID, rec.Workdir
	}
	type loaded struct {
		p     string
		sel   selection
		owner bool
	}
	indexes := []loaded{}
	for _, p := range paths {
		doc, err := loadIndex(p)
		if err != nil {
			return selection{}, err
		}
		sel, err := doc.selection(p, sid)
		if err != nil {
			return selection{}, err
		}
		indexes = append(indexes, loaded{p, sel, doc.owns(sid)})
	}
	// Mirasim 一个服务端工作区根目录一份索引，文件名是根目录路径的 base64url；
	// 会话登记在哪份索引的 keys/workdirs 里，就归哪份。没登记的按命名规则从工作目录往上找根目录。
	named := namedIndex(paths, workdir, r.cwd)
	pick := func(from []loaded, what string) (loaded, error) {
		if len(from) == 1 {
			return from[0], nil
		}
		owners := []loaded{}
		for _, x := range from {
			if x.owner {
				owners = append(owners, x)
			}
		}
		if len(owners) == 1 {
			return owners[0], nil
		}
		if len(owners) == 0 {
			for _, x := range from {
				if x.p == named {
					return x, nil
				}
			}
		}
		return loaded{}, fmt.Errorf("%s，未发送请求", what)
	}
	routed := []loaded{}
	for _, x := range indexes {
		if x.sel.mode != "default" {
			routed = append(routed, x)
		}
	}
	var chosen loaded
	if len(routed) > 0 {
		chosen, err = pick(routed, "多个工作区对同一会话记录路由")
	} else {
		chosen, err = pick(indexes, "找不到当前会话所属索引")
	}
	if err != nil {
		return selection{}, err
	}
	r.index, r.sessionID = chosen.p, sid
	return chosen.sel, nil
}

// namedIndex 按 Mirasim 的命名规则找索引：从会话工作目录（其次启动器 cwd）往上逐级，
// 第一个「路径的 base64url.json」存在的就是该工作区根目录的索引。Mirasim 只在真实路径与给定路径仅大小写不同时改用真实路径，两种都试。
func namedIndex(paths []string, dirs ...string) string {
	have := map[string]string{}
	for _, p := range paths {
		have[filepath.Base(p)] = p
	}
	for _, d := range dirs {
		if d == "" {
			continue
		}
		for _, start := range spellings(d) {
			for p := start; ; {
				if hit, ok := have[workspaceIndexName(p)]; ok {
					return hit
				}
				parent := filepath.Dir(p)
				if parent == p {
					break
				}
				p = parent
			}
		}
	}
	return ""
}

func spellings(d string) []string {
	out := []string{d}
	if abs, err := filepath.Abs(d); err == nil && abs != d {
		out = append(out, abs)
	}
	if real, err := filepath.EvalSymlinks(d); err == nil && real != d && strings.EqualFold(real, d) {
		out = append(out, real)
	}
	return out
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	aa, ea := filepath.Abs(a)
	bb, eb := filepath.Abs(b)
	return ea == nil && eb == nil && filepath.Clean(aa) == filepath.Clean(bb)
}

type indexDoc struct {
	routes   map[string]string
	keys     map[string]bool
	workdirs map[string]bool
}

func loadIndex(p string) (indexDoc, error) {
	var d map[string]json.RawMessage
	if err := readJSONFile(p, &d); err != nil || d == nil {
		if err != nil && !isParseFailure(err) {
			return indexDoc{}, fmt.Errorf("当前会话路由索引读失败，未发送请求")
		}
		return indexDoc{}, fmt.Errorf("路由索引不是有效 JSON，未发送请求")
	}
	doc := indexDoc{routes: map[string]string{}, keys: map[string]bool{}, workdirs: map[string]bool{}}
	if b, ok := d["routes"]; ok {
		if json.Unmarshal(b, &doc.routes) != nil || doc.routes == nil {
			return indexDoc{}, fmt.Errorf("路由表格式错误，未发送请求")
		}
	}
	// keys/workdirs 只用来判归属；格式不认识就当没登记，不影响按路由表选路。
	if b, ok := d["keys"]; ok {
		var keys []string
		if json.Unmarshal(b, &keys) == nil {
			for _, k := range keys {
				doc.keys[k] = true
			}
		}
	}
	if b, ok := d["workdirs"]; ok {
		var w map[string]json.RawMessage
		if json.Unmarshal(b, &w) == nil {
			for k := range w {
				doc.workdirs[k] = true
			}
		}
	}
	return doc, nil
}

func (d indexDoc) owns(sid string) bool {
	return d.keys["claude:"+sid] || d.workdirs["claude:"+sid]
}

func (d indexDoc) selection(p, sid string) (selection, error) {
	mode, found := d.routes["claude:"+sid]
	if !found {
		mode = "default"
	} else if mode != "local" && mode != "cloud" {
		return selection{}, fmt.Errorf("当前会话路由值不认识，未发送请求")
	}
	return selection{mode: mode, sessionID: sid, index: p}, nil
}

func readSelection(p, sid string) (selection, error) {
	doc, err := loadIndex(p)
	if err != nil {
		return selection{}, err
	}
	return doc.selection(p, sid)
}
