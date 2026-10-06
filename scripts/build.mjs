import { build } from 'esbuild';
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], outfile: 'dist/extension.js', sourcemap: true });
