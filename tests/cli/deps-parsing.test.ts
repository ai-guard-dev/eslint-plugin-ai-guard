import { describe, expect, it } from 'vitest';
import { parseInstallCommands } from '../../cli/utils/deps/install-command';
import { initializerPackage, isValidPackageName, parseDependencySpec, parsePackageArg } from '../../cli/utils/deps/package-spec';

const pkgs = (command: string): string[] =>
  parseInstallCommands(command).flatMap((i) => i.packages.map((p) => (p.spec ? `${p.name}@${p.spec}` : p.name)));

describe('parsePackageArg', () => {
  it.each([
    ['lodash', 'lodash', null],
    ['lodash@4.17.21', 'lodash', '4.17.21'],
    ['@types/node', '@types/node', null],
    ['@types/node@^20', '@types/node', '^20'],
    ['react@latest', 'react', null],
    ['react@next', 'react', 'next'],
    ['JSONStream', 'JSONStream', null],
    ['alias@npm:real-pkg@1.0.0', 'real-pkg', '1.0.0'],
  ])('%s -> %s %s', (arg, name, spec) => {
    expect(parsePackageArg(arg)).toMatchObject({ name, spec });
  });

  it.each([
    './local-pkg', '../pkg.tgz', '/abs/path', 'C:\\pkgs\\x', 'pkg.tar.gz', 'user/repo', 'user/repo#main', 'github:user/repo',
    'git+https://github.com/a/b.git', 'https://example.com/x.tgz', 'file:../x', 'workspace:*', '.hidden', '_private', 'has space', 'lodash@github:a/b',
  ])('%s is not a registry package', (arg) => {
    expect(parsePackageArg(arg)).toBeNull();
  });

  it('validates names like npm', () => {
    expect(isValidPackageName('a'.repeat(214))).toBe(true);
    expect(isValidPackageName('a'.repeat(215))).toBe(false);
    expect(isValidPackageName('@scope/name')).toBe(true);
    expect(isValidPackageName('name/extra')).toBe(false);
  });
});

describe('parseDependencySpec', () => {
  it.each([
    ['lodash', '^4.17.21', 'lodash', '^4.17.21'],
    ['react', '18.3.1', 'react', '18.3.1'],
    ['x', 'latest', 'x', null],
    ['x', '*', 'x', null],
    ['my-alias', 'npm:real-pkg@^2', 'real-pkg', '^2'],
    ['zod', 'catalog:', 'zod', null],
  ])('%s: %s -> %s', (name, value, expected, spec) => {
    expect(parseDependencySpec(name, value)).toMatchObject({ name: expected, spec });
  });

  it.each(['workspace:*', 'workspace:^1.0.0', 'file:../lib', 'link:../lib', 'portal:../lib', 'git+ssh://git@github.com/a/b.git', 'github:a/b', 'a/b', 'https://x.example/y.tgz', '../lib'])(
    '%s is skipped', (value) => {
      expect(parseDependencySpec('pkg', value)).toBeNull();
    },
  );
});

describe('initializerPackage (npm init / create)', () => {
  it.each([
    ['vite', 'create-vite'],
    ['vite@latest', 'create-vite'],
    ['react-app', 'create-react-app'],
    ['create-foo', 'create-create-foo'],
    ['@scope', '@scope/create'],
    ['@scope/foo', '@scope/create-foo'],
    ['@scope/foo@2.0.0', '@scope/create-foo'],
  ])('%s runs %s', (arg, name) => {
    expect(initializerPackage(arg)?.name).toBe(name);
  });
});

