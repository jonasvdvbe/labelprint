//go:build windows

package main

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	_ "image/png"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	winspool = syscall.NewLazyDLL("winspool.drv")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")

	procEnumPrinters      = winspool.NewProc("EnumPrintersW")
	procGetDefaultPrinter = winspool.NewProc("GetDefaultPrinterW")
	procOpenPrinter       = winspool.NewProc("OpenPrinterW")
	procClosePrinter      = winspool.NewProc("ClosePrinter")
	procStartDocPrinter   = winspool.NewProc("StartDocPrinterW")
	procEndDocPrinter     = winspool.NewProc("EndDocPrinter")
	procStartPagePrinter  = winspool.NewProc("StartPagePrinter")
	procEndPagePrinter    = winspool.NewProc("EndPagePrinter")
	procWritePrinter      = winspool.NewProc("WritePrinter")

	procCreateDC          = gdi32.NewProc("CreateDCW")
	procDeleteDC          = gdi32.NewProc("DeleteDC")
	procGetDeviceCaps     = gdi32.NewProc("GetDeviceCaps")
	procStartDoc          = gdi32.NewProc("StartDocW")
	procEndDoc            = gdi32.NewProc("EndDoc")
	procAbortDoc          = gdi32.NewProc("AbortDoc")
	procStartPage         = gdi32.NewProc("StartPage")
	procEndPage           = gdi32.NewProc("EndPage")
	procStretchDIBits     = gdi32.NewProc("StretchDIBits")
	procSetStretchBltMode = gdi32.NewProc("SetStretchBltMode")

	procMessageBox          = user32.NewProc("MessageBoxW")
	procGetForegroundWindow = user32.NewProc("GetForegroundWindow")

	procSHBrowseForFolder   = shell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromIDList = shell32.NewProc("SHGetPathFromIDListW")
	procCoInitializeEx      = ole32.NewProc("CoInitializeEx")
	procCoUninitialize      = ole32.NewProc("CoUninitialize")
	procCoTaskMemFree       = ole32.NewProc("CoTaskMemFree")
)

func platformName() string { return "windows" }

