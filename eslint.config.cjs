const tseslint = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    ignores: ['dist/**'],
  },
  ...tseslint.configs['flat/recommended'],
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