describe('parseInstallCommands', () => {
  it.each([
    ['npm install lodash', ['lodash']],
    ['npm i -D @types/node typescript@5.4.0', ['@types/node', 'typescript@5.4.0']],
    ['npm add react@^18 react-dom@18.3.1 --save-exact', ['react@^18', 'react-dom@18.3.1']],
    ['npm isntall chalk', ['chalk']],
    ['npm install --workspace web lodash', ['lodash']],
    ['npm -w web i lodash', ['lodash']],
    ['npm --prefix ./app install chalk', ['chalk']],
    ['npm install "react@>=18"', ['react@>=18']],
    ['npm i alias@npm:real-pkg@1.0.0', ['real-pkg@1.0.0']],
    ['pnpm add -D vitest', ['vitest']],
    ['pnpm --filter web add zod', ['zod']],
    ['pnpm -C web add zod', ['zod']],
    ['pnpm add -w turbo', ['turbo']],
    ['yarn add axios', ['axios']],
    ['yarn workspace web add lodash', ['lodash']],
    ['yarn global add serve', ['serve']],
    ['bun add hono', ['hono']],
    ['bun i -d zod', ['zod']],
    ['corepack pnpm add zod', ['zod']],
    ['npm.cmd install left-pad', ['left-pad']],
    ['cd web && npm i axios && npm test', ['axios']],
    ['CI=1 npm i -g serve', ['serve']],
    ['sudo npm install -g pm2', ['pm2']],
    ['sudo -u deploy npm i -g pm2', ['pm2']],
    ['bash -c "npm i lodash"', ['lodash']],
    ['npm i lodash > install.log 2>&1', ['lodash']],
    ['npm i a; npm i b', ['a', 'b']],
  ])('%s', (command, expected) => {
    expect(pkgs(command)).toEqual(expected);
    expect(parseInstallCommands(command).every((i) => i.kind === 'add' && !i.customRegistry)).toBe(true);
  });

  it.each([
    ['npx create-next-app@latest my-app --ts', 'create-next-app', 'create-next-app'],
    ['npx -y eslint .', 'eslint', 'eslint'],
    ['npx --package=@angular/cli ng new app', '@angular/cli', 'ng'],
    ['npm exec --package=typescript -- tsc --init', 'typescript', 'tsc'],
    ['pnpm dlx create-vite@latest my-app', 'create-vite', 'create-vite'],
    ['yarn dlx -p typescript tsc --init', 'typescript', 'tsc'],
    ['bunx cowsay hi', 'cowsay', 'cowsay'],
    ['pnpx degit user/repo app', 'degit', 'degit'],
  ])('%s runs %s', (command, name, bin) => {
    const [intent] = parseInstallCommands(command);
    expect(intent).toMatchObject({ kind: 'run', bin });
    expect(intent.packages.map((p) => p.name)).toEqual([name]);
  });

  it.each([
    ['npm init vite@latest', 'create-vite'],
    ['npm create astro', 'create-astro'],
    ['yarn create react-app my-app', 'create-react-app'],
    ['pnpm create @scope/foo', '@scope/create-foo'],
    ['bun create hono', 'create-hono'],
  ])('%s runs %s', (command, name) => {
    expect(parseInstallCommands(command)[0]).toMatchObject({ kind: 'run' });
    expect(pkgs(command)).toEqual([name]);
  });

  it.each([
    'npm install', 'npm ci', 'npm run build', 'npm test', 'npm init -y', 'npm uninstall lodash', 'npm i ./local-pkg', 'npm i ../x.tgz',
    'npm i user/repo', 'npm i github:user/repo', 'npm i git+https://github.com/x/y.git', 'npm i https://example.com/x.tgz',
    'npm i $PKG', 'npm i "$(cat list.txt)"', 'npm i `cat list`', 'echo npm install lodash', 'git commit -m "npm install lodash"',
    'npx -c "eslint ."', 'pnpm install', 'yarn', 'yarn install', 'bun install', 'npm install # lodash later', 'ls node_modules/npm',
  ])('%s installs nothing by name', (command) => {
    expect(pkgs(command)).toEqual([]);
  });

  it('marks commands that use another registry', () => {
    expect(parseInstallCommands('npm i --registry https://npm.acme.dev foo')[0].customRegistry).toBe(true);
    expect(parseInstallCommands('npm i --registry=https://npm.acme.dev foo')[0].customRegistry).toBe(true);
    expect(parseInstallCommands('npm --registry https://npm.acme.dev install foo')[0].customRegistry).toBe(true);
    expect(parseInstallCommands('npm_config_registry=https://npm.acme.dev npm i foo')[0].customRegistry).toBe(true);
    expect(parseInstallCommands('npm i foo')[0].customRegistry).toBe(false);
  });
});
