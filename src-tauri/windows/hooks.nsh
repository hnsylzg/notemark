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
  WriteRegStr HKCU "Software\Classes\NoteMark.md\DefaultIcon" "" "$INSTDIR\notemark.exe,1"
  WriteRegStr HKCU "Software\Classes\NoteMark.md\shell\open\command" "" '"$INSTDIR\notemark.exe" "%1"'

  ; 让 NoteMark 出现在资源管理器「打开方式」的程序列表里
  WriteRegStr HKCU "Software\Classes\Applications\notemark.exe" "FriendlyAppName" "NoteMark"
  WriteRegStr HKCU "Software\Classes\Applications\notemark.exe\DefaultIcon" "" "$INSTDIR\notemark.exe,1"
  WriteRegStr HKCU "Software\Classes\Applications\notemark.exe\shell\open\command" "" '"$INSTDIR\notemark.exe" "%1"'

  ; 关联扩展名（写入的是值，不是键）
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "NoteMark.md" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "NoteMark.md" ""

  ; —— 尽力默认：仅当该扩展名从未设置过默认程序时才自动顶上 ——
  ; 判断链：UserChoice(用户显式选择) > HKCU\.md 默认值 > HKLM\.md 默认值
  ; 三者都为空才写 NoteMark.md，绝不抢已有默认（UserChoice 带哈希，系统也不允许覆盖）。
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice" "ProgId"
  StrCmp $0 "" 0 nmk_skip_md_default
  ReadRegStr $0 HKCU "Software\Classes\.md" ""
  StrCmp $0 "" 0 nmk_skip_md_default
  ReadRegStr $0 HKLM "Software\Classes\.md" ""
  StrCmp $0 "" 0 nmk_skip_md_default
  WriteRegStr HKCU "Software\Classes\.md" "" "NoteMark.md"
nmk_skip_md_default:

  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.markdown\UserChoice" "ProgId"
  StrCmp $0 "" 0 nmk_skip_markdown_default
  ReadRegStr $0 HKCU "Software\Classes\.markdown" ""
  StrCmp $0 "" 0 nmk_skip_markdown_default
  ReadRegStr $0 HKLM "Software\Classes\.markdown" ""
  StrCmp $0 "" 0 nmk_skip_markdown_default
  WriteRegStr HKCU "Software\Classes\.markdown" "" "NoteMark.md"
nmk_skip_markdown_default:

  ; 通知资源管理器刷新文件图标（SHCNE_ASSOCCHANGED = 0x08000000）
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 只删除 NoteMark 自己创建的键与值
  DeleteRegKey HKCU "Software\Classes\NoteMark.md"
  DeleteRegKey HKCU "Software\Classes\Applications\notemark.exe"
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "NoteMark.md"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "NoteMark.md"

  ; 默认 ProgId 仍是 NoteMark.md 才删除，避免误删用户后来改的默认
  ReadRegStr $0 HKCU "Software\Classes\.md" ""
  StrCmp $0 "NoteMark.md" 0 nmk_no_del_md
  DeleteRegValue HKCU "Software\Classes\.md" ""
nmk_no_del_md:
  ReadRegStr $0 HKCU "Software\Classes\.markdown" ""
  StrCmp $0 "NoteMark.md" 0 nmk_no_del_markdown
  DeleteRegValue HKCU "Software\Classes\.markdown" ""
nmk_no_del_markdown:

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
