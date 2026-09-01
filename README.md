# NoteMark

> Typora 风格的**所见即所得 Markdown 编辑器**，基于 Milkdown + Tauri v2 + Vue 3。

编辑区直接渲染最终效果（标题、加粗、列表、代码块、公式、图表），无需在源码与预览间切换；同时保留完整的 Markdown 语义，可随时切到源码模式精修。桌面端用 Tauri 打包，体积轻、启动快。

---

## 特性

- **所见即所得编辑**：Milkdown（ProseMirror）内核，支持源码 / WYSIWYG 双模式切换
- **斜杠命令菜单**：输入 `/` 唤起块插入菜单（标题、列表、代码块、公式、流程图、提示框等）
- **查找 / 替换**：全文查找、正则、区分大小写、逐个 / 全部替换
- **Mermaid 图表**：```mermaid 代码块实时渲染；**切换主题时图表会实时重渲染**
- **数学公式**：KaTeX，行内 `$...$` 与块级 `$$...$$`
- **HTML 块与行内 HTML**：白名单 sanitize 后真实渲染（含安全 iframe）
- **提示块**：`> [!NOTE]` / `TIP` / `IMPORTANT` / `WARNING` / `CAUTION`
- **目录（TOC）**、**Frontmatter**、**`==高亮==`** 标记
- **任务列表**：SVG 复选框，点击切换
- **表格右键菜单**：插入行列、合并等
- **图片**：粘贴 / 拖拽 / 插入，相对路径资源统一管理在 `assets/`
- **深色模式** + **自定义主题导入**（Typora 风格）
- **导出**：HTML、Word（`.docx`）、打印
- **工作目录**与**最近文件**记忆

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端框架 | Vue 3 + TypeScript + Vite |
| 编辑器内核 | Milkdown（ProseMirror） |
| 桌面壳 | Tauri v2（Rust） |
| 公式 | KaTeX；图表 | Mermaid |
| 导出 | `docx` |

---

## 环境要求

- **Node.js 20+**（开发环境使用 24）
- **Rust 稳定版**（Tauri 编译需要）
- 桌面打包的平台依赖：
  - **Windows**：`WiX Toolset v3`（MSI）+ `NSIS`（exe 安装包）
  - **Linux**：`webkit2gtk-4.1` 等（见 Tauri 官方文档）
  - **macOS**：Xcode 命令行工具

---

## 快速开始

```bash
npm install

