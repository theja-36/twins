// ESLint 9 flat config for the TWINS monorepo (TypeScript, ESM).
// Replaces the legacy .eslintrc.* format required by ESLint v9.
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // Global ignores — never lint build output, migrations, or lock files.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/database/drizzle/**",
      "package-lock.json",
      "**/*.tsbuildinfo",
      "eslint.config.js",
      // The standalone frontend (Stage 09.2) has its own ESLint config and lockfile; it is linted by its own CI job.
      "frontend/**",
    ],
  },

  // TypeScript source files across the whole monorepo.
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // Dedicated ESLint tsconfig that includes every TS file in the repo
        // (packages, adapters, apps, services, tests, config files) so
        // parserOptions.project can resolve them without errors.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Pull in the recommended set as a baseline, then tighten key rules.
      ...tseslint.configs.recommended.rules,

      // Never suppress type-safety with `any` - use `unknown` then narrow.
      "@typescript-eslint/no-explicit-any": "error",

      // Unused variables are bugs in this codebase; allow _ prefix to opt out explicitly.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Floating promise chains are dangerous in async pipelines (spec section 45).
      "@typescript-eslint/no-floating-promises": "error",

      // All awaited values must be Promises.
      "@typescript-eslint/await-thenable": "error",

      // Require explicit return types on exported functions for documentation clarity.
      "@typescript-eslint/explicit-module-boundary-types": "off",

      // Non-null assertion (!) is allowed but should be rare; flag overuse via review.
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
];
