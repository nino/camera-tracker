import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Vitest's injected globals (we run with `globals: true`). Declared here so the
// linter doesn't flag `describe`/`it`/`expect`/`vi` as undefined in test files.
const vitestGlobals = {
   describe: "readonly",
   it: "readonly",
   test: "readonly",
   expect: "readonly",
   vi: "readonly",
   suite: "readonly",
   beforeAll: "readonly",
   afterAll: "readonly",
   beforeEach: "readonly",
   afterEach: "readonly",
   expectTypeOf: "readonly",
};

export default tseslint.config(
   { ignores: ["dist", "coverage", "src-tauri", "solver"] },

   // Recommended baselines: core JS, TypeScript, React, and the React Hooks rules.
   { settings: { react: { version: "detect" } } },
   js.configs.recommended,
   ...tseslint.configs.recommended,
   react.configs.flat.recommended,
   react.configs.flat["jsx-runtime"], // we use the automatic JSX runtime (React 19)
   reactHooks.configs.flat["recommended-latest"],

   // App source.
   {
      files: ["**/*.{ts,tsx}"],
      languageOptions: { ecmaVersion: 2020, globals: globals.browser },
      plugins: { "react-refresh": reactRefresh },
      rules: {
         "react-refresh/only-export-components": [
            "warn",
            { allowConstantExport: true },
         ],
      },
   },

   // Test files run in Vitest with globals enabled.
   {
      files: ["**/*.{test,spec}.{ts,tsx}", "src/test/**"],
      languageOptions: { globals: { ...globals.node, ...vitestGlobals } },
   },

   // Config files run in Node.
   {
      files: ["**/*.config.{js,ts}"],
      languageOptions: { globals: globals.node },
   },

   // Keep ESLint out of Prettier's lane — must stay last.
   prettier,
);
