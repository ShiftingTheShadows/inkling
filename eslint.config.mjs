// Flat config. The rules are deliberately narrow: the source is written against
// browser globals and hand-rolled globals (window.S, React via CDN), so a
// default rule set drowns in no-undef noise. What we do want is the static
// version of test/hooks-check.mjs (rules-of-hooks) plus the cheap "this will
// throw at runtime" checks.
import reactHooks from 'eslint-plugin-react-hooks';

const basics = {
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-debugger': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': 'off',
  'no-undef': 'off',
  'no-unused-vars': 'off',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'desktop/**', 'fonts/**'] },
  {
    files: ['src/**/*.jsx'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { ...basics, 'react-hooks/rules-of-hooks': 'error' },
  },
  {
    files: ['api/**/*.js', 'test/**/*.js', 'scripts/**/*.mjs', 'build.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: basics,
  },
];
