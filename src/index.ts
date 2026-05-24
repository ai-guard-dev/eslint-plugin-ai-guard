import { allRules } from './rules';
import recommended from './configs/recommended';
import strict from './configs/strict';
import security from './configs/security';
import fs from 'fs';
import path from 'path';

// Read version directly to avoid importing from cli/ (which breaks TS rootDir constraint)
const pkgPath = path.resolve(__dirname, '../package.json');
let pkgVersion = '1.2.2'; // Fallback
try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version) pkgVersion = pkg.version;
} catch {
  // Ignore
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
