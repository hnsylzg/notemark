import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";

export default [
  {
    ignores: [
      ".backups/**",
      ".codex-backups/**",
      "dist/**",
      "node_modules/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
    ],
  },
  ...tseslint.configs.recommended,
  ...vue.configs["flat/essential"],
  {
    files: ["src/**/*.{ts,vue}"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        alert: "readonly",
        confirm: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        requestAnimationFrame: "readonly",
        HTMLElement: "readonly",
        HTMLImageElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLInputElement: "readonly",
        Element: "readonly",
        Node: "readonly",
        Event: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        BeforeUnloadEvent: "readonly",
        File: "readonly",
        FileReader: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        Blob: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "vue/multi-word-component-names": "off",
    },
  },
  {
    files: ["src/**/*.vue"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
];
