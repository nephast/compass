// Flat config (ESLint 9+). Each workspace can extend this with its own
// overrides (e.g. apps/frontend adding React/Next.js rules).
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // The structured logger is the one place console is the transport, not a
    // debugging leftover — everything else routes through it (COMPASS-29).
    files: ["**/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**", "**/.next/**"],
  },
];
