import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve content globs against THIS FILE, not the process CWD. Tailwind treats
// relative globs as CWD-relative, so launching vite from another directory
// silently matches nothing and emits zero utilities — base styles still apply,
// which makes it look like a layout bug rather than a config one.
// Forward slashes are required: Tailwind globs via fast-glob, which treats a
// backslash as an escape character, so a Windows path.join() pattern silently
// matches nothing.
const here = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');

/** @type {import('tailwindcss').Config} */
export default {
  content: [`${here}/index.html`, `${here}/src/**/*.{ts,tsx}`],
  theme: {
    extend: {
      colors: {
        deckA: '#22d3ee',
        deckB: '#f472b6',
        panel: '#131720',
        panel2: '#1b2130',
        edge: '#2a3244',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
