// One clear violation per AI Guard rule, for comparing ESLint and Oxlint.
import express from 'express';
import { definitelyMissingPackageXyz } from 'definitely-missing-package-xyz';

const router = express.Router();
const db = { query: (_sql: string, _args?: unknown[]) => Promise.resolve([]) };
declare const req: { body: string; params: { id: string } };
declare function fetchUser(id: string): Promise<{ id: string }>;
declare function sendEmail(to: string): Promise<void>;

export const apiKey = 'sk-live-1234567890abcdefghijklmnop';

export function dynamic(code: string): unknown {
  return eval(code);
}

export function sql(id: string): Promise<unknown> {
  return db.query('SELECT * FROM users WHERE id = ' + id);
}

export function parse(): unknown {
  return JSON.parse(req.body);
}

router.get('/admin/users', (_rq: unknown, res: { json(v: unknown): void }) => {
  console.log('hit');
  res.json([]);
});

export async function emptyCatch(): Promise<void> {
  try {
    await fetchUser('1');
  } catch (e) {}
}

export async function broad(): Promise<void> {
  try {
    await fetchUser('1');
  } catch (e: any) {
    throw e;
  }
}

export async function logRethrow(): Promise<void> {
  try {
    await fetchUser('1');
  } catch (e) {
    console.error(e);
    throw e;
  }
}

export async function unusedCatch(): Promise<void> {
  try {
    await fetchUser('1');
  } catch (err) {
    throw new Error('failed');
  }
}

export function floating(): void {
  sendEmail('a@b.c');
}

export const results = ['1', '2'].map(async (id) => await fetchUser(id));

export async function loop(orders: Array<{ email: string }>): Promise<void> {
  for (const order of orders) {
    await sendEmail(order.email);
  }
}

export async function noAwait(): Promise<number> {
  return 1;
}

export async function redundant(): Promise<{ id: string }> {
  return await fetchUser('1');
}

export function deadBranch(x: number): number {
  if (true) {
    return x;
  }
  return 0;
}

export function duplicate(x: number): number {
  if (x > 1) {
    return x * 2;
  } else if (x > 1) {
    return x * 2;
  }
  return 0;
}

export function placeholder(): boolean {
  // TODO: implement
  return true;
}

export const jwtSecret = process.env.JWT_SECRET || 'secret';

export const exposed = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;

export function html(el: { innerHTML: string }, name: string): void {
  el.innerHTML = '<p>' + name + '</p>';
}

// no-invisible-unicode is exercised by a file the parity script generates, so no raw invisible character is committed.

export function testEnv(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  return false;
}

export function authz(rq: { params: { id: string } }): Promise<unknown> {
  return db.query('SELECT * FROM orders WHERE user_id = $1', [rq.params.id]);
}

export { definitelyMissingPackageXyz };
