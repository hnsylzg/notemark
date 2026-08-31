# 文件关联（.md / .markdown）方案设计存档

本文件存档于 `backup/pre-file-assoc` 分支，记录实现文件关联前的完整方案对比与决策依据。
**当前已按方案 A 实现**。若日后想改用方案 B 或 C，从本分支重新开始即可。

## 一、已确定的决策

| 项目 | 决策 |
| --- | --- |
| 关联扩展名 | `.md` + `.markdown` |
| 双击已有实例时的行为 | **新开一个窗口**（不替换当前文档） |
| 安装包形态 | 同时保留 MSI + NSIS |
| 注册方案 | **方案 A（安装包注册）** |

## 二、方案的三个层次

实现文件关联需要 4 个环节，其中**前 3 个是 A/B/C 共有的必做项**，只有"注册表由谁写"是变量。

| 环节 | 内容 | A | B | C |
| --- | --- | --- | --- | --- |
| 1. 接命令行参数 | `std::env::args()` 取路径、过滤、存进 State | 必做 | 必做 | 必做 |
| 2. 单实例 | `tauri-plugin-single-instance`，第二实例转交路径 | 必做 | 必做 | 必做 |
| 3. 新开窗口 + 前端打开 | `WebviewWindowBuilder` 建窗，前端按 label 拉取路径 | 必做 | 必做 | 必做 |
| 4. **注册表由谁写** | — | **安装脚本** | **程序自己** | **程序自己** |

### 方案 A：安装包注册（当前采用）

- 安装时由安装脚本写注册表，卸载时脚本自动清理。
- 程序侧完全不碰注册表，不写也不读。
- 依赖只加 `tauri-plugin-single-instance`（**不需要** `winreg`、`windows-sys`）。
- 代价：需维护两份脚本（NSIS + WiX）；应用内无法取消关联。

工作量：共有部分约 80 行 + NSIS 脚本约 15 行 + WiX 片段约 30 行。

### 方案 B：应用内注册

- Rust 用 `winreg` 写 HKCU，前端提供设置开关。
- 一份代码对两种安装包都生效，无需管理员权限（HKCU）。
- 用户可随时开关；每次启动校验 exe 路径，变化则静默重写（自愈）。
- 代价：需新增设置 UI（本项目原本没有设置模块）；卸载后留 HKCU 残留。

工作量：共有部分约 80 行 + Rust 注册表命令约 80 行（associate / unassociate / status / 路径自愈）+ 前端开关约 25 行。

### 方案 C：B + 卸载清理

- 注册逻辑同 B，额外在安装脚本里加"仅删除"的清理代码。
- 注意：**C = B + 卸载清理，不是 A + B**。C 不包含"安装即关联"。
- 清理脚本比 A 的注册脚本简单得多（只需 `DeleteRegKey`，WiX 侧加 `Action="createAndRemoveOnUninstall"`）。

## 三、为什么选 A

1. 本项目**没有设置模块**，选 B 要为这一个功能新增一块设置 UI，破坏现有结构。
2. 选 A 程序侧最"干净"：不引入 `winreg` / `windows-sys` 依赖，不留注册表自愈逻辑。
3. 安装即关联，用户零操作。
4. 卸载清理由脚本负责，程序不残留状态。

## 四、方案 A 的注册表结构（HKCU，免管理员）

```
HKCU\Software\Classes\NoteMark.md
    (Default)                    = "Markdown Document"
    DefaultIcon                  = "<安装目录>\notemark.exe,0"
    shell\open\command\(Default) = '"<安装目录>\notemark.exe" "%1"'

HKCU\Software\Classes\Applications\notemark.exe
    FriendlyAppName              = "NoteMark"
    DefaultIcon                  = "<安装目录>\notemark.exe,0"
    shell\open\command\(Default) = '"<安装目录>\notemark.exe" "%1"'

HKCU\Software\Classes\.md\OpenWithProgids
    "NoteMark.md" = ""

HKCU\Software\Classes\.markdown\OpenWithProgids
    "NoteMark.md" = ""
```

两个扩展名复用同一个 ProgID `NoteMark.md`，避免重复定义。

## 五、实现要点与坑

### 安装脚本侧

- **NSIS**：`tauri.conf.json` 配 `bundle.windows.nsis.installerHooks` 指向 `src-tauri/windows/hooks.nsh`；
  `NSIS_HOOK_POSTINSTALL` 里 `WriteRegStr`，`NSIS_HOOK_PREUNINSTALL` 里 `DeleteRegKey`。
- **WiX**：`bundle.windows.wix.fragmentPaths` + `componentRefs` 指向 `src-tauri/windows/fragments/*.wxs`；
  用 `RegistryKey Action="createAndRemoveOnUninstall"` 让 MSI 自动清理，卸载无需额外代码。
- **卸载时只删 `OpenWithProgids` 里的值**，不能删整个 `.md` 键，否则影响其他已关联的程序。
- 写完注册表要刷新图标：NSIS 用 `System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'`
  （`SHCNE_ASSOCCHANGED = 0x08000000`）。
- 安装后的 exe 名是 `notemark.exe`（小写，Tauri 依据 productName 生成）。

### 程序侧（Rust）

- **参数要过滤**：Windows/Tauri 可能传入 `--xxx` 标志，只接受真实存在且扩展名为 `.md`/`.markdown` 的路径。
- **前端就绪时序**：进程启动时前端还没加载完，直接 `emit` 会丢事件。用**拉取模式**——
  Rust 维护 `HashMap<窗口 label, 文件路径>`，前端用自己的 `getCurrentWebviewWindow().label` 去
  `invoke` 拉取，取走即清空。运行中的实例则继续用 `open-file` 事件。
- **窗口 label 用路径 hash**：保证同一文件重复双击时聚焦已有窗口，而不是开两个相同窗口；
  同时让 `window-state` 插件能复用位置记忆（该插件按 label 存状态，用递增 ID 会导致状态无限累积）。
- **单实例回调要"建窗"而非"转发"**：因为用户选择新开窗口，回调里应用 `WebviewWindowBuilder`
  新建窗口（若同名窗口已存在则聚焦）。

### Windows 平台限制

- **不能强抢"默认程序"**：Win10+ 默认关联存在 `HKCU\...\Explorer\FileExts\.md\UserChoice`，
  带 Hash 校验，应用无法可靠伪造。注册后只能让 NoteMark 出现在"打开方式"列表，
  由用户自行设为默认（或引导到 `ms-settings:defaultapps`）。

## 六、如何改用方案 B 或 C

1. `git checkout backup/pre-file-assoc`（回到实现前的代码基点）。
2. 按上面"方案 B / C"的描述实现第 4 环节（注册表写入）。
3. 第 1~3 环节（命令行参数、单实例、新开窗口）可参考当前 main 分支的实现，逻辑完全通用。
4. 若选 C，额外在安装脚本加清理代码即可。
