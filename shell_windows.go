//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// Explorer right-click integration for PDF files (per user, no admin rights needed).

var (
	advapi32           = syscall.NewLazyDLL("advapi32.dll")
	procRegCreateKeyEx = advapi32.NewProc("RegCreateKeyExW")
	procRegSetValueEx  = advapi32.NewProc("RegSetValueExW")
	procRegDeleteTree  = advapi32.NewProc("RegDeleteTreeW")
	procRegOpenKeyEx   = advapi32.NewProc("RegOpenKeyExW")
	procRegCloseKey    = advapi32.NewProc("RegCloseKey")
)

const (
	hkeyCurrentUser = 0x80000001
	shellBase       = `Software\Classes\SystemFileAssociations\.pdf\shell\`
)

func regSet(path, name, value string) error {
	var h syscall.Handle
	r, _, _ := procRegCreateKeyEx.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(utf16Ptr(path))), 0, 0, 0,
		0x20006 /* KEY_WRITE */, 0, uintptr(unsafe.Pointer(&h)), 0)
	if r != 0 {
		return fmt.Errorf("registry: cannot create %s (error %d)", path, r)
	}
	defer procRegCloseKey.Call(uintptr(h))
	data, _ := syscall.UTF16FromString(value)
	var namePtr uintptr
	if name != "" {
		namePtr = uintptr(unsafe.Pointer(utf16Ptr(name)))
	}
	r, _, _ = procRegSetValueEx.Call(uintptr(h), namePtr, 0, 1 /* REG_SZ */, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	if r != 0 {
		return fmt.Errorf("registry: cannot write %s (error %d)", path, r)
	}
	return nil
}

func setShellIntegration(enable bool) error {
	for _, k := range []string{"LabelPrint.Open", "LabelPrint.Print"} {
		procRegDeleteTree.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(utf16Ptr(shellBase+k))))
	}
	if !enable {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	q := `"` + exe + `"`
	steps := [][3]string{
		{shellBase + "LabelPrint.Open", "", "Open in LabelPrint"},
		{shellBase + "LabelPrint.Open", "Icon", exe + ",0"},
		{shellBase + `LabelPrint.Open\command`, "", q + ` "%1"`},
		{shellBase + "LabelPrint.Print", "", "Print label (LabelPrint)"},
		{shellBase + "LabelPrint.Print", "Icon", exe + ",0"},
		{shellBase + `LabelPrint.Print\command`, "", q + ` --print "%1"`},
	}
	for _, s := range steps {
		if err := regSet(s[0], s[1], s[2]); err != nil {
			return err
		}
	}
	logf("shell integration enabled for %s", exe)
	return nil
}

func shellIntegrationEnabled() bool {
	var h syscall.Handle
	r, _, _ := procRegOpenKeyEx.Call(hkeyCurrentUser, uintptr(unsafe.Pointer(utf16Ptr(shellBase+`LabelPrint.Print\command`))), 0, 0x20019 /* KEY_READ */, uintptr(unsafe.Pointer(&h)))
	if r != 0 {
		return false
	}
	procRegCloseKey.Call(uintptr(h))
	return true
}
