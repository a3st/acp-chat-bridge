import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['src/runtime.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/runtime-test.cjs' });
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], outfile: 'dist/extension-test.cjs' });
const result = spawnSync(process.execPath, ['--test', 'test/runtime.test.cjs', 'test/localization.test.cjs', 'test/setup.test.cjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