func utf16Ptr(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

func ptrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	n := 0
	for ptr := unsafe.Pointer(p); *(*uint16)(ptr) != 0; n++ {
		ptr = unsafe.Pointer(uintptr(ptr) + 2)
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

// ---------------------------------------------------------------------------
// printer enumeration

type printerInfo2 struct {
	pServerName         *uint16
	pPrinterName        *uint16
	pShareName          *uint16
	pPortName           *uint16
	pDriverName         *uint16
	pComment            *uint16
	pLocation           *uint16
	pDevMode            uintptr
	pSepFile            *uint16
	pPrintProcessor     *uint16
	pDatatype           *uint16
	pParameters         *uint16
	pSecurityDescriptor uintptr
	Attributes          uint32
	Priority            uint32
	DefaultPriority     uint32
	StartTime           uint32
	UntilTime           uint32
	Status              uint32
	cJobs               uint32
	AveragePPM          uint32
}

func defaultPrinter() string {
	var n uint32 = 0
	procGetDefaultPrinter.Call(0, uintptr(unsafe.Pointer(&n)))
	if n == 0 {
		return ""
	}
	buf := make([]uint16, n)
	r, _, _ := procGetDefaultPrinter.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf)
}

func listPrinters() ([]Printer, error) {
	const flags = 0x2 | 0x4 // PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS
	var needed, returned uint32
	procEnumPrinters.Call(flags, 0, 2, 0, 0, uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if needed == 0 {
		return []Printer{}, nil
	}
	buf := make([]byte, needed)
	r, _, err := procEnumPrinters.Call(flags, 0, 2, uintptr(unsafe.Pointer(&buf[0])), uintptr(needed),
		uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if r == 0 {
		return nil, fmt.Errorf("EnumPrinters: %v", err)
	}
	def := defaultPrinter()
	infos := unsafe.Slice((*printerInfo2)(unsafe.Pointer(&buf[0])), returned)
	out := make([]Printer, 0, returned)
	for _, pi := range infos {
		p := Printer{
			Name:   ptrToString(pi.pPrinterName),
			Driver: ptrToString(pi.pDriverName),
			Port:   ptrToString(pi.pPortName),
		}
		p.IsDefault = p.Name == def
		p.Brand, p.Suggested = guessLanguage(p.Name, p.Driver)
		out = append(out, p)
	}
	runtime.KeepAlive(buf)
	return out, nil
}

// ---------------------------------------------------------------------------
// RAW printing through the spooler (ZPL / EPL / TSPL)

type docInfo1 struct {
	pDocName    *uint16
	pOutputFile *uint16
	pDatatype   *uint16
}

func printRaw(printer, doc string, data []byte) (int, error) {
	if printer == "" {
		return 0, fmt.Errorf("no printer selected")
	}
	var h syscall.Handle
	r, _, err := procOpenPrinter.Call(uintptr(unsafe.Pointer(utf16Ptr(printer))), uintptr(unsafe.Pointer(&h)), 0)
	if r == 0 {
		return 0, fmt.Errorf("cannot open printer %q: %v", printer, err)
	}
	defer procClosePrinter.Call(uintptr(h))

	var job uintptr
	for _, dt := range []string{"RAW", "XPS_PASS"} { // XPS_PASS for v4 drivers
		di := docInfo1{pDocName: utf16Ptr(doc), pDatatype: utf16Ptr(dt)}
		job, _, err = procStartDocPrinter.Call(uintptr(h), 1, uintptr(unsafe.Pointer(&di)))
		if job != 0 {
			break
		}
	}
	if job == 0 {
		return 0, fmt.Errorf("StartDocPrinter failed: %v (does the driver accept RAW data?)", err)
	}
	defer procEndDocPrinter.Call(uintptr(h))
	if r, _, err := procStartPagePrinter.Call(uintptr(h)); r == 0 {
		return 0, fmt.Errorf("StartPagePrinter failed: %v", err)
	}
	off := 0
	for off < len(data) {
		chunk := data[off:]
		if len(chunk) > 1<<20 {
			chunk = chunk[:1<<20]
		}
		var written uint32
		r, _, err := procWritePrinter.Call(uintptr(h), uintptr(unsafe.Pointer(&chunk[0])), uintptr(len(chunk)), uintptr(unsafe.Pointer(&written)))
		if r == 0 || written == 0 {
			return 0, fmt.Errorf("WritePrinter failed after %d bytes: %v", off, err)
		}
		off += int(written)
	}
	procEndPagePrinter.Call(uintptr(h))
	return int(job), nil
}

// ---------------------------------------------------------------------------
// GDI printing through the printer driver (works for every brand)

type docInfoW struct {
	cbSize       int32
	lpszDocName  *uint16
	lpszOutput   *uint16
	lpszDatatype *uint16
	fwType       uint32
}

type bitmapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}

const (
	capHORZRES    = 8
	capVERTRES    = 10
	capLOGPIXELSX = 88
	capLOGPIXELSY = 90
)

func printDriver(job *DriverJob) error {
	if job.Printer == "" {
		return fmt.Errorf("no printer selected")
	}
	hdc, _, err := procCreateDC.Call(uintptr(unsafe.Pointer(utf16Ptr("WINSPOOL"))), uintptr(unsafe.Pointer(utf16Ptr(job.Printer))), 0, 0)
	if hdc == 0 {
		return fmt.Errorf("cannot open printer %q: %v", job.Printer, err)
	}
	defer procDeleteDC.Call(hdc)

	cap := func(i int) int { r, _, _ := procGetDeviceCaps.Call(hdc, uintptr(i)); return int(int32(r)) }
	horz, vert := cap(capHORZRES), cap(capVERTRES)
	dpiX, dpiY := cap(capLOGPIXELSX), cap(capLOGPIXELSY)
	if horz <= 0 || vert <= 0 || dpiX <= 0 || dpiY <= 0 {
		return fmt.Errorf("printer reported an invalid page size")
	}
	logf("driver page: %dx%d px @ %dx%d dpi", horz, vert, dpiX, dpiY)

	name := job.DocName
	if name == "" {
		name = appName + " label"
	}
	di := docInfoW{lpszDocName: utf16Ptr(name)}
	di.cbSize = int32(unsafe.Sizeof(di))
	if r, _, err := procStartDoc.Call(hdc, uintptr(unsafe.Pointer(&di))); int32(r) <= 0 {
		return fmt.Errorf("StartDoc failed: %v", err)
	}
	ok := false
	defer func() {
		if ok {
			procEndDoc.Call(hdc)
		} else {
			procAbortDoc.Call(hdc)
		}
	}()

	for c := 0; c < job.Copies; c++ {
		for i, png := range job.pages {
			img, _, err := image.Decode(bytes.NewReader(png))
			if err != nil {
				return fmt.Errorf("page %d: %w", i+1, err)
			}
			rgba := toBGRA(img)
			w, h := rgba.Rect.Dx(), rgba.Rect.Dy()
			// rotate if the driver page orientation does not match the label
			if (w > h) != (horz > vert) && w != h {
				rgba = rotate90(rgba)
				w, h = h, w
			}
			// physical size of the label in device pixels
			tw, th := float64(horz), float64(vert)
			if job.WidthMM > 0 && job.HeightMM > 0 && job.Scale == "actual" {
				lw, lh := job.WidthMM, job.HeightMM
				if (lw > lh) != (w > h) {
					lw, lh = lh, lw
				}
				tw, th = lw/25.4*float64(dpiX), lh/25.4*float64(dpiY)
			}
			s := math.Min(tw/float64(w), th/float64(h))
			if s*float64(w) > float64(horz) || s*float64(h) > float64(vert) {
				s = math.Min(float64(horz)/float64(w), float64(vert)/float64(h))
			}
			dw, dh := int(float64(w)*s), int(float64(h)*s)
			dx, dy := (horz-dw)/2, (vert-dh)/2

			if r, _, err := procStartPage.Call(hdc); int32(r) <= 0 {
				return fmt.Errorf("StartPage failed: %v", err)
			}
			procSetStretchBltMode.Call(hdc, 3) // COLORONCOLOR – keeps barcodes crisp
			bih := bitmapInfoHeader{biWidth: int32(w), biHeight: -int32(h), biPlanes: 1, biBitCount: 32}
			bih.biSize = uint32(unsafe.Sizeof(bih))
			r, _, err := procStretchDIBits.Call(hdc,
				uintptr(dx), uintptr(dy), uintptr(dw), uintptr(dh),
				0, 0, uintptr(w), uintptr(h),
				uintptr(unsafe.Pointer(&rgba.Pix[0])), uintptr(unsafe.Pointer(&bih)),
				0, 0x00CC0020)
			if int32(r) == 0 || int32(r) == -1 {
				procEndPage.Call(hdc)
				return fmt.Errorf("StretchDIBits failed: %v", err)
			}
			if r, _, err := procEndPage.Call(hdc); int32(r) <= 0 {
				return fmt.Errorf("EndPage failed: %v", err)
			}
		}
	}
	ok = true
	return nil
}

// toBGRA converts an image into a tightly packed top-down BGRA buffer (what GDI expects).
func toBGRA(img image.Image) *image.RGBA {
	b := img.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Rect, image.White, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Rect, img, b.Min, draw.Over)
	p := dst.Pix
	for i := 0; i+3 < len(p); i += 4 {
		p[i], p[i+2] = p[i+2], p[i]
	}
	return dst
}

func rotate90(src *image.RGBA) *image.RGBA {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, h, w))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			si := y*src.Stride + x*4
			// clockwise: (x,y) -> (h-1-y, x)
			di := x*dst.Stride + (h-1-y)*4
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

