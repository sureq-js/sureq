import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

import { sureqDocsPlugin } from './vite-plugin-docs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // GitHub Pages serves the site at https://sureq-js.github.io/sureq/
  base: '/sureq/',
  plugins: [tailwindcss(), sureqDocsPlugin(), reactRouter()],
  ssr: {
    noExternal: [/^@algolia\//],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})