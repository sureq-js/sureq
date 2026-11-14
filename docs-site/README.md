# SureQ documentation site

Static documentation built from [`../user-docs`](../user-docs) with React Router (framework mode, `ssr: false` + prerendering), Vite and Tailwind CSS. The UI is adapted from the Tailwind Plus Protocol template.

## Commands

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build      # writes build/client for GitHub Pages
npm run preview
```

## How it works

- `src/lib/load-docs.ts` reads every Markdown file in `../user-docs`, builds the navigation and search index, and highlights code blocks with Shiki at build time.
- `vite-plugin-docs.ts` exposes that data as the `virtual:sureq-docs` module.
- `react-router.config.ts` prerenders one HTML page per doc.

## License

The Protocol template UI is licensed under the Tailwind Plus license. See [LICENSE.md](LICENSE.md).
