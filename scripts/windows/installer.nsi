; Build: makensis /DBUILD_DIR=<payload output> installer.nsi
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_DIR
  !define BUILD_DIR "..\..\dist-windows"
!endif
!include "${BUILD_DIR}\version.nsh"
!ifndef OUTPUT_FILE
  !define OUTPUT_FILE "${BUILD_DIR}\dsh-tui-setup-win-x64.exe"
!endif
Name "dsh-TUI ${TUI_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\dsh-tui"
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${TUI_VERSION}.0"
VIAddVersionKey "ProductName" "dsh-TUI Windows Installer"
VIAddVersionKey "FileDescription" "Offline per-user dsh-TUI installer"
VIAddVersionKey "FileVersion" "${TUI_VERSION}"
VIAddVersionKey "LegalCopyright" "MIT; dsh-TUI contributors"
!ifdef TEST_ROOT
  !define INSTALLER_MUTEX "Local\dsh-tui-installer-test"
!else
  !define INSTALLER_MUTEX "Local\dsh-tui-installer"
!endif

Var Prefix
Var UserHome
Var EngineArgs
Var Decisions
Var KernelAction
Var KernelInstalled
Var TuiInstalled
Var Running
Var Failure
Var OtherProfiles
Var FullRemoval
Var RemoveRadio
Var Mutex

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchTui
!define MUI_FINISHPAGE_RUN_TEXT "$(LaunchTui)"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
UninstPage custom un.ChooseScope un.ConfirmScope
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!include /CHARSET=UTF8 "installer-strings.nsh"

!macro Bootstrap
  SetShellVarContext current
  StrCpy $Prefix "$APPDATA\npm"
  StrCpy $UserHome "$PROFILE"
  !ifdef TEST_ROOT
    StrCpy $Prefix "${TEST_ROOT}\npm"
    StrCpy $UserHome "${TEST_ROOT}\user"
    StrCpy $INSTDIR "${TEST_ROOT}\metadata"
  !endif
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\engine"
  ; makensis uses the script's directory unless /NOCD was explicitly requested.
  File "install-engine.mjs"
  File "policy.mjs"
  File "transaction.mjs"
  File "windows-system.ps1"
  File /oname=node.exe "${BUILD_DIR}\payload\node\node.exe"
  File /oname=NODE-LICENSE.txt "${BUILD_DIR}\payload\node\LICENSE"
  File /oname=metadata.json "${BUILD_DIR}\metadata.json"
  SetOutPath "$PLUGINSDIR\engine\node_modules\semver"
  File /r "node_modules\semver\*"
  StrCpy $EngineArgs '--metadata "$PLUGINSDIR\engine\metadata.json" --result "$PLUGINSDIR\result.ini" --prefix "$Prefix" --home "$UserHome" --metadata-dir "$INSTDIR"'
  !ifdef TEST_ROOT
    StrCpy $EngineArgs '$EngineArgs --file-only'
  !endif
!macroend

!macro RunEngine Action Extra
  nsExec::ExecToLog /TIMEOUT=600000 '"$PLUGINSDIR\engine\node.exe" "$PLUGINSDIR\engine\install-engine.mjs" ${Action} $EngineArgs ${Extra}'
  Pop $0
!macroend

!macro AcquireMutex
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${INSTALLER_MUTEX}") p.r0 ?e'
  Pop $1
  StrCpy $Mutex $0
  ${If} $1 = 183
    MessageBox MB_ICONSTOP "Another dsh-TUI installer is running." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This installer requires 64-bit Windows." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro AcquireMutex
  !insertmacro Bootstrap
  StrCpy $Decisions ""
  inspect:
  !insertmacro RunEngine "inspect" ""
  ${If} $0 != 0
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    MessageBox MB_ICONSTOP "$(InstallFailed)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadINIStr $Running "$PLUGINSDIR\result.ini" "result" "running"
  ${If} $Running != ""
    IfSilent reject
    MessageBox MB_RETRYCANCEL|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(CloseRunning)" IDRETRY inspect
    Goto reject
  ${EndIf}
  ReadINIStr $KernelAction "$PLUGINSDIR\result.ini" "result" "kernelAction"
  ReadINIStr $KernelInstalled "$PLUGINSDIR\result.ini" "result" "kernelInstalled"
  ${If} $KernelAction == "downgrade"
  ${OrIf} $KernelAction == "incompatible"
    IfSilent reject
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(KernelAhead)" IDYES +2
    Goto reject
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(KernelConfirm)" IDYES +2
    Goto reject
    StrCpy $Decisions "$Decisions --kernel-downgrade"
  ${EndIf}
  ReadINIStr $1 "$PLUGINSDIR\result.ini" "result" "tuiDowngrade"
  ReadINIStr $TuiInstalled "$PLUGINSDIR\result.ini" "result" "tuiInstalled"
  ${If} $1 == "yes"
    IfSilent reject
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(TuiAhead)" IDYES +2
    Goto reject
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(TuiConfirm)" IDYES +2
    Goto reject
    StrCpy $Decisions "$Decisions --tui-downgrade"
  ${EndIf}
  Return
  reject:
    SetErrorLevel 2
    Quit
FunctionEnd

