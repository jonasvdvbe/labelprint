; LabelPrint installer (NSIS 3, Modern UI 2)
; Per-user install: no administrator rights needed.

Target amd64-unicode
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"

!define APPNAME   "LabelPrint"
!define VERSION   "1.1.0"
!define PUBLISHER "LabelPrint"
!define EXE       "LabelPrint.exe"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
!define SHELLKEY  "Software\Classes\SystemFileAssociations\.pdf\shell"
!define PROGID    "LabelPrint.PDF"

Name "${APPNAME} ${VERSION}"
OutFile "..\dist\LabelPrint-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "1.1.0.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "LegalCopyright" "${PUBLISHER}"

!define MUI_ICON   "..\build\app.ico"
!define MUI_UNICON "..\build\app.ico"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_WELCOMEPAGE_TITLE "Welcome to ${APPNAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "LabelPrint prints shipping labels from PDF files straight to your label printer (Zebra, TSC, Dymo, Brother, …), cropped and scaled to the label.$\r$\n$\r$\nNo administrator rights are needed – LabelPrint is installed for your Windows account only.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start LabelPrint now"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------

Function CloseRunningApp
  nsExec::Exec 'taskkill /IM ${EXE} /F'
  Pop $0
  Sleep 400
FunctionEnd

Function un.CloseRunningApp
  nsExec::Exec 'taskkill /IM ${EXE} /F'
  Pop $0
  Sleep 400
FunctionEnd

Section "LabelPrint (required)" SecMain
  SectionIn RO
  Call CloseRunningApp
  SetOutPath "$INSTDIR"
  File "..\dist\${EXE}"
  File /oname=README.md "..\README.md"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  ; Apps & features entry
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr   HKCU "${UNINSTKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr   HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKCU "${UNINSTKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"

  ; Show LabelPrint in "Open with" for PDFs (does not change your default PDF app)
  WriteRegStr HKCU "Software\Classes\${PROGID}" "" "PDF shipping label"
  WriteRegStr HKCU "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "${PROGID}" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}" "FriendlyAppName" "${APPNAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\${EXE}\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
SectionEnd

Section "Windows integration (right-click menu for PDF files)" SecShell
  WriteRegStr HKCU "${SHELLKEY}\LabelPrint.Open" "" "Open in LabelPrint"
  WriteRegStr HKCU "${SHELLKEY}\LabelPrint.Open" "Icon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${SHELLKEY}\LabelPrint.Open\command" "" '"$INSTDIR\${EXE}" "%1"'
  WriteRegStr HKCU "${SHELLKEY}\LabelPrint.Print" "" "Print label (LabelPrint)"
  WriteRegStr HKCU "${SHELLKEY}\LabelPrint.Print" "Icon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${SHELLKEY}\LabelPrint.Print\command" "" '"$INSTDIR\${EXE}" --print "%1"'
SectionEnd

Section "-finish"
  ; remove the right-click menu if the user unticked it (e.g. when upgrading)
  ${IfNot} ${SectionIsSelected} ${SecShell}
    DeleteRegKey HKCU "${SHELLKEY}\LabelPrint.Open"
    DeleteRegKey HKCU "${SHELLKEY}\LabelPrint.Print"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain}    "The LabelPrint program, a Start menu shortcut and an entry in Apps & features. LabelPrint also appears under “Open with” for PDF files."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Put a LabelPrint shortcut on the desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecShell}   "Add “Open in LabelPrint” and “Print label (LabelPrint)” when you right-click a PDF. You can change this later under Settings → Windows."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ---------------------------------------------------------------------------

Section "Uninstall"
  Call un.CloseRunningApp
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"

  DeleteRegKey HKCU "${SHELLKEY}\LabelPrint.Open"
  DeleteRegKey HKCU "${SHELLKEY}\LabelPrint.Print"
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "${PROGID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${EXE}"
  DeleteRegKey HKCU "${UNINSTKEY}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  MessageBox MB_YESNO|MB_ICONQUESTION "Also remove your LabelPrint settings (printers, crop presets)?" /SD IDNO IDNO keep
    RMDir /r "$APPDATA\${APPNAME}"
  keep:
SectionEnd
