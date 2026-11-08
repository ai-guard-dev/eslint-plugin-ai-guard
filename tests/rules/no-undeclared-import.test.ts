import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import {
  noUndeclaredImport,
  getPackageName,
} from '../../src/rules/security/no-undeclared-import';
import { parseJsonc } from '../../src/utils/jsonc';

// ── Fixture projects (built on disk: node_modules cannot be committed) ──────

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-guard-undeclared-'));

function write(relativePath: string, content = ''): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function dir(relativePath: string): void {
  fs.mkdirSync(path.join(root, relativePath), { recursive: true });
}

// Single app with tsconfig aliases and a hoisted (undeclared) dependency
dir('app/.git');
write('app/package.json', JSON.stringify({
  name: 'fixture-app',
  dependencies: { react: '*', '@scope/ui': '*', lodash: '*' },
  devDependencies: { vitest: '*', '@types/json-schema': '*', '@types/scope__typed': '*' },
  peerDependencies: { eslint: '*' },
  optionalDependencies: { fsevents: '*' },
  bundleDependencies: ['bundled-pkg'],
}));
write('app/tsconfig.json', `{
  // tsconfig allows comments and trailing commas
  "extends": "./config/tsconfig.base.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@components/*": ["src/components/*"],
      "~shared": ["src/shared/index.ts"], /* exact alias */
    },
  },
}`);
write('app/config/tsconfig.base.json', '{ "compilerOptions": { "paths": { "@lib/*": ["../src/lib/*"] } } }');
write('app/src/utils/format.ts', 'export {};');
write('app/node_modules/phantom-pkg/package.json', '{"name":"phantom-pkg"}');
write('app/node_modules/@hoisted/core/package.json', '{"name":"@hoisted/core"}');

// Monorepo: tooling declared once at the root
dir('mono/.git');
write('mono/package.json', JSON.stringify({ name: 'mono-root', private: true, workspaces: ['packages/*'], devDependencies: { typescript: '*', vitest: '*' } }));
write('mono/packages/web/package.json', JSON.stringify({ name: '@mono/web', dependencies: { react: '*', '@mono/ui': 'workspace:*' } }));

// A folder that is not an npm project at all
dir('loose/.git');

const appFile = path.join(root, 'app/src/index.ts');
const monoFile = path.join(root, 'mono/packages/web/src/app.tsx');
const looseFile = path.join(root, 'loose/src/script.js');

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ── Unit tests ──────────────────────────────────────────────────────────────

describe('getPackageName', () => {
  it.each([
    ['react', 'react'],
    ['react/jsx-runtime', 'react'],
    ['@scope/ui', '@scope/ui'],
    ['@scope/ui/button', '@scope/ui'],
    ['lodash/fp/map', 'lodash'],
    ['pkg?raw', 'pkg'],
  ])('%s -> %s', (spec, name) => {
    expect(getPackageName(spec)).toBe(name);
  });

  it.each([
    './local', '../up', '/abs', '@/components/x', '@@/x', '~/lib', '#internal', '$lib/stores',
    'node:fs', 'bun:test', 'virtual:pwa-register', 'astro:content', 'https://esm.sh/react', 'npm:react',
    'raw-loader!./file.txt', '@', '@scope',
  ])('%s is not a package', (spec) => {
    expect(getPackageName(spec)).toBeNull();
  });
});

describe('parseJsonc', () => {
  it('strips comments and trailing commas but keeps string contents', () => {
    expect(parseJsonc('{ // c\n "a": "http://x/*y*/", /* b */ "b": [1, 2,], }')).toEqual({ a: 'http://x/*y*/', b: [1, 2] });
  });
});

// ── Rule tests ──────────────────────────────────────────────────────────────

