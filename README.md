# NoteMark

NoteMark 是一个简洁的 Typora 风格 Markdown 编辑器，基于 Milkdown、Tauri v2 和 Vue 3。编辑区直接显示最终排版，同时保留标准 Markdown 源文件。

## 特性

- 支持 GFM、表格、任务列表、脚注、Front Matter、目录、提示块、公式和 Mermaid。
- 行内格式与链接可直接编辑源码标记，并提供查找替换、图片粘贴和拖拽插入。
- 支持 HTML、PDF、纯文本和 Word 导出。
- 支持明暗主题与自定义 CSS 主题，并提供自动恢复、原子保存和统一状态存储。

## 技术栈

- 编辑内核：Milkdown / ProseMirror
- 桌面端：Tauri v2 / Rust / SQLite
- 前端：Vue 3 / TypeScript / Vite
- 内容渲染：MathJax、Mermaid

## 快速开始

需要 Node.js 20+ 和 Rust 稳定版。

```bash
npm install
npm run tauri:dev
```

浏览器中预览：

```bash
npm run dev
```

## 构建与检查

```bash
npm run build
npm run lint
npm test
npm run check
npm run tauri:build
```

桌面安装包输出到 `src-tauri/target/release/bundle/`。

## 已知限制

- 查找替换不能跨多个节点匹配，公式和 Mermaid 内部的文本不参与搜索。
- Word 导出的代码块不保留语法高亮；远程图片无法读取字节时会降级为占位。
- 自定义主题禁止使用 `@import`；远程 iframe 使用不透明源沙箱。

## 版本

当前版本 `0.4.2`。
