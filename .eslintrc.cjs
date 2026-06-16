/* eslint config for GoonerBot (TypeScript, strict) */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    es2023: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', '_tg_rp_bot_source/', 'scripts/', 'vendor/', '*.cjs'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    'no-console': 'warn',
  },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      env: { node: true },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
