/**
 * One-time login script. Run locally:
 *   cd mtproto-worker
 *   npm install
 *   npx tsx scripts/login.ts
 *
 * Enter your phone (with country code), then SMS code (and 2FA password if set).
 * Outputs MTPROTO_SESSION_STRING — copy it to your .env (locally) and Lovable secrets.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import "dotenv/config";

const apiIdRaw = process.env.MTPROTO_API_ID;
const apiHash = process.env.MTPROTO_API_HASH;

if (!apiIdRaw || !apiHash) {
  console.error("ERROR: set MTPROTO_API_ID and MTPROTO_API_HASH in .env first.");
  console.error("Get them at https://my.telegram.org → API development tools");
  process.exit(1);
}

const apiId = Number(apiIdRaw);

(async () => {
  console.log("=== MTProto session generator ===");
  console.log("This will log into your Telegram account ONE TIME.");
  console.log("It does NOT send any messages — only generates a session string.\n");

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Phone number (with country code, e.g. +79001234567): "),
    password: async () => await input.text("2FA password (leave empty if none): "),
    phoneCode: async () => await input.text("Code from Telegram: "),
    onError: (err) => console.error(err),
  });

  const sessionString = (client.session as StringSession).save();
  console.log("\n========================================");
  console.log("MTPROTO_SESSION_STRING:");
  console.log(sessionString);
  console.log("========================================\n");
  console.log("Copy this value and:");
  console.log("  1. Add it to your local mtproto-worker/.env");
  console.log("  2. Add it as a secret in Lovable Cloud (used by Railway deploy env)");

  await client.disconnect();
  process.exit(0);
})();
