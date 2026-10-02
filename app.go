package main

import (
	"embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

// Printer describes an installed (or virtual) printer.
type Printer struct {
	Name      string `json:"name"`
	Driver    string `json:"driver"`
	Port      string `json:"port"`
	IsDefault bool   `json:"isDefault"`
	Suggested string `json:"suggested"` // zpl | epl | tspl | driver
	Brand     string `json:"brand"`
}

// Config is persisted to %APPDATA%\LabelPrint\config.json. The UI owns most of
// it (stored as opaque JSON); the backend only needs the hot-folder fields.
type Config struct {
	HotFolder struct {
		Enabled   bool   `json:"enabled"`
		Path      string `json:"path"`
		Filter    string `json:"filter"`
		AutoPrint bool   `json:"autoPrint"`
	} `json:"hotFolder"`
	UI json.RawMessage `json:"ui,omitempty"`
}

type App struct {
	token string

	mu             sync.Mutex
	cfg            Config
	clients        map[chan string]struct{}
	pending        []pendingFile // files to open once a window connects
	everConnected  bool
	lastClientGone time.Time
}

func newApp(token string) *App {
	a := &App{token: token, clients: map[chan string]struct{}{}}
	a.loadConfig()
	return a
}

// ---------------------------------------------------------------------------
// data dir / logging / config

func dataDir() string {
	base, err := os.UserConfigDir() // %APPDATA% on Windows
	if err != nil || base == "" {
		base = os.TempDir()
	}
	d := filepath.Join(base, appName)
	_ = os.MkdirAll(d, 0o755)
	return d
}

var logger *log.Logger

func logInit() {
	p := filepath.Join(dataDir(), "labelprint.log")
	if st, err := os.Stat(p); err == nil && st.Size() > 2<<20 {
		_ = os.Rename(p, p+".old")
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		logger = log.New(io.Discard, "", 0)
		return
	}
	logger = log.New(f, "", log.LstdFlags)
}

func logf(format string, args ...any) {
	if logger != nil {
		logger.Printf(format, args...)
	}
}

func (a *App) configPath() string { return filepath.Join(dataDir(), "config.json") }

func (a *App) loadConfig() {
	b, err := os.ReadFile(a.configPath())
	if err != nil {
		return
	}
	_ = json.Unmarshal(b, &a.cfg)
}

func (a *App) saveConfig() error {
	a.mu.Lock()
	b, err := json.MarshalIndent(a.cfg, "", "  ")
	a.mu.Unlock()
	if err != nil {
		return err
	}
	tmp := a.configPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, a.configPath())
}

// ---------------------------------------------------------------------------
// events (Server-Sent Events) – used to push "open this file" to the window and
// to know whether a window is still attached.

func (a *App) broadcast(event string, data any) {
	b, _ := json.Marshal(data)
	msg := fmt.Sprintf("event: %s\ndata: %s\n\n", event, b)
	a.mu.Lock()
	defer a.mu.Unlock()
	for c := range a.clients {
		select {
		case c <- msg:
		default:
		}
	}
}

type pendingFile struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Auto   bool   `json:"auto"`
	Source string `json:"source"`
}

func (a *App) queueOpen(path string, auto bool) {
	pf := pendingFile{Path: path, Name: filepath.Base(path), Auto: auto, Source: "open"}
	a.mu.Lock()
	n := len(a.clients)
	if n == 0 {
		a.pending = append(a.pending, pf)
	}
	a.mu.Unlock()
	if n > 0 {
		a.broadcast("file", pf)
	}
}

func (a *App) idleWatchdog(exit func()) {
	start := time.Now()
	for {
		time.Sleep(2 * time.Second)
		a.mu.Lock()
		n, ever, gone := len(a.clients), a.everConnected, a.lastClientGone
		a.mu.Unlock()
		if n > 0 {
			continue
		}
		if !ever && time.Since(start) > 3*time.Minute {
			exit()
		}
		if ever && !gone.IsZero() && time.Since(gone) > 10*time.Second {
			exit()
		}
	}
}

// ---------------------------------------------------------------------------
// hot folder: watch a folder (e.g. Downloads) for new PDFs

