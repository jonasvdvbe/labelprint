package main

// The third-party pdf.js files (library, worker, fonts, cmaps, wasm) are shipped
// as a single web/vendor.zip to keep the repository small and easy to upload.
// They are served from that zip under /vendor/.

import (
	"archive/zip"
	"bytes"
	"io"
	"mime"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"
)

var (
	vendorOnce  sync.Once
	vendorFiles map[string][]byte
)

func loadVendor() {
	vendorFiles = map[string][]byte{}
	data, err := webFS.ReadFile("web/vendor.zip")
	if err != nil {
		logf("vendor.zip missing: %v", err)
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		logf("vendor.zip invalid: %v", err)
		return
	}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err == nil {
			vendorFiles[strings.TrimPrefix(path.Clean("/"+f.Name), "/")] = b
		}
	}
}

func serveVendor(w http.ResponseWriter, r *http.Request) {
	vendorOnce.Do(loadVendor)
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/vendor/")
	b, ok := vendorFiles[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	ct := ""
	switch path.Ext(name) {
	case ".mjs", ".js":
		ct = "text/javascript; charset=utf-8"
	case ".wasm":
		ct = "application/wasm"
	default:
		ct = mime.TypeByExtension(path.Ext(name))
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(b))
}
