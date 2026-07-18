/**
 * Derive all 3 wallet addresses (shielded, unshielded, dust) from the
 * MIDNIGHT_WALLET_SEED in .env and print them alongside the expected Lace
 * addresses for visual comparison.
 *
 * Usage:
 *   npx tsx scripts/derive-wallets.ts
 */
import 'dotenv/config';
import * as crypto from 'crypto';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import {
  DustAddress,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

const NETWORK = process.argv[2] === '--network' && process.argv[3] ? process.argv[3] : 'preview';
setNetworkId(NETWORK);
const networkId = getNetworkId();

// ── Seed ──────────────────────────────────────────────────────────
const raw = process.env.MIDNIGHT_WALLET_SEED;
if (!raw) {
  console.error('MIDNIGHT_WALLET_SEED not set in .env');
  process.exit(1);
}
const seedHex = raw.includes(' ')
  ? crypto.pbkdf2Sync(raw, 'mnemonic', 2048, 64, 'sha512').toString('hex')
  : raw;
const seed = Buffer.from(seedHex, 'hex');

// ── HD derivation (account 0, index 0) ────────────────────────────
const hdResult = HDWallet.fromSeed(seed);
if (hdResult.type !== 'seedOk') {
  console.error('HDWallet.fromSeed failed:', hdResult.error);
  process.exit(1);
}
const derived = hdResult.hdWallet
  .selectAccount(0)
  .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
  .deriveKeysAt(0);
if (derived.type !== 'keysDerived') {
  console.error('Key derivation failed');
  process.exit(1);
}
const keys = derived.keys;
hdResult.hdWallet.clear();

// ── 1. Shielded address ───────────────────────────────────────────
const zswap = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
const shieldedAddr = ShieldedAddress.codec.encode(networkId, new ShieldedAddress(
  ShieldedCoinPublicKey.fromHexString(zswap.coinPublicKey),
  ShieldedEncryptionPublicKey.fromHexString(zswap.encryptionPublicKey),
)).asString();

// ── 2. Unshielded address ─────────────────────────────────────────
const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);
const pk = PublicKey.fromKeyStore(unshieldedKeystore);
const unshieldedAddr = pk.address;

// ── 3. Dust address ───────────────────────────────────────────────
const dustKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
const dustAddr = DustAddress.encodePublicKey(networkId, dustKey.publicKey);

// ── Print ─────────────────────────────────────────────────────────
console.log(`\nNetwork: ${NETWORK}`);
console.log('Seed hex:', seedHex);
console.log('');
console.log('Derived addresses (compare with Lace):');
console.log('');
console.log(`  Shielded  → ${shieldedAddr}`);
console.log(`  Unshielded → ${unshieldedAddr}`);
console.log(`  Dust      → ${dustAddr}`);
console.log('');
console.log('Expected (from Lace):');
console.log(`  Shielded  → mn_shield-addr_preview1gfzlxcrk44sya5nq03zlnm6wg2wpty0nqky9p83kf8q6jfn47wa26vrd0lcyqp2gfpwr09cz252rtn6arss8lgkjlt2yrrpku4qzhkglr4egf`);
console.log(`  Unshielded → mn_addr_preview1g0egxuyl9t2f027yp2asgz6sdgcff7fmmzfwymrkxelsm366gm6s2tcxqx`);
console.log(`  Dust      → mn_dust_preview1ww2xjj724p0vme8yzduf3g7vnyrf92qjd6qdzanjcm8egjlzqwz3c3k73g9`);
