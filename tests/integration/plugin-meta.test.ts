import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import plugin from '../../src/index';

describe('plugin metadata', () => {
  it('keeps meta.name and meta.version aligned with package.json', () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      name: string;
      version: string;
    };

    expect(plugin.meta.name).toBe(pkg.name);
    expect(plugin.meta.version).toBe(pkg.version);
  });
});

describe('plugin configurations', () => {
  it('exports agent config with exactly 5 error rules', () => {
    expect(plugin.configs).toHaveProperty('agent');
    
    const agentConfig = plugin.configs.agent;
    expect(agentConfig).toBeDefined();
    
    if (agentConfig && typeof agentConfig === 'object' && 'rules' in agentConfig) {
      const rules = agentConfig.rules as Record<string, string>;
      expect(Object.keys(rules)).toHaveLength(5);
      
      const expectedRules = [
        'ai-guard/no-hardcoded-secret',
        'ai-guard/no-eval-dynamic',
        'ai-guard/no-empty-catch',
        'ai-guard/no-sql-string-concat',
        'ai-guard/no-floating-promise'
      ];
      
      expectedRules.forEach(rule => {
        expect(rules[rule]).toBe('error');
      });
    } else {
      throw new Error('agent config rules not found');
    }
  });
});
