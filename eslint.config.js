// Two questions, not a style guide: is every control reachable and named
// (jsx-a11y), and does every hook obey the rules (react-hooks). Formatting and
// the rest of typescript-eslint's opinions stay out, since tsc already checks
// the types and nobody asked for a lint over naming.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The two hook rules that have been in the plugin since it existed. The
      // React Compiler rules that arrived with v6 (set-state-in-effect, refs,
      // purity) would have the history pane's paging and the inbox's desk
      // rewritten for a compiler this project does not run.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // An unused argument that names what a callback is handed is
      // documentation; a leading underscore says it is deliberate.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // The rule is about page load, where a focused field steals the screen
      // reader's place. Every autoFocus here is inside something the user just
      // opened, and the field is the reason they opened it: the palette's
      // query and the issue and pull request titles.
      "jsx-a11y/no-autofocus": "off",
    },
  },
);
