import { createApp } from "vue";
import App from "./App.vue";

// WebView2 keeps its browser context menu enabled by default. Use a bubble
// listener so custom handlers run first; ProseMirror treats defaultPrevented
// as handled and would otherwise stop later editor plugins.
if ("__TAURI_INTERNALS__" in window) {
  window.addEventListener("contextmenu", (event) => event.preventDefault());
}

// 注意：全局样式只走 App.vue 中引入的 theme/index.css，
// 这里不引入任何全局 style.css，避免污染 .milkdown 作用域。
createApp(App).mount("#app");
