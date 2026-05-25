import { allRules } from './rules';
import recommended from './configs/recommended';
import strict from './configs/strict';
import security from './configs/security';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

// Safely read version in both CJS and ESM environments
let pkgVersion = '1.2.2'; // Fallback
try {
  // Use createRequire combined with import.meta.url for ESM compatibility
  const require_ = typeof require !== 'undefined' ? require : createRequire(import.meta.url);
  
  // Calculate path relative to the current file
  const isESM = typeof __dirname === 'undefined';
  const dirname = isESM ? path.dirname(fileURLToPath(import.meta.url)) : __dirname;
  
  // Find package.json (works for both src/index.ts and dist/index.js/mjs)
  const pkgPath = path.resolve(dirname, dirname.endsWith('src') ? '../package.json' : '../../package.json');
  
  const pkg = require_(pkgPath);
  if (pkg && pkg.version) pkgVersion = pkg.version;
} catch {
  // Ignore and use fallback
}

const plugin = {
  meta: {
    name: 'eslint-plugin-ai-guard',
    version: pkgVersion,
  },
  rules: allRules,
  configs: {
    recommended,
    strict,
    security,
  },
};

export default plugin;
export { allRules as rules };
export { recommended, strict, security };
