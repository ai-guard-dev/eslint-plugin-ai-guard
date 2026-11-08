import { ruleTester, tsRuleTester } from '../helpers/rule-tester';
import { noPlaceholderImplementation } from '../../src/rules/ai-patterns/no-placeholder-implementation';

const jsx = { languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } };

ruleTester.run('no-placeholder-implementation', noPlaceholderImplementation, {
  valid: [
    // ── Comments that look like elisions but are prose or labels ──
    '// The rest of the code in this module assumes a connected client.\nconnect();',
    'const { id, ...rest } = props; // ...rest goes to the underlying input\nrender(rest);',
    'const { a, ...others } = props;\n// ...other properties are forwarded to the DOM\nforward(others);',
    'class Repo {\n  // Other methods\n  find() { return db.find(); }\n}',
    'function f() {\n  // Rest of the implementation\n  return compute();\n}',
    'retry(3); // same as before\nrun();',
    // JSDoc examples elide on purpose
    '/**\n * @example\n * const client = create();\n * // ... rest of the code\n */\nexport function create() { return new Client(); }',
    // Tool directive comments
    '// prettier-ignore\nconst matrix = [1,0,0];',
    // Elision in documentation-style files
    { code: 'function demo() {\n  // ... existing code\n}', filename: 'examples/basic.js' },

    // ── Functions that are intentionally empty or trivial ──
    'function noop() {}',
    'const onError = () => { /* default implementation: no-op */ };',
    'function isEnabled() { return false; }',
    // A TODO next to real work is a note, not a stub
    'function save(user) {\n  // TODO: add retry with backoff\n  return db.save(user);\n}',
    'async function load() {\n  // TODO: cache this\n  const rows = await db.query(sql);\n  return rows;\n}',

    // ── Not-implemented throws that are real designs ──
    'class BaseRepository { find() { throw new Error("Not implemented"); } }',
    'class StorageBase { write() { throw new Error("not implemented"); } }',
    'class Shape { area() { throw new Error("Method must be implemented by subclass"); } }',
    'class Shape { area() { throw new Error("Not implemented: override in subclass"); } }',
    'function parse(type, text) { if (type === "xml") throw new Error("Not implemented"); return JSON.parse(text); }',
    // Plain-JS abstract methods (the shape of ESLint's own token Cursor class)
    'module.exports = class Cursor {\n  /**\n   * Moves this cursor to the next token.\n   * @abstract\n   */\n  moveNext() {\n    throw new Error("Not implemented.");\n  }\n};',
    '/** @abstract */\nclass Transport { send() { throw new Error("Not implemented"); } }',
    'class Shape { area() { throw new Error("Not implemented"); } }\nclass Circle extends Shape { area() { return 3.14; } }',
    'function fail() { throw new Error("Invalid state"); }',

    // ── Mock-looking data that is not served ──
    'const mockMode = { enabled: true };\nif (mockMode.enabled) enableMocks();',
    'const sampleQuestions = ["What is AI Guard?"];\nexport function getQuestions() { return sampleQuestions; }',
    'const mockUsers = [];\nexport function getUsers() { return mockUsers; }',
    'const users = [{ id: 1 }];\nexport function getUsers() { return users; }',

    // ── Non-production files ──
    { code: 'const mockUsers = [{ id: 1 }];\nexport const handler = () => mockUsers;', filename: 'src/mocks/handlers.ts' },
    { code: 'const fakeUser = { id: 1 };\nexport function getUser() { return fakeUser; }', filename: 'src/api.test.ts' },
    { code: 'export function a() { throw new Error("Not implemented"); }', filename: 'tests/helpers.js' },
    { code: 'it("works", () => {\n  // TODO\n});', filename: 'src/__tests__/a.js' },
    { code: 'const dummyProducts = [{ id: 1 }];\nexport const Default = () => dummyProducts;', filename: 'src/Button.stories.jsx' },
  ],
  invalid: [
    // ── Elided code ──
    {
      code: 'function handler(req) {\n  // ... existing code ...\n  audit(req);\n}',
      errors: [{ messageId: 'elidedCode', data: { comment: '... existing code ...' }, line: 2 }],
    },
    {
      code: 'export function setup() {\n  init();\n}\n// ... rest of the code remains the same',
      errors: [{ messageId: 'elidedCode', line: 4 }],
    },
    {
      code: 'const App = () => (\n  <div>\n    <Header />\n    {/* ... rest of the JSX */}\n  </div>\n);',
      ...jsx,
      errors: [{ messageId: 'elidedCode', line: 4 }],
    },
    {
      code: 'class Service {\n  start() { return 1; }\n  // other methods unchanged\n  stop() { return 0; }\n}',
      errors: [{ messageId: 'elidedCode', line: 3 }],
    },
    {
      code: 'function setup() {\n  init();\n  // rest of the implementation\n}',
      errors: [{ messageId: 'elidedCode', line: 3 }],
    },
    {
      code: 'function render() {\n  draw();\n  /* (unchanged) */\n}',
      errors: [{ messageId: 'elidedCode' }],
    },
    {
      code: 'export function route(app) {\n  // your code here\n}',
      errors: [{ messageId: 'elidedCode', data: { comment: 'your code here' } }],
    },
    // Tests lose cases to elision too
    {
      code: 'describe("cart", () => {\n  it("adds", () => add());\n  // ... other tests unchanged\n});',
      filename: 'src/cart.test.js',
      errors: [{ messageId: 'elidedCode' }],
    },

    // ── Stub bodies ──
    {
      code: 'export async function getUser(id) {\n  // TODO: implement database lookup\n  return null;\n}',
      errors: [{ messageId: 'stubBody', data: { name: 'getUser', what: 'only returns `null`', comment: 'TODO: implement database lookup' }, line: 2 }],
    },
    {
      code: 'const handleSubmit = () => {\n  // TODO: wire up the API\n};',
      errors: [{ messageId: 'stubBody', data: { name: 'handleSubmit', what: 'is empty', comment: 'TODO: wire up the API' } }],
    },
    {
      code: 'function verifyToken(token) {\n  // TODO: verify the signature\n  return true;\n}',
      errors: [{ messageId: 'stubBody', data: { name: 'verifyToken', what: 'only returns `true`', comment: 'TODO: verify the signature' } }],
    },
    {
      code: 'function sendEmail(to) {\n  console.log("Sending email to", to);\n  // TODO: integrate email provider\n}',
      errors: [{ messageId: 'stubBody', data: { name: 'sendEmail', what: 'only logs', comment: 'TODO: integrate email provider' } }],
    },
    {
      code: 'const api = {\n  fetchOrders() {\n    // placeholder until the backend exists\n    return Promise.resolve([]);\n  },\n};',
      errors: [{ messageId: 'stubBody', data: { name: 'fetchOrders', what: 'only returns `Promise.resolve()`', comment: 'placeholder until the backend exists' } }],
    },
    {
      code: 'export default function SettingsPage() {\n  // FIXME: build the settings form\n  return null;\n}',
      errors: [{ messageId: 'stubBody', data: { name: 'SettingsPage', what: 'only returns `null`', comment: 'FIXME: build the settings form' } }],
    },

    // ── Not-implemented throws ──
    {
      code: 'export function exportCsv(rows) {\n  throw new Error("Not implemented yet");\n}',
      errors: [{ messageId: 'notImplemented', data: { name: 'exportCsv', thrown: "Error('Not implemented yet')" }, line: 2 }],
    },
    {
      code: 'const migrate = async () => { throw new NotImplementedError(); };',
      errors: [{ messageId: 'notImplemented', data: { name: 'migrate', thrown: 'NotImplementedError()' } }],
    },
    {
      code: 'class Billing { refund(id) { throw new Error(`TODO: refund ${id}`); } }',
      errors: [{ messageId: 'notImplemented', data: { name: 'refund', thrown: "Error('TODO: refund ${...}')" } }],
    },

    // ── Mock data served from production code ──
    {
      code: 'const mockUsers = [{ id: 1, name: "Alice" }];\nexport async function getUsers() {\n  return mockUsers;\n}',
      errors: [{ messageId: 'mockData', data: { name: 'mockUsers' }, line: 1 }],
    },
    {
      code: 'const MOCK_ORDERS = [{ id: 1, total: 20 }];\napp.get("/orders", (req, res) => res.json(MOCK_ORDERS));',
      errors: [{ messageId: 'mockData', data: { name: 'MOCK_ORDERS' } }],
    },
    {
      code: 'const fakeStats = { revenue: 1000 };\nexport const GET = () => Response.json(fakeStats);',
      errors: [{ messageId: 'mockData', data: { name: 'fakeStats' } }],
    },
    {
      code: 'const dummyProducts = [{ id: 1 }];\nfunction ProductList() {\n  const [products] = useState(dummyProducts);\n  return products;\n}',
      errors: [{ messageId: 'mockData', data: { name: 'dummyProducts' } }],
    },
    {
      code: 'const mockUsers = [{ id: 1, active: true }];\nexport const getActiveUsers = () => mockUsers.filter((u) => u.active);',
      errors: [{ messageId: 'mockData', data: { name: 'mockUsers' } }],
    },
    {
      code: 'const hardcodedPlans = [{ id: "pro" }];\nexport async function listPlans() {\n  return { data: hardcodedPlans };\n}',
      errors: [{ messageId: 'mockData', data: { name: 'hardcodedPlans' } }],
    },
  ],
});

