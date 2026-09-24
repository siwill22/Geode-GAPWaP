import { defineConfig } from 'vite';

// GitHub Pages serves a project site under /<repo>/, not the domain root --
// VITE_BASE is set by the deploy workflow below, from the repo's own name,
// so this works unmodified whatever the site was named. Do not hardcode a
// path here (see the main Geode repo's own vite.config.ts for why).
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  server: { port: 5173 },
  build: {
    target: 'es2022',
    // three.js alone accounts for most of this and isn't meaningfully
    // tree-shakeable here -- the whole rendering pipeline is used, and a
    // single-view WebGL app has no route-based split point. Raised rather
    // than chased: Vite's default 500 kB warning assumes a splittable app,
    // which this genuinely isn't.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Name the three/lil-gui chunk explicitly rather than letting
        // Rollup pick one of the app modules bundled alongside it, and
        // split it from app code so a code-only redeploy doesn't
        // invalidate the browser's cached copy of three.js.
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
});
