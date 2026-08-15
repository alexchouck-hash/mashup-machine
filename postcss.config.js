import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Point Tailwind at its config EXPLICITLY. The plugin otherwise resolves
// tailwind.config.js from process.cwd(), so launching vite from any other
// directory silently falls back to the default config — empty content, no
// utilities emitted, only preflight. That failure looks like broken CSS in the
// app rather than a misresolved config, so it is worth pinning.
const here = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');

export default {
  plugins: {
    tailwindcss: { config: `${here}/tailwind.config.js` },
    autoprefixer: {},
  },
};
