import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'server/dist/**',
      'server/public/**',
      'server/drizzle/**',
      'server/data/**',
      'e2e/.tmp/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS Node scripts (e.g. the e2e server bootstrap).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Fetch-on-mount (`void load()` inside a mount effect) is this app's
      // deliberate data pattern; the React-Compiler-era lint dislikes it.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
)
