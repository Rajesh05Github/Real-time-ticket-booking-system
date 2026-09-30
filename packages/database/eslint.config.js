import baseConfig from '@flashsale/eslint-config';

export default [
  ...baseConfig,
  {
    // Generated Prisma client output is vendored code, not ours to lint.
    ignores: ['generated/**'],
  },
  {
    // A CLI script's own stdout output, not an accidental debug log.
    files: ['prisma/seed.ts', 'prisma/promote-admin.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
