import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// SillyTavern 已在全局挂载的第三方库:映射到全局变量,避免重复打包。
const globals: Record<string, string> = {
  jquery: '$',
  lodash: '_',
  toastr: 'toastr',
};

const package_json = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const package_version = String(package_json.version ?? '');

export default defineConfig(({ mode }) => ({
  define: {
    __HTJ_ZZ_VERSION__: JSON.stringify(package_version),
  },

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  build: {
    rollupOptions: {
      input: 'src/index.ts',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].[hash].chunk.js',
        assetFileNames: '[name].[ext]',
        globals,
      },
      external: id => id in globals,
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: mode === 'production',
    target: 'esnext',
  },
}));
