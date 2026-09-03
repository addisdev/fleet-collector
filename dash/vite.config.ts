import { defineConfig } from "vite";

// No @preact/preset-vite: esbuild's automatic JSX runtime pointed at preact
// does the same job for a bundle this size, and the collector's deploy story
// rewards every dependency not taken.
export default defineConfig({
  // The dashboard is served from a subpath, never the origin root.
  base: "/dash/",
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The collector is a 2016 MacBook on a LAN; a source map costs nothing to
    // serve and turns a stack trace in the field into something readable.
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5178,
    // `npm run dev` in this directory talks to a real collector, so the SPA
    // never needs a mock API. Point FLEET_URL at another host to develop the
    // dashboard against the live fleet.
    proxy: {
      "/api": {
        target: process.env.FLEET_URL ?? "http://127.0.0.1:8788",
        changeOrigin: true,
      },
      // The Visual page renders baseline/current/diff images straight from the
      // artifact store; without this, dev serves the SPA shell where a PNG
      // should be.
      "/artifacts": {
        target: process.env.FLEET_URL ?? "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
});
