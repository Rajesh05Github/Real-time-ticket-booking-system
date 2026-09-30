/** Tailwind v4 is CSS-first -- no tailwind.config.ts. This is the only
 * config file it needs; everything else lives in globals.css's @theme
 * block. Outside every tsconfig's `include` (same arrangement as
 * eslint.config.js -- see packages/eslint-config/index.js's comment),
 * so it's never type-checked as part of `src/**`. */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
