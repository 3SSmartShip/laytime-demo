const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    // Loaded both by Node (require) and by the browser (<script>).
    files: ['shared/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, module: 'writable', require: 'readonly' } },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Api: 'readonly',
        Editor: 'readonly',
        Engine: 'readonly',
        Statement: 'readonly',
        makeSample: 'readonly',
      },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
