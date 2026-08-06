// Demo: AI-generated user service with common async mistakes
// This file intentionally contains patterns that AI coding tools frequently produce.

import { db } from '../lib/database';

/**
 * Fetch all users and enrich with profile data.
 * AI generated this with async array callbacks — a classic mistake.
 */
export async function enrichUsers(userIds: string[]) {
  // ❌ AI used async callback in .map() — returns Promise[], not User[]
  const users = userIds.map(async (id) => {
    const user = await db.findUser(id);
    const profile = await db.findProfile(id);
    return { ...user, profile };
  });

  return users;
}

/**
 * Send welcome emails to new signups.
 * AI forgot to await the async fetch call.
 */
export function processSignups(emails: string[]) {
  for (const email of emails) {
    // ❌ Floating promise — fetch() called without await or catch
    fetch('https://api.email.com/send', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }
}

/**
 * Sync user data from external provider.
 * AI marked this async but never uses await.
 */
async function syncFromProvider(providerId: string) {
  // ❌ Function is async but never awaits — misleading signature
  const data = fetchProviderData(providerId);
  return data;
}

// Helpers (stubs for demo)
function fetchProviderData(id: string) {
  return { id, name: 'Provider' };
}
