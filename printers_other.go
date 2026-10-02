//go:build !windows

package main

// Non-Windows build: used for development and automated testing only. Printing
// is simulated by writing the job to files in LABELPRINT_OUT (default ./out).

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"time"
)

var jobCounter int64

func platformName() string { return "other" }

func outDir() string {
	d := os.Getenv("LABELPRINT_OUT")
	if d == "" {
		d = "out"
	}
	_ = os.MkdirAll(d, 0o755)
	return d
}

func listPrinters() ([]Printer, error) {
	ps := []Printer{
		{Name: "ZDesigner GK420d", Driver: "ZDesigner GK420d", Port: "USB001", IsDefault: true},
		{Name: "TSC TE200", Driver: "TSC TE200", Port: "USB002"},
		{Name: "DYMO LabelWriter 4XL", Driver: "DYMO LabelWriter 4XL", Port: "USB003"},
	}
	for i := range ps {
		ps[i].Brand, ps[i].Suggested = guessLanguage(ps[i].Name, ps[i].Driver)
	}
	return ps, nil
}

func printRaw(printer, doc string, data []byte) (int, error) {
	n := atomic.AddInt64(&jobCounter, 1)
	p := filepath.Join(outDir(), fmt.Sprintf("job%03d_raw.prn", n))
	return int(n), os.WriteFile(p, data, 0o644)
}

func printDriver(job *DriverJob) error {
	n := atomic.AddInt64(&jobCounter, 1)
	for i, b := range job.pages {
		p := filepath.Join(outDir(), fmt.Sprintf("job%03d_driver_p%d.png", n, i+1))
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func openAppWindow(url string) {
	if err := exec.Command("xdg-open", url).Start(); err != nil {
		fmt.Println("open", url)
	}
	_ = time.Now
}

func openPath(p string) { _ = exec.Command("xdg-open", p).Start() }

func fatalBox(msg string) { fmt.Fprintln(os.Stderr, msg) }

func pickFolder(start string) (string, error) { return start, nil }

var shellOn bool

func setShellIntegration(enable bool) error { shellOn = enable; return nil }

func shellIntegrationEnabled() bool { return shellOn }
