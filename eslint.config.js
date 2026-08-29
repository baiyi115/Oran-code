import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "tmp/**",
      "evals/workspaces/**",
      "evals/results/**",
      "pnpm-lock.yaml",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // CLI 与调试工具允许直接输出与进程退出。
      "no-console": "off",
      "no-process-exit": "off",
      // 前缀下划线的有意未使用参数（测试桩、端口适配层）不告警。
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs", "*.config.js", "evals/cases/**/*.mjs", "evals/cases/**/*.js"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // 测试里的 any 用于探查私有状态、空 async 生成器用于桩实现,均为惯用法。
    files: ["packages/**/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "require-yield": "off",
    },
  },
);
