// LabelPrint – print shipping labels from (large) PDFs directly to thermal label printers.
//
// Architecture: a single self-contained executable. The Go side owns everything
// that touches the operating system (printer enumeration, RAW spooling, GDI
// printing, network printing, config, hot folder). The user interface is an
// embedded HTML/JS app (pdf.js for rendering) served on 127.0.0.1 and shown in
// a chromeless Edge/Chrome "app" window, so the result looks like a desktop app
// without needing any runtime to be installed.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const appName = "LabelPrint"
const appVersion = "1.1.0"

// fixed preferred port so a second launch (e.g. "Open with…") can find the running instance
const preferredPort = 47821

type instanceInfo struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

func main() {
	noBrowser := flag.Bool("no-browser", false, "do not open a window (server only, for testing)")
	port := flag.Int("port", 0, "port to listen on (default: 47821 or random)")
	noIdleExit := flag.Bool("stay", false, "keep running when the window is closed")
	autoPrint := flag.Bool("print", false, "print the given PDF(s) immediately with the last used settings")
	flag.Parse()
	files := absPDFs(flag.Args())

	logInit()
	logf("%s %s starting, args=%v", appName, appVersion, os.Args[1:])

	// --- single instance hand-off -------------------------------------------------
	if inst, ok := runningInstance(); ok {
		handoff(inst, files, *autoPrint, *noBrowser)
		return
	}

	// --- start a new instance ---------------------------------------------------
	var ln net.Listener
	var err error
	if *port != 0 {
		ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	} else if ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferredPort)); err != nil {
		// Another copy may be starting right now (e.g. several PDFs opened at once
		// from Explorer). Give it a moment and hand our files over to it.
		for i := 0; i < 20; i++ {
			time.Sleep(200 * time.Millisecond)
			if inst, ok := runningInstance(); ok {
				handoff(inst, files, *autoPrint, *noBrowser)
				return
			}
		}
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		fatalBox("Could not start: " + err.Error())
		return
	}
	actualPort := ln.Addr().(*net.TCPAddr).Port
	token := randomToken()

	app := newApp(token)
	for _, f := range files {
		app.queueOpen(f, *autoPrint)
	}
	writeInstance(instanceInfo{Port: actualPort, Token: token, PID: os.Getpid()})
	defer removeInstance(token)

	srv := &http.Server{Handler: app.routes(), ReadHeaderTimeout: 10 * time.Second}
	go app.hotFolderLoop()
	if !*noIdleExit && !*noBrowser {
		go app.idleWatchdog(func() {
			logf("no window connected – exiting")
			removeInstance(token)
			os.Exit(0)
		})
	}

	url := fmt.Sprintf("http://127.0.0.1:%d/?t=%s", actualPort, token)
	logf("listening on %s", url)
	if *noBrowser {
		fmt.Println(url)
	} else {
		go func() {
			time.Sleep(150 * time.Millisecond)
			openAppWindow(url)
		}()
	}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		fatalBox("Server error: " + err.Error())
	}
}

// handoff passes files to an already running instance (and opens a window for it if needed).
func handoff(inst instanceInfo, files []string, auto, noBrowser bool) {
	base := fmt.Sprintf("http://127.0.0.1:%d", inst.Port)
	if len(files) > 0 {
		body, _ := json.Marshal(map[string]any{"paths": files, "auto": auto})
		req, _ := http.NewRequest("POST", base+"/api/open", bytes.NewReader(body))
		req.Header.Set("X-Token", inst.Token)
		req.Header.Set("Content-Type", "application/json")
		c := &http.Client{Timeout: 3 * time.Second}
		resp, err := c.Do(req)
		if err != nil {
			fatalBox("Could not pass the file to the running LabelPrint: " + err.Error())
			return
		}
		resp.Body.Close()
		if instanceHasClients(inst) || noBrowser {
			return
		}
	}
	if !noBrowser {
		openAppWindow(fmt.Sprintf("%s/?t=%s", base, inst.Token))
	}
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func absPDFs(args []string) []string {
	var out []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			continue
		}
		if p, err := filepath.Abs(a); err == nil {
			out = append(out, p)
		}
	}
	return out
}

// ---- instance file ------------------------------------------------------------

func instancePath() string { return filepath.Join(dataDir(), "instance.json") }

func writeInstance(i instanceInfo) {
	b, _ := json.Marshal(i)
	_ = os.WriteFile(instancePath(), b, 0o600)
}

func removeInstance(token string) {
	b, err := os.ReadFile(instancePath())
	if err != nil {
		return
	}
	var i instanceInfo
	if json.Unmarshal(b, &i) == nil && i.Token == token {
		_ = os.Remove(instancePath())
	}
}

func runningInstance() (instanceInfo, bool) {
	var i instanceInfo
	b, err := os.ReadFile(instancePath())
	if err != nil || json.Unmarshal(b, &i) != nil || i.Port == 0 {
		return i, false
	}
	c := &http.Client{Timeout: 800 * time.Millisecond}
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/ping", i.Port), nil)
	req.Header.Set("X-Token", i.Token)
	resp, err := c.Do(req)
	if err != nil {
		return i, false
	}
	defer resp.Body.Close()
	return i, resp.StatusCode == 200
}

func instanceHasClients(i instanceInfo) bool {
	c := &http.Client{Timeout: 800 * time.Millisecond}
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/ping", i.Port), nil)
	req.Header.Set("X-Token", i.Token)
	resp, err := c.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var r struct {
		Clients int `json:"clients"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&r)
	return r.Clients > 0
}