// ---------------------------------------------------------------------------
// UI helpers

func openAppWindow(url string) {
	local := os.Getenv("LOCALAPPDATA")
	candidates := []string{
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(local, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), `Google\Chrome\Application\chrome.exe`),
		filepath.Join(local, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(os.Getenv("ProgramFiles"), `BraveSoftware\Brave-Browser\Application\brave.exe`),
	}
	profile := filepath.Join(dataDir(), "window")
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			cmd := exec.Command(c, "--app="+url, "--user-data-dir="+profile, "--window-size=1340,880",
				"--no-first-run", "--no-default-browser-check", "--disable-features=Translate,msEdgeSidebarV2")
			if err := cmd.Start(); err == nil {
				logf("window opened with %s", c)
				go cmd.Wait()
				return
			}
		}
	}
	logf("no Chromium browser found, using default browser")
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func openPath(p string) { _ = exec.Command("explorer", p).Start() }

func fatalBox(msg string) {
	logf("fatal: %s", msg)
	procMessageBox.Call(0, uintptr(unsafe.Pointer(utf16Ptr(msg))), uintptr(unsafe.Pointer(utf16Ptr(appName))), 0x10)
}

type browseInfo struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName *uint16
	lpszTitle      *uint16
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

func pickFolder(start string) (string, error) {
	type res struct {
		p   string
		err error
	}
	ch := make(chan res, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		procCoInitializeEx.Call(0, 0x2) // COINIT_APARTMENTTHREADED
		defer procCoUninitialize.Call()
		owner, _, _ := procGetForegroundWindow.Call()
		disp := make([]uint16, 260)
		bi := browseInfo{
			hwndOwner:      owner,
			pszDisplayName: &disp[0],
			lpszTitle:      utf16Ptr("Choose the folder to watch for new label PDFs"),
			ulFlags:        0x1 | 0x40, // BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
		}
		pidl, _, _ := procSHBrowseForFolder.Call(uintptr(unsafe.Pointer(&bi)))
		if pidl == 0 {
			ch <- res{"", nil}
			return
		}
		defer procCoTaskMemFree.Call(pidl)
		buf := make([]uint16, 1024)
		procSHGetPathFromIDList.Call(pidl, uintptr(unsafe.Pointer(&buf[0])))
		ch <- res{syscall.UTF16ToString(buf), nil}
	}()
	r := <-ch
	return r.p, r.err
}
