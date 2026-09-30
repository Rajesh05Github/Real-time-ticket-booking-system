import baseConfig from '@flashsale/eslint-config';
import nextConfig from 'eslint-config-next';

// Only pull the `react-hooks` plugin out of eslint-config-next -- spreading
// the whole config redefines the `import` plugin that @flashsale/eslint-config
// already registers, which ESLint's flat config rejects outright.
const reactHooksPlugin = nextConfig[0].plugins['react-hooks'];

export default [
  ...baseConfig,
  {
    plugins: { 'react-hooks': reactHooksPlugin },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // React Server Components use default exports for page/layout files by
    // Next.js convention -- the shared `no-default-export` rule would
    // otherwise fight the framework on every single route file.
    rules: {
      'import/no-default-export': 'off',
    },
  },
];