Section "Install"
  ${If} $KernelAction == "keep"
    DetailPrint "$(KeepKernel)"
  ${Else}
    DetailPrint "$(InstallKernel)"
  ${EndIf}
  !insertmacro RunEngine "prepare" ""
  ${If} $0 != 0
    Goto failed
  ${EndIf}
  SetOutPath "$Prefix\_stage_tui"
  ClearErrors
  File "${BUILD_DIR}\payload.tar"
  IfErrors extractFailed
  CreateDirectory "$Prefix\_stage_tui\payload"
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\tar.exe" -xf "$Prefix\_stage_tui\payload.tar" -C "$Prefix\_stage_tui\payload"'
  Pop $0
  ${EnableX64FSRedirection}
  ${If} $0 != 0
    Goto extractFailed
  ${EndIf}
  ; The engine installs the uninstaller in the same transaction as the packages.
  ; Leave the staging directory so Windows permits the engine to clean it up.
  SetOutPath "$PLUGINSDIR"
  ClearErrors
  WriteUninstaller "$PLUGINSDIR\unins000.exe"
  IfErrors extractFailed
  !insertmacro RunEngine "install" '--payload "$Prefix\_stage_tui\payload" --uninstaller "$PLUGINSDIR\unins000.exe" $Decisions'
  ${If} $0 != 0
    Goto failed
  ${EndIf}
  SetOutPath "$INSTDIR"
  !ifndef TEST_ROOT
    SetOutPath "$PROFILE"
    CreateShortCut "$DESKTOP\dsh-TUI.lnk" "$SYSDIR\cmd.exe" '/K "$Prefix\dsh-tui.cmd"'
    CreateDirectory "$SMPROGRAMS\dsh-TUI"
    CreateShortCut "$SMPROGRAMS\dsh-TUI\dsh-TUI.lnk" "$SYSDIR\cmd.exe" '/K "$Prefix\dsh-tui.cmd"'
    CreateShortCut "$SMPROGRAMS\dsh-TUI\Uninstall.lnk" "$INSTDIR\unins000.exe"
  !endif
  Goto done
  extractFailed:
    SetOutPath "$PLUGINSDIR"
    StrCpy $Failure "Unable to extract the offline payload."
    !insertmacro RunEngine "discard" ""
    Goto showFailed
  failed:
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    SetOutPath "$PLUGINSDIR"
    ; Retry rollback and discard a rejected payload. Failed recovery keeps its
    ; journal intact so the next run can recover it instead of deleting backups.
    !insertmacro RunEngine "discard" ""
  showFailed:
    MessageBox MB_ICONSTOP "$(InstallFailed)" /SD IDOK
    SetErrorLevel 1
    Abort
  done:
SectionEnd

Function LaunchTui
  !ifndef TEST_ROOT
    SetOutPath "$PROFILE"
    ReadEnvStr $0 PATH
    System::Call 'kernel32::SetEnvironmentVariableW(w "PATH", w "$Prefix;$0")'
    ExecShell "open" "$SYSDIR\cmd.exe" '/K "$Prefix\dsh-tui.cmd"'
  !endif
FunctionEnd

Function un.onInit
  !insertmacro AcquireMutex
  !insertmacro Bootstrap
  StrCpy $FullRemoval ""
  StrCpy $Decisions ""
FunctionEnd

Function un.ChooseScope
  !insertmacro MUI_HEADER_TEXT "$(RemoveTitle)" "$(RemoveNote)"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateRadioButton} 0 15u 100% 25u "$(RemoveTui)"
  Pop $1
  ${NSD_Check} $1
  ${NSD_CreateRadioButton} 0 50u 100% 25u "$(RemoveBoth)"
  Pop $RemoveRadio
  nsDialogs::Show
FunctionEnd

Function un.ConfirmScope
  ${NSD_GetState} $RemoveRadio $0
  StrCpy $FullRemoval ""
  StrCpy $Decisions ""
  ${If} $0 == ${BST_CHECKED}
    StrCpy $FullRemoval "--full"
  ${EndIf}
  !insertmacro RunEngine "inspect" ""
  ${If} $0 != 0
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    MessageBox MB_ICONSTOP "$Failure"
    Abort
  ${EndIf}
  ReadINIStr $Running "$PLUGINSDIR\result.ini" "result" "running"
  ${If} $Running != ""
    MessageBox MB_ICONEXCLAMATION "$(CloseRunning)"
    Abort
  ${EndIf}
  ReadINIStr $OtherProfiles "$PLUGINSDIR\result.ini" "result" "otherProfiles"
  ${If} $FullRemoval != ""
  ${AndIf} $OtherProfiles != ""
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONEXCLAMATION "$(SharedWarning)" IDYES +2
    Abort
    StrCpy $Decisions "--confirm-shared"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  !insertmacro RunEngine "uninstall" '$FullRemoval $Decisions'
  ${If} $0 != 0
    ReadINIStr $Failure "$PLUGINSDIR\result.ini" "result" "error"
    MessageBox MB_ICONSTOP "$Failure" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  !ifndef TEST_ROOT
    Delete "$DESKTOP\dsh-TUI.lnk"
    Delete "$SMPROGRAMS\dsh-TUI\dsh-TUI.lnk"
    Delete "$SMPROGRAMS\dsh-TUI\Uninstall.lnk"
    RMDir "$SMPROGRAMS\dsh-TUI"
  !endif
  Delete "$INSTDIR\installation.json"
  Delete "$INSTDIR\unins000.exe"
  RMDir "$INSTDIR"
SectionEnd
