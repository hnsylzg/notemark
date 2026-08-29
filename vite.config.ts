import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

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
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
