; ============================================================
; 文件关联：安装后让 .md / .markdown 可以用 NoteMark 打开
;
; 全部写在 HKCU，因此安装程序不需要管理员权限
; （与 Tauri 默认的 currentUser 安装模式一致）。
;
; 注意：卸载时只删 OpenWithProgids 里的「值」，绝不能删整个 .md 键，
; 否则会连带清掉其他程序对 .md 的关联，导致它们的关联一起失效。
; ============================================================

!macro NSIS_HOOK_POSTINSTALL
  ; ProgID：两个扩展名共用一份定义，避免重复
  WriteRegStr HKCU "Software\Classes\NoteMark.md" "" "Markdown Document"
  WriteRegStr HKCU "Software\Classes\NoteMark.md\DefaultIcon" "" "$INSTDIR\notemark.exe,0"
  WriteRegStr HKCU "Software\Classes\NoteMark.md\shell\open\command" "" '"$INSTDIR\notemark.exe" "%1"'

  ; 让 NoteMark 出现在资源管理器「打开方式」的程序列表里
  WriteRegStr HKCU "Software\Classes\Applications\notemark.exe" "FriendlyAppName" "NoteMark"
  WriteRegStr HKCU "Software\Classes\Applications\notemark.exe\DefaultIcon" "" "$INSTDIR\notemark.exe,0"
  WriteRegStr HKCU "Software\Classes\Applications\notemark.exe\shell\open\command" "" '"$INSTDIR\notemark.exe" "%1"'

  ; 关联扩展名（写入的是值，不是键）
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "NoteMark.md" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "NoteMark.md" ""

  ; 通知资源管理器刷新文件图标（SHCNE_ASSOCCHANGED = 0x08000000）
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 只删除 NoteMark 自己创建的键与值
  DeleteRegKey HKCU "Software\Classes\NoteMark.md"
  DeleteRegKey HKCU "Software\Classes\Applications\notemark.exe"
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "NoteMark.md"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "NoteMark.md"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
