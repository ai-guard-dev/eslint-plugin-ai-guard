// Demo: AI-generated error handling with common reliability mistakes
// These patterns appear constantly in AI-generated backend code.

import { logger } from '../lib/logger';

/**
 * Fetch user data from external API.
 * AI generated a try/catch that swallows the error completely.
 */
export async function fetchUserData(userId: string) {
  try {
    const response = await fetch(`https://api.example.com/users/${userId}`);
    return await response.json();
  } catch (e) {
    // ❌ Empty catch — error is silently swallowed
  }
}

/**
 * Process payment through Stripe.
 * AI catches broadly with `any` type.
 */
export async function processPayment(amount: number) {
  try {
    const result = await chargeCard(amount);
    return result;
  } catch (error: any) {
    // ❌ Broad exception — catch(error: any) loses type safety
    logger.error(error);
    throw error;
  }
}

/**
 * Update user profile.
 * AI generated the classic catch-log-rethrow anti-pattern.
 */
export async function updateProfile(userId: string, data: object) {
  try {
    const result = await db.update('users', userId, data);
    return result;
  } catch (err) {
    // ❌ Catch-log-rethrow — adds no context, just noise
    console.error(err);
    throw err;
  }
}

// Stubs
function chargeCard(amount: number) {
  return Promise.resolve({ success: true, amount });
}

const db = {
  update: (table: string, id: string, data: object) => Promise.resolve(data),
};
