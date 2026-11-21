!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!define MUI_CUSTOMFUNCTION_GUIINIT YuntuOpenInstallView

; The generated includes replace only the stock banner and the 7z progress call.
; makensis searches its current directory first. Other includes come from the
; original electron-builder templates, including the separately built uninstaller.
Var yuntuViewProcess
Var yuntuCompleted
Var yuntuTotal
Var yuntuPercent

; Expand the functions after electron-builder has registered its NSIS plug-ins.
!macro customHeader
  !addincludedir "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis"
  !cd "${PROJECT_DIR}\build\setup-view"

Function YuntuOpenInstallView
  IfSilent done
  ; This callback runs before NSIS shows its outer window. Keep its HWND alive
  ; and enabled for installer-owned retry/error prompts, but paint no stock UI.
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i.r0'
  IntOp $0 $0 | 0x000800A0 ; WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT
  IntOp $0 $0 & 0xFFFBFFFF ; remove WS_EX_APPWINDOW
  System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i 0, i 2)'

  InitPluginsDir
  File /oname=$PLUGINSDIR\YuntuSetupView.exe "${PROJECT_DIR}\build\setup-view\YuntuSetupView.exe"
  System::Call 'user32::SetPropW(p $HWNDPARENT, w "Yuntu.Setup.Stage", p 1)'
  StrCpy $0 "install"
  ${If} ${isUpdated}
    StrCpy $0 "update"
  ${EndIf}
  ClearErrors
  Exec '"$PLUGINSDIR\YuntuSetupView.exe" $HWNDPARENT "${VERSION}" $0 "$INSTDIR\."'
  IfErrors failed
  StrCpy $1 0
  waitReady:
    System::Call 'user32::GetPropW(p $HWNDPARENT, w "Yuntu.Setup.Ready") p.r0'
    ${If} $0 != 0
      System::Call 'kernel32::OpenProcess(i 0x00100000, i 0, i r0) p.r2'
      StrCpy $yuntuViewProcess $2
      Goto done
    ${EndIf}
    IntOp $1 $1 + 1
    IntCmp $1 400 failed 0 failed
    Sleep 25
    Goto waitReady
  failed:
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "Yuntu.Setup.Stage", p 5)'
    MessageBox MB_ICONSTOP|MB_OK "无法打开云图安装窗口，请重新运行安装包。"
    SetErrorLevel 1603
    Quit
  done:
FunctionEnd

; The NSIS7z callback pushes completed bytes on top of total bytes.
Function YuntuReportExtraction
  Pop $yuntuCompleted
  Pop $yuntuTotal
  ${If} $yuntuTotal > 0
  ${AndIf} $yuntuCompleted >= 0
  ${AndIf} $yuntuCompleted <= $yuntuTotal
    System::Int64Op $yuntuCompleted * 100
    Pop $yuntuCompleted
    System::Int64Op $yuntuCompleted / $yuntuTotal
    Pop $yuntuCompleted
    IntOp $yuntuCompleted $yuntuCompleted + 1 ; zero means no measurement yet
    ${If} $yuntuPercent != $yuntuCompleted
      StrCpy $yuntuPercent $yuntuCompleted
      System::Call 'user32::SetPropW(p $HWNDPARENT, w "Yuntu.Setup.Percent", p $yuntuPercent)'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  System::Call 'user32::SetPropW(p $HWNDPARENT, w "Yuntu.Setup.Stage", p 5)'
  ${If} $yuntuViewProcess != 0
  ${AndIf} $yuntuViewProcess != ""
    System::Call 'kernel32::WaitForSingleObject(p $yuntuViewProcess, i 2000)'
    System::Call 'kernel32::CloseHandle(p $yuntuViewProcess)'
  ${EndIf}
FunctionEnd
!macroend

!macro YuntuExtract archive
  ${If} ${Silent}
    Nsis7z::Extract "${archive}"
  ${Else}
    StrCpy $yuntuPercent 0
    System::Call 'user32::RemovePropW(p $HWNDPARENT, w "Yuntu.Setup.Percent")'
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "Yuntu.Setup.Stage", p 2)'
    Push $R9
    GetFunctionAddress $R9 YuntuReportExtraction
    Nsis7z::ExtractWithCallback "${archive}" $R9
    Pop $R9
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "Yuntu.Setup.Stage", p 3)'
  ${EndIf}
!macroend

!macro customInstall
  ${IfNot} ${Silent}
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "Yuntu.Setup.Stage", p 4)'
  ${EndIf}
!macroend

!endif
