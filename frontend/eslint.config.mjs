// ESLint 9 flat config for the standalone frontend (the repository root config ignores frontend/).
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  { ignores: [".next/**", "node_modules/**", "standalone/**", "next-env.d.ts", "playwright-report/**", "test-results/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-restricted-globals": ["error", "localStorage", "sessionStorage"],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.name=/^(parseFloat|parseInt)$/]", message: "No numeric parsing of money in the frontend: values are displayed, never calculated." },
        { selector: "CallExpression[callee.object.name='Math']", message: "No arithmetic helpers in business logic: the frontend performs no financial or risk calculation." },
      ],
    },
  },
  {
    // The only places allowed to touch browser storage: the theme preference (a per-viewer convenience, in try/catch), never a token.
    files: ["src/components/ThemeProvider.tsx", "src/test/**", "e2e/**"],
    rules: { "no-restricted-globals": "off" },
  },
  // Playwright fixtures receive a callback named `use`, which is not a React hook.
  { files: ["e2e/**"], rules: { "react-hooks/rules-of-hooks": "off" } },
  { files: ["e2e/**", "src/**/*.test.{ts,tsx}", "src/test/**"], rules: { "no-restricted-syntax": "off", "@typescript-eslint/no-non-null-assertion": "off" } },
);
