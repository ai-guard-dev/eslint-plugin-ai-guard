import { allRules } from './rules';
import recommended from './configs/recommended';
import strict from './configs/strict';
import security from './configs/security';

const plugin = {
  meta: {
    name: 'eslint-plugin-ai-guard',
    version: '1.2.0',
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