tsRuleTester.run('no-placeholder-implementation (TypeScript)', noPlaceholderImplementation, {
  valid: [
    'abstract class Shape { area(): number { throw new Error("Not implemented"); } }',
    // Hints inside type declarations (create-t3-app next-auth template): no runtime code is missing
    `declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      // ...other properties
    };
  }
}`,
    `type Props = {
  id: string;
  // ...other props
};`,
    'function f(): void {\n  // TODO: tighten the types\n  work();\n}',
  ],
  invalid: [
    // The same comment in a runtime object literal is an elision
    {
      code: `const config = {
  name: "app",
  // ...other properties
};`,
      errors: [{ messageId: 'elidedCode', line: 3 }],
    },
    {
      code: 'class PaymentService implements Gateway {\n  charge(amount: number): Promise<void> {\n    throw new Error("Method not implemented.");\n  }\n}',
      errors: [{ messageId: 'notImplemented', data: { name: 'charge', thrown: "Error('Method not implemented.')" } }],
    },
    {
      code: 'export async function getInvoices(): Promise<Invoice[]> {\n  // TODO: query Stripe\n  return [] as Invoice[];\n}',
      errors: [{ messageId: 'stubBody', data: { name: 'getInvoices', what: 'only returns `[]`', comment: 'TODO: query Stripe' } }],
    },
  ],
});
