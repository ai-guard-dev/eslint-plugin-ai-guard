// Generates THIRD-PARTY-NOTICES.md for the npm packages that tsup bundles into dist/.
// The package list comes from the bundles' own source maps, so it matches what is shipped.
// Usage: npm run build && node scripts/generate-third-party-notices.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bundles = ['dist/cli/index.js.map', 'dist/mcp/server.js.map', 'dist/index.js.map'];

/** Resolve the package directory that a source-map path lives in (handles nested node_modules). */
function packageDirOf(source) {
  const marker = 'node_modules/';
  const at = source.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = source.slice(at + marker.length).split('/');
  const name = rest[0].startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
  return source.slice(0, at + marker.length) + name;
}

const dirs = new Set();
for (const rel of bundles) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`${rel} missing — run "npm run build" first`);
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const source of map.sources) {
    const dir = packageDirOf(source.replaceAll('\\', '/'));
    if (dir) dirs.add(path.resolve(path.dirname(file), dir));
  }
}

const entries = [];
for (const dir of dirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licenseFile = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)([-._]|$)/i.test(f));
  entries.push({
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : 'See license text',
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : null,
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const missing = entries.filter((e) => !e.text);
if (missing.length) throw new Error(`No license file found for: ${missing.map((e) => e.name).join(', ')}`);

const out = [
  '# Third-Party Notices',
  '',
  'The `dist/` files of eslint-plugin-ai-guard include code from the following open-source packages,',
  'bundled at build time. Their license texts are reproduced below.',
  '',
  ...entries.flatMap((e) => [`## ${e.name}@${e.version} (${e.license})`, '', '```text', e.text, '```', '']),
].join('\n');

fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), out);
console.log(`Wrote THIRD-PARTY-NOTICES.md (${entries.length} packages: ${entries.map((e) => e.name).join(', ')})`);
