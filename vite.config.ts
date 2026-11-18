import { fileURLToPath, URL } from 'node:url'
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const mathJaxRoot = resolve(projectRoot, 'node_modules/mathjax')
const mathJaxFontRoot = resolve(
  projectRoot,
  'node_modules/@mathjax/mathjax-newcm-font'
)
const mathJaxPublicPrefix = '/mathjax/'
const mathJaxFontPublicPrefix = `${mathJaxPublicPrefix}fonts/newcm/`
const micromarkMathSyntax = resolve(
  projectRoot,
  'node_modules/micromark-extension-math/lib/syntax.js'
)

function collectJavaScriptFiles(root: string, relative = ''): string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(relative, entry.name)
      return entry.isDirectory()
        ? collectJavaScriptFiles(root, path)
        : /\.js$/i.test(entry.name)
          ? [path]
          : []
    }
  )
}

const mathJaxAssetFiles = [
  'tex-svg.js',
  ...collectJavaScriptFiles(mathJaxRoot, 'input/tex/extensions'),
  ...collectJavaScriptFiles(mathJaxRoot, 'ui'),
]
const mathJaxFontAssetFiles = collectJavaScriptFiles(
  mathJaxFontRoot,
  'svg/dynamic'
)

/**
 * MathJax 组件通过相对路径按需加载 TeX 扩展，不能直接交给 Vite 二次打包。
 * 开发态由中间件原样提供，构建时把同一份本地资源写入 dist，保证离线可用。
 */
function mathJaxAssets(): Plugin {
  return {
    name: 'notemark-mathjax-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split('?')[0]
        const assetRoot = requestPath?.startsWith(mathJaxFontPublicPrefix)
          ? mathJaxFontRoot
          : requestPath?.startsWith(mathJaxPublicPrefix)
            ? mathJaxRoot
            : null
        if (!requestPath || !assetRoot) return next()

        const prefix =
          assetRoot === mathJaxFontRoot
            ? mathJaxFontPublicPrefix
            : mathJaxPublicPrefix
        const relative = decodeURIComponent(requestPath.slice(prefix.length))
        const file = resolve(assetRoot, relative)
        if (!file.startsWith(`${assetRoot}${sep}`)) {
          response.statusCode = 403
          response.end('Forbidden')
          return
        }

        try {
          if (!statSync(file).isFile()) return next()
        } catch {
          return next()
        }

        response.setHeader(
          'Content-Type',
          extname(file) === '.js'
            ? 'text/javascript; charset=utf-8'
            : 'application/octet-stream'
        )
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        createReadStream(file).pipe(response)
      })
    },
    generateBundle() {
      for (const relative of mathJaxAssetFiles) {
        this.emitFile({
          type: 'asset',
          fileName: `mathjax/${relative.replaceAll('\\', '/')}`,
          source: readFileSync(resolve(mathJaxRoot, relative)),
        })
      }
      for (const relative of mathJaxFontAssetFiles) {
        this.emitFile({
          type: 'asset',
          fileName: `mathjax/fonts/newcm/${relative.replaceAll('\\', '/')}`,
          source: readFileSync(resolve(mathJaxFontRoot, relative)),
        })
      }
    },
  }
}

/**
 * micromark-extension-math 的包根还会导出 KaTeX HTML renderer。
 * NoteMark 只需要语法解析，精确重定向到 syntax.js，避免把 KaTeX 打进产物。
 */
function mathSyntaxOnly(): Plugin {
  const mathRendererCompat = resolve(
    projectRoot,
    'src/editor/math-renderer-compat.ts'
  )
  return {
    name: 'notemark-math-syntax-only',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'micromark-extension-math') return micromarkMathSyntax
      if (source === 'katex' || source === 'notemark-math-renderer-compat') {
        return mathRendererCompat
      }
    },
    transform(code, id) {
      const normalizedId = id.replaceAll('\\', '/')
      if (
        !normalizedId.includes('/node_modules/mermaid/dist/') ||
        !normalizedId.endsWith('.js')
      ) {
        return
      }
      // Mermaid 的发行包还会动态导入自身打包的 KaTeX 分块（相对路径），
      // 这里统一重定向到 MathJax 兼容层。
      const next = code.replace(
        /import\("\.\/katex-[^"]+\.js"\)/g,
        'import("notemark-math-renderer-compat")'
      )
      return next === code ? undefined : { code: next, map: null }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // 前端 dev server 端口。注意：1420 在本机被 Windows 禁止监听（EACCES），
  // 故改用 5173（Vite 默认，已验证可监听）。需与 tauri.conf.json 的 devUrl 对齐。
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 忽略 src-tauri 目录：cargo 编译产物（target/*.dll）会被链接器锁定，
    // Vite 若一并监听会触发 Windows 下的 EBUSY 崩溃。
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // Tauri 期望固定的 hostname，避免某些环境下解析到非 localhost
  clearScreen: false,
  plugins: [mathSyntaxOnly(), vue(), mathJaxAssets()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