ruleTester.run('no-undeclared-import', noUndeclaredImport, {
  valid: [
    // Declared in every dependency field, including subpaths
    { code: 'import React from "react"; import { jsx } from "react/jsx-runtime";', filename: appFile },
    { code: 'import { Button } from "@scope/ui/button"; import map from "lodash/fp/map";', filename: appFile },
    { code: 'import { test } from "vitest"; import { Linter } from "eslint"; import "fsevents"; import b from "bundled-pkg";', filename: appFile },
    // Types-only packages
    { code: 'import schema from "json-schema"; import typed from "@scope/typed";', filename: appFile },
    // The package importing itself through its own name
    { code: 'import { x } from "fixture-app/utils";', filename: appFile },
    // Node built-ins, with and without the node: prefix
    { code: 'import fs from "fs"; import { readFile } from "node:fs/promises"; import p from "path/posix"; import "fs/promises";', filename: appFile },
    // Relative, absolute, protocol and alias specifiers are not packages
    { code: 'import a from "./a"; import b from "../b"; import c from "/abs/c";', filename: appFile },
    { code: 'import x from "@/components/x"; import y from "~/lib/y"; import z from "#internal"; import s from "$lib/stores";', filename: appFile },
    { code: 'import { registerSW } from "virtual:pwa-register"; import { getCollection } from "astro:content"; import { test } from "bun:test";', filename: appFile },
    { code: 'import css from "./styles.css?inline"; import txt from "raw-loader!./file.txt";', filename: appFile },
    // tsconfig paths (direct and through extends), baseUrl, and directory aliases
    { code: 'import Button from "@components/Button"; import shared from "~shared"; import { format } from "@lib/date";', filename: appFile },
    { code: 'import { format } from "src/utils/format"; import { fmt } from "utils/format";', filename: appFile },
    // CommonJS and dynamic forms
    { code: 'const React = require("react"); const p = require.resolve("vitest"); const m = await import("react");', filename: appFile },
    { code: 'const plugin = require(pluginName); const mod = await import(path);', filename: appFile },
    { code: 'export * from "react"; export { useState } from "react";', filename: appFile },
    // Optional dependencies loaded behind a guard
    { code: 'let fsevents; try { fsevents = require("fsevents-optional"); } catch { fsevents = null; }', filename: appFile },
    { code: 'const { default: open } = await import("open").catch(() => ({ default: null }));', filename: appFile },
    { code: 'async function load() { try { return await import("sharp"); } catch (e) { return null; } }', filename: appFile },
    { code: 'import("canvas").then((m) => use(m), () => fallback());', filename: appFile },
    // Host-provided modules via the allow option
    { code: 'import * as vscode from "vscode"; import { a } from "@internal/tools";', filename: appFile, options: [{ allow: ['vscode', '@internal/*'] }] },
    // Monorepo: root devDependencies and workspace packages
    { code: 'import ts from "typescript"; import { Card } from "@mono/ui"; import React from "react";', filename: monoFile },
    // Not an npm project, or no real file on disk
    { code: 'import anything from "whatever-package";', filename: looseFile },
    'import anything from "whatever-package";',
  ],
  invalid: [
    // Hallucinated or not-yet-installed packages
    {
      code: 'import { z } from "zod";',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'zod' } }],
    },
    {
      code: 'import { createHelpers } from "react-query-helpers-pro";',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'react-query-helpers-pro' } }],
    },
    {
      code: 'import { Dialog } from "@scope/dialogs/modal";',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: '@scope/dialogs' } }],
    },
    // Typosquat-shaped names
    {
      code: 'const express = require("expresss");',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'expresss' } }],
    },
    {
      code: 'const { stream } = await import("openai-edge-helpers");',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'openai-edge-helpers' } }],
    },
    {
      code: 'export { z } from "zodd";\nimport "left-padd";',
      filename: appFile,
      errors: [
        { messageId: 'notInstalled', data: { name: 'zodd' }, line: 1 },
        { messageId: 'notInstalled', data: { name: 'left-padd' }, line: 2 },
      ],
    },
    {
      code: 'const p = require.resolve("prettier-plugin-magic");',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'prettier-plugin-magic' } }],
    },
    // Phantom dependencies: present in node_modules only through another package
    {
      code: 'import createDebug from "phantom-pkg";',
      filename: appFile,
      errors: [{ messageId: 'phantomDependency', data: { name: 'phantom-pkg' } }],
    },
    {
      code: 'import { core } from "@hoisted/core/sub";',
      filename: appFile,
      errors: [{ messageId: 'phantomDependency', data: { name: '@hoisted/core' } }],
    },
    // A guard only counts when it can actually handle the failure
    {
      code: 'try { setup(require("sharp-pro")); } finally { done(); }',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'sharp-pro' } }],
    },
    {
      code: 'try { register(() => require("late-loaded-pkg")); } catch { noop(); }',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'late-loaded-pkg' } }],
    },
    {
      code: 'import("canvas-pro").then((m) => use(m));',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'canvas-pro' } }],
    },
    // The allow list covers only what it names
    {
      code: 'import * as vscode from "vscode"; import x from "vscode-helpers-ai";',
      filename: appFile,
      options: [{ allow: ['vscode'] }],
      errors: [{ messageId: 'notInstalled', data: { name: 'vscode-helpers-ai' } }],
    },
    // Monorepo: a dependency nobody in the chain declares
    {
      code: 'import debounce from "lodash/debounce";',
      filename: monoFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'lodash' } }],
    },
  ],
});

tsRuleTester.run('no-undeclared-import (TypeScript)', noUndeclaredImport, {
  valid: [
    { code: 'import type { JSONSchema7 } from "json-schema"; import fs = require("fs");', filename: appFile },
  ],
  invalid: [
    {
      code: 'import legacy = require("legacy-sdk-pro");',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'legacy-sdk-pro' } }],
    },
    {
      code: 'import type { Session } from "next-auth-helpers";',
      filename: appFile,
      errors: [{ messageId: 'notInstalled', data: { name: 'next-auth-helpers' } }],
    },
  ],
});
