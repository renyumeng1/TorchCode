import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDirectory, '..');
const vendorDirectory = path.join(extensionRoot, 'media', 'vendor');

const assets = [
  ['node_modules/markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
  ['node_modules/katex/dist/katex.min.js', 'katex.min.js'],
  ['node_modules/katex/dist/contrib/auto-render.min.js', 'auto-render.min.js'],
  ['node_modules/katex/dist/katex.min.css', 'katex.min.css']
];

await mkdir(vendorDirectory, { recursive: true });
for (const [source, destination] of assets) {
  await cp(path.join(extensionRoot, source), path.join(vendorDirectory, destination), { force: true });
}
await cp(
  path.join(extensionRoot, 'node_modules', 'katex', 'dist', 'fonts'),
  path.join(vendorDirectory, 'fonts'),
  { recursive: true, force: true }
);