func (a *App) hotFolderLoop() {
	seen := map[string]int64{}
	stableSize := map[string]int64{}
	var lastPath string
	for {
		time.Sleep(1500 * time.Millisecond)
		a.mu.Lock()
		hf := a.cfg.HotFolder
		a.mu.Unlock()
		if !hf.Enabled || hf.Path == "" {
			lastPath = ""
			continue
		}
		var re *regexp.Regexp
		if strings.TrimSpace(hf.Filter) != "" {
			re, _ = regexp.Compile("(?i)" + hf.Filter)
		}
		entries, err := os.ReadDir(hf.Path)
		if err != nil {
			continue
		}
		first := lastPath != hf.Path
		if first { // (re)initialise: existing files are ignored
			seen = map[string]int64{}
			stableSize = map[string]int64{}
			lastPath = hf.Path
		}
		for _, e := range entries {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".pdf") {
				continue
			}
			full := filepath.Join(hf.Path, e.Name())
			info, err := e.Info()
			if err != nil {
				continue
			}
			key := full + "|" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
			if first {
				seen[key] = info.Size()
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			// wait until the size is stable (download finished)
			if prev, ok := stableSize[key]; !ok || prev != info.Size() || info.Size() == 0 {
				stableSize[key] = info.Size()
				continue
			}
			seen[key] = info.Size()
			delete(stableSize, key)
			if re != nil && !re.MatchString(e.Name()) {
				continue
			}
			logf("hot folder: new file %s", full)
			a.broadcast("file", pendingFile{Path: full, Name: e.Name(), Auto: hf.AutoPrint, Source: "watch"})
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".mjs") {
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		}
		if strings.HasSuffix(r.URL.Path, ".wasm") {
			w.Header().Set("Content-Type", "application/wasm")
		}
		w.Header().Set("Cache-Control", "no-cache")
		if strings.HasPrefix(r.URL.Path, "/vendor/") {
			serveVendor(w, r)
			return
		}
		static.ServeHTTP(w, r)
	}))

	api := func(path string, h func(w http.ResponseWriter, r *http.Request) (any, error)) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			if !a.authorized(r) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			res, err := h(w, r)
			if err != nil {
				logf("%s error: %v", path, err)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			if res == nil {
				return // handler wrote its own response
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(res)
		})
	}

	api("/api/ping", func(w http.ResponseWriter, r *http.Request) (any, error) {
		a.mu.Lock()
		n := len(a.clients)
		a.mu.Unlock()
		return map[string]any{"ok": true, "clients": n, "version": appVersion}, nil
	})

	api("/api/state", func(w http.ResponseWriter, r *http.Request) (any, error) {
		printers, err := listPrinters()
		if err != nil {
			logf("listPrinters: %v", err)
		}
		a.mu.Lock()
		cfg := a.cfg
		a.mu.Unlock()
		home, _ := os.UserHomeDir()
		return map[string]any{
			"version":   appVersion,
			"printers":  printers,
			"config":    cfg,
			"platform":  platformName(),
			"downloads": filepath.Join(home, "Downloads"),
			"dataDir":   dataDir(),
		}, nil
	})

	api("/api/config", func(w http.ResponseWriter, r *http.Request) (any, error) {
		if r.Method != http.MethodPost {
			return nil, fmt.Errorf("POST required")
		}
		var c Config
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&c); err != nil {
			return nil, err
		}
		a.mu.Lock()
		a.cfg = c
		a.mu.Unlock()
		return map[string]bool{"ok": true}, a.saveConfig()
	})

	api("/api/events", func(w http.ResponseWriter, r *http.Request) (any, error) {
		fl, ok := w.(http.Flusher)
		if !ok {
			return nil, fmt.Errorf("streaming unsupported")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		ch := make(chan string, 16)
		a.mu.Lock()
		a.clients[ch] = struct{}{}
		a.everConnected = true
		pend := a.pending
		a.pending = nil
		a.mu.Unlock()
		defer func() {
			a.mu.Lock()
			delete(a.clients, ch)
			if len(a.clients) == 0 {
				a.lastClientGone = time.Now()
			}
			a.mu.Unlock()
		}()
		fmt.Fprintf(w, "event: hello\ndata: {}\n\n")
		for _, p := range pend {
			b, _ := json.Marshal(p)
			fmt.Fprintf(w, "event: file\ndata: %s\n\n", b)
		}
		fl.Flush()
		tick := time.NewTicker(15 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-r.Context().Done():
				return nil, nil
			case m := <-ch:
				_, _ = io.WriteString(w, m)
				fl.Flush()
			case <-tick.C:
				_, _ = io.WriteString(w, ": keepalive\n\n")
				fl.Flush()
			}
		}
	})

	api("/api/open", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var req struct {
			Paths []string `json:"paths"`
			Auto  bool     `json:"auto"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			return nil, err
		}
		for _, p := range req.Paths {
			a.queueOpen(p, req.Auto)
		}
		return map[string]bool{"ok": true}, nil
	})

	api("/api/file", func(w http.ResponseWriter, r *http.Request) (any, error) {
		p := r.URL.Query().Get("path")
		if !strings.EqualFold(filepath.Ext(p), ".pdf") {
			return nil, fmt.Errorf("only PDF files can be opened")
		}
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/pdf")
		_, err = io.Copy(w, f)
		return nil, err
	})

	// RAW print (ZPL / EPL / TSPL bytes) to an installed Windows printer
	api("/api/print/raw", func(w http.ResponseWriter, r *http.Request) (any, error) {
		printer := r.URL.Query().Get("printer")
		doc := r.URL.Query().Get("doc")
		if doc == "" {
			doc = appName + " label"
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 256<<20))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			return nil, fmt.Errorf("nothing to print")
		}
		job, err := printRaw(printer, doc, data)
		if err != nil {
			return nil, err
		}
		logf("raw print %d bytes to %q (job %d)", len(data), printer, job)
		return map[string]any{"ok": true, "job": job, "bytes": len(data)}, nil
	})

	// RAW print over TCP (port 9100) to a network printer
	api("/api/print/tcp", func(w http.ResponseWriter, r *http.Request) (any, error) {
		host := strings.TrimSpace(r.URL.Query().Get("host"))
		if host == "" {
			return nil, fmt.Errorf("no printer address set")
		}
		if _, _, err := net.SplitHostPort(host); err != nil {
			host = net.JoinHostPort(host, "9100")
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 256<<20))
		if err != nil {
			return nil, err
		}
		conn, err := net.DialTimeout("tcp", host, 5*time.Second)
		if err != nil {
			return nil, fmt.Errorf("cannot reach %s: %w", host, err)
		}
		defer conn.Close()
		_ = conn.SetWriteDeadline(time.Now().Add(60 * time.Second))
		if _, err := conn.Write(data); err != nil {
			return nil, err
		}
		logf("tcp print %d bytes to %s", len(data), host)
		return map[string]any{"ok": true, "bytes": len(data)}, nil
	})

	// Print bitmaps through the Windows printer driver (any brand: Dymo, Brother, …)
	api("/api/print/driver", func(w http.ResponseWriter, r *http.Request) (any, error) {
		var req DriverJob
		if err := json.NewDecoder(io.LimitReader(r.Body, 512<<20)).Decode(&req); err != nil {
			return nil, err
		}
		for i, p := range req.PagesB64 {
			if i := strings.Index(p, ","); i >= 0 && strings.HasPrefix(p, "data:") {
				p = p[i+1:]
			}
			b, err := base64.StdEncoding.DecodeString(p)
			if err != nil {
				return nil, fmt.Errorf("page %d: %w", i+1, err)
			}
			req.pages = append(req.pages, b)
		}
		if len(req.pages) == 0 {
			return nil, fmt.Errorf("nothing to print")
		}
		if req.Copies < 1 {
			req.Copies = 1
		}
		if err := printDriver(&req); err != nil {
			return nil, err
		}
		logf("driver print %d page(s) x%d to %q", len(req.pages), req.Copies, req.Printer)
		return map[string]any{"ok": true}, nil
	})

	api("/api/browse-folder", func(w http.ResponseWriter, r *http.Request) (any, error) {
		p, err := pickFolder(r.URL.Query().Get("start"))
		if err != nil {
			return nil, err
		}
		return map[string]string{"path": p}, nil
	})

	api("/api/shell", func(w http.ResponseWriter, r *http.Request) (any, error) {
		if r.Method == http.MethodPost {
			var req struct {
				Enable bool `json:"enable"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				return nil, err
			}
			if err := setShellIntegration(req.Enable); err != nil {
				return nil, err
			}
		}
		return map[string]bool{"enabled": shellIntegrationEnabled()}, nil
	})

	api("/api/open-datadir", func(w http.ResponseWriter, r *http.Request) (any, error) {
		openPath(dataDir())
		return map[string]bool{"ok": true}, nil
	})

	return mux
}

func (a *App) authorized(r *http.Request) bool {
	t := r.Header.Get("X-Token")
	if t == "" {
		t = r.URL.Query().Get("t")
	}
	return t == a.token
}

// DriverJob is a list of PNG bitmaps printed through the Windows driver.
type DriverJob struct {
	Printer  string   `json:"printer"`
	DocName  string   `json:"docName"`
	PagesB64 []string `json:"pages"`
	Copies   int      `json:"copies"`
	WidthMM  float64  `json:"widthMM"`
	HeightMM float64  `json:"heightMM"`
	Scale    string   `json:"scale"` // "fit" (scale to printable area) | "actual"
	pages    [][]byte
}
