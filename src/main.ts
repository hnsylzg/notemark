import { createApp } from "vue";
import App from "./App.vue";

// 注意：全局样式只走 App.vue 中引入的 theme/index.css，
// 这里不引入任何全局 style.css，避免污染 .milkdown 作用域。
createApp(App).mount("#app");
