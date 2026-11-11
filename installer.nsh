; ==================================================================
; WSZH-ShortageStore NSIS 自定义安装脚本
; 解决问题：覆盖升级时旧客户端进程未退出导致文件被锁定/跳过
; 钩子使用 !macro（不是 Function），electron-builder 在编译时展开
; 内置 uninstallOldVersion / CHECK_APP_RUNNING 仍保留，这里只是前置双保险
; ==================================================================

; ---------- customInit: 安装开始前 ----------
; installer.nsi .onInit() 里 initMultiUser 之后调用
; 此时 $INSTDIR、${APP_EXECUTABLE_FILENAME}、${PRODUCT_FILENAME} 等已就绪
!macro customInit
  ; ---- 1. 强制结束所有同名进程（双保险，防卸载器被锁） ----
  ; taskkill /F 强制结束 /IM 按映像名 /T 结束进程树
  ; 用 ExecWait 同步等退出，确保后续 RMDir / 卸载器不会因文件被锁而失败
  DetailPrint "正在结束旧版进程..."
  ExecWait 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T 2>NUL'
  Sleep 1500
  ; 再杀一次保险（有些 electron 子进程需要两次才彻底清干净）
  ExecWait 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T 2>NUL'
  Sleep 1500

  ; ---- 2. 清理残留只读/隐藏属性 + 强制清空旧安装目录 ----
  ; electron-builder 内置的 uninstallOldVersion 会调旧版卸载器，
  ; 但如果卸载器本身因进程被锁而失败，我们手动兜底清理
  ${If} ${FileExists} "$INSTDIR"
    ExecWait 'attrib -R -S -H "$INSTDIR\*.*" /S /D 2>NUL'
    ; 静默卸载器失败时 electron-builder 会 Abort，这里先尝试自己清目录
    RMDir /r "$INSTDIR"
    Sleep 500
  ${EndIf}
!macroend

; ---------- customInstall: 文件复制完成后 ----------
; installSection.nsh 末尾，在 installApplicationFiles + registryAddInstallInfo 之后调用
!macro customInstall
  ; 确保 userData 目录存在（首次启动不会报路径错）
  CreateDirectory "$APPDATA\wszh-shortage-store"
!macroend

; ---------- customUnInit: 卸载开始前 ----------
; uninstaller.nsh un.onInit() 里调用
!macro customUnInit
  ; 卸载前同样先杀进程，防止文件被锁
  ExecWait 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /T 2>NUL'
  Sleep 1000
!macroend

; ---------- customUnInstall: 卸载完成后 ----------
; uninstaller.nsh Section 末尾调用
; 这里什么都不用做——electron-builder 默认就不删 userData（$APPDATA\wszh-shortage-store）
; 只有用户手动指定 --delete-app-data 才会删，正常升级/重装卸都保留
!macro customUnInstall
!macroend