npm run dev          # 浏览器预览（Vite，http://127.0.0.1:5173）
npm run tauri:dev    # 启动桌面应用（带热重载）
```

---

## 构建与打包

```bash
npm run build        # 类型检查（vue-tsc）+ 前端构建到 dist/
npm run tauri:build  # 打包桌面应用并生成安装包
```

产物位置（`src-tauri/target/release/`）：

| 产物 | 路径 |
|---|---|
| 可执行文件 | `notemark.exe` |
| 安装包（Windows 默认 `targets: "all"`，即 MSI + NSIS exe） | `bundle/` |

**Windows 安装包依赖**（首次打包前安装其一即可，会自动加入 PATH）：

```bash
winget install WiXToolset.WiXToolset NSIS.NSIS
# 或
scoop install wixtoolset nsis
```

> 仅运行 `npm run dev` / `tauri:dev` 不需要上述打包工具；只有生成安装包（`tauri:build`）才需要。

---

## 主题系统

内置主题由 `src/editor/theme/*.css` 提供。自定义主题走 **Typora 风格**的工作流：

1. 仓库根目录提供三个示例文件作为起点：
   - `theme-custom.example.css` —— 变量覆盖模板（复制后改名即可用）
   - `theme-emerald.css`、`theme-forest.css`、`theme-rose.css` —— 完整配色示例
2. 通过工具栏 **主题 → 导入自定义主题…** 选择 `.css` 文件：文件会复制到应用数据目录下的 `themes/` 并即时生效（支持一次多选，重名自动加序号）。
3. **打开主题目录** 可在系统文件管理器里手动增删主题文件。
4. 主题通过 CSS 层叠覆盖，只需写最简选择器（如 `.milkdown h1 { … }`）或修改 `--mt-*` 变量即可；变量定义见 `src/editor/theme/tokens.css` 等。
5. 切换主题时 Mermaid 图表会实时重渲染；深色模式由 `<html data-theme="dark">` 驱动。

> 自定义主题文件**禁止 `@import`**（安全与可控性考虑，导入时会被拒绝）。

---

## 项目结构（改动时定位）

```
src/
├─ main.ts                 # 应用入口
├─ App.vue                 # 主应用壳：工具栏 / 主题菜单 / 文件操作 / 查找替换 UI / 打印 / 快捷键 / 启动加载
├─ components/             # Vue 子组件（FindBar 等）
└─ editor/
   ├─ index.ts             # 编辑器装配核心：创建 Milkdown editor、插件组合、选区/滚动/聚焦工具
   ├─ plugins.ts           # 插件数组汇总（所有 editor 插件的注册入口）
   ├─ themeManager.ts      # 自定义/外置主题：导入、应用、持久化、深色、mermaid 暗色块
   ├─ slash-menu.ts        # 斜杠命令菜单（命令注册表 + 菜单 UI + 链接框）
   ├─ find-replace.ts      # 查找 / 替换核心逻辑（ProseMirror 插件）
   ├─ diagram-view.ts      # Mermaid 图表 NodeView + 主题切换实时刷新
   ├─ math-view.ts         # 数学公式 NodeView（KaTeX）
   ├─ html-block.ts        # HTML 块（复用 html-view 的 sanitize）
   ├─ html-view.ts         # 行内 HTML 真实渲染 + sanitize 白名单
   ├─ html-merge.ts        # 修复行内 HTML 标签被拆散的 remark 插件
   ├─ alert.ts             # 提示块（>[!NOTE] 等）
   ├─ toc.ts               # 目录
   ├─ frontmatter.ts       # Frontmatter
   ├─ highlight.ts         # ==高亮== 标记
   ├─ inline-mark-escape.ts# Esc 退出行内格式（聚焦修复的一部分）
   ├─ list-item.ts         # 列表项 NodeView / 任务列表 SVG 复选框
   ├─ table-menu.ts        # 表格右键菜单
   ├─ image-block.ts / image-drop.ts / image-files.ts / image-paste.ts / image-view.ts
   │                       #   图片：独占段落标记 / 拖拽 / 资源管理 / 剪贴板 / NodeView
   ├─ workspace.ts         # 工作目录持久化
   ├─ fileOps.ts           # 文件操作封装（Tauri v2 文件 API）
   ├─ exporter.ts          # 导出 HTML（收集运行时样式）
   ├─ docxExporter.ts      # 导出 Word（遍历 PM 文档树生成 OOXML）
   └─ theme/               # 内置主题 CSS
       ├─ index.css        # @import 聚合层（不写具体样式）
       ├─ tokens.css       # 设计令牌 / CSS 变量（浅色 + 深色）
       ├─ base.css         # 排版基础（:where() 压低特异性，便于用户主题覆盖）
       ├─ code.css         # 代码块 + CM6 语法高亮配色
       ├─ dark.css         # 内置暗色
       ├─ code-tokens.css  # 代码高亮令牌变量
       ├─ find.css         # 查找高亮（未分层，确保任意主题下可见）
       └─ slash-menu.css   # 斜杠菜单样式

src-tauri/                 # Tauri / Rust 壳（Cargo.toml、src/main.rs、build.rs、icons、capabilities）
```

> **维护提示**：`src/App.vue` 体量较大（工具栏、主题菜单、文件操作等 UI 逻辑集中于此），改动这类功能时优先在此文件定位；编辑器能力则分散在 `src/editor/*` 各模块，新增编辑器特性通常从 `plugins.ts` 接入。

---

## 已知限制

- **查找 / 替换**：跨多个节点的匹配（如跨段落的链接）无法命中；Mermaid / 公式等原子节点内部文本不参与搜索（与多数基于 ProseMirror 的编辑器一致）。
- **Word 导出**：代码块保留文本与等宽字体、灰底，但不保留语法高亮配色；KaTeX 公式 / Mermaid 图表退化为源码文本；图片仅内嵌 `png/jpg/gif/bmp`（svg 等格式降级为文件名文字）；嵌套表格内层以段落呈现；任务列表勾选框以 `[x]` / `[ ]` 文本标记。
- **自定义主题**：禁止 `@import`。

---

## 版本

当前版本 `0.2.0`（与 `package.json` / `tauri.conf.json` / `src-tauri/Cargo.toml` 三处保持一致）。
