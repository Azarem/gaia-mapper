import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { app: 'src/index.ts' },
  format: ['iife'],
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  target: 'es2022',
  minify: false,
  globalName: 'GaiaMapper',
  platform: 'browser',
  deps: { alwaysBundle: ['fflate'] },
});
