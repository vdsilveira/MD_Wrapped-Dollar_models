import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Buffer } from 'buffer';
import { getRandomValues } from 'node:crypto';
import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import { findDeployedContract, withContractScopedTransaction } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateSeed, getSwda, getSwdaSecretKey } from './network';
import { createWallet, startUnshieldedAndDust, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

globalThis.WebSocket = WebSocket as any;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const PROOFSTATION_URL = process.env.PROOFSTATION_URL;
const PROOFSTATION_SESSION_TOKEN = process.env.PROOFSTATION_SESSION_TOKEN;

if (!PROOFSTATION_URL || !PROOFSTATION_SESSION_TOKEN) {
  console.error('\n  Set PROOFSTATION_URL and PROOFSTATION_SESSION_TOKEN in .env\n');
  process.exit(1);
}

// ─── ProofStation Integration ─────────────────────────────────────────────────

function isDustShortage(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('not enough dust') || msg.includes('insufficient funds') || msg.includes('could not balance dust');
}

async function proofStationBalanceOnly(provedTx: { serialize(): Uint8Array }): Promise<any> {
  const txBytes = provedTx.serialize();

  console.log('  Sending to ProofStation /balance-only...');
  const res = await fetch(`${PROOFSTATION_URL}/balance-only`, {
    method: 'POST',
    headers: {
      'x-session-token': PROOFSTATION_SESSION_TOKEN!,
      'Content-Type': 'application/octet-stream',
    },
    body: txBytes as unknown as ArrayBuffer,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (res.status === 429) {
      console.log('  ⏳ ProofStation rate limited, waiting 30s...');
      await new Promise((r) => setTimeout(r, 30_000));
      return proofStationBalanceOnly(provedTx);
    }
    throw new Error(`ProofStation /balance-only failed (${res.status}): ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  const balancedHex = data.txBytes ?? data.tx;
  if (!balancedHex) throw new Error(`ProofStation response missing tx data: ${JSON.stringify(Object.keys(data))}`);

  const balancedBytes = new Uint8Array(balancedHex.match(/.{2}/g).map((b: string) => parseInt(b, 16)));
  return (ledger as any).Transaction.deserialize('signature', 'proof', 'binding', balancedBytes);
}

// ─── End of ProofStation Integration ─────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'swda');

const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\nContract not compiled! Run: npm run compile\n');
  process.exit(1);
}

const Swda = await import(pathToFileURL(contractPath).href);

const witnesses = {
  wit_OwnableSK(context: any) {
    return [context.privateState, Uint8Array.from(context.privateState.secretKey)];
  },
};

const compiledContract = CompiledContract.make('swda', Swda.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

function parseEitherAddress(input: string): {
  is_left: boolean;
  left: Uint8Array;
  right: { bytes: Uint8Array };
} {
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return {
      is_left: true,
      left: Buffer.from(input, 'hex'),
      right: { bytes: new Uint8Array(32) },
    };
  }
  throw new Error(
    'Invalid input. Use a 64-character hex string (account ID).\n',
  );
}

function parseCoinPublicKey(hex: string): {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { bytes: Uint8Array };
} {
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return {
      is_left: true,
      left: { bytes: Buffer.from(hex, 'hex') },
      right: { bytes: new Uint8Array(32) },
    };
  }
  throw new Error(
    'Invalid coin public key. Expected 64 hex chars.\n',
  );
}

function recipientFromShieldedAddress(input: string, networkId: string): {
  coinPublicKey: ReturnType<typeof parseCoinPublicKey>;
  encryptionKey: Uint8Array;
  coinPublicKeyHex: string;
} {
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return {
      coinPublicKey: parseCoinPublicKey(input),
      encryptionKey: null as any,
      coinPublicKeyHex: input.toLowerCase(),
    };
  }

  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(input);
  } catch {
    throw new Error('Invalid address. Expected a Midnight bech32 shielded address or 64-char hex.');
  }

  if (parsed.type !== 'shield-addr') {
    throw new Error(`Expected a shielded address (type shield-addr), got ${parsed.type}.`);
  }

  const addr = ShieldedAddress.codec.decode(networkId, parsed);
  return {
    coinPublicKey: {
      is_left: true,
      left: { bytes: addr.coinPublicKey.data },
      right: { bytes: new Uint8Array(32) },
    },
    encryptionKey: addr.encryptionPublicKey.data,
    coinPublicKeyHex: addr.coinPublicKey.toHexString(),
  };
}

function parseShieldedCoinInfo(
  nonceHex: string,
  colorHex: string,
  valueStr: string,
): { nonce: Uint8Array; color: Uint8Array; value: bigint } {
  if (!/^[0-9a-fA-F]{64}$/.test(nonceHex)) throw new Error('Nonce must be 64 hex chars');
  if (!/^[0-9a-fA-F]{64}$/.test(colorHex)) throw new Error('Color must be 64 hex chars');
  return {
    nonce: Buffer.from(nonceHex, 'hex'),
    color: Buffer.from(colorHex, 'hex'),
    value: parseAmount(valueStr),
  };
}

const WDAS_DECIMALS = 6;
const TNIGHT_DECIMALS = 18;
function parseAmount(input: string, decimals: number = WDAS_DECIMALS): bigint {
  const divisor = 10n ** BigInt(decimals);
  const cleaned = input.trim().replace(/,/g, '');
  const parts = cleaned.split('.');
  if (parts.length === 1) {
    return BigInt(parts[0]) * divisor;
  }
  if (parts.length === 2) {
    const whole = parts[0];
    let frac = parts[1];
    if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`);
    frac = frac.padEnd(decimals, '0');
    return BigInt(whole + frac);
  }
  throw new Error('Invalid amount. Use decimal format (e.g. 100 or 0.05).');
}
function fmt(value: bigint, decimals: number = WDAS_DECIMALS): string {
  const divisor = 10n ** BigInt(decimals);
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const whole = abs / divisor;
  const frac = abs % divisor;
  return `${sign}${whole.toLocaleString()}.${frac.toString().padStart(decimals, '0')}`;
}

function formatEither(v: { is_left: boolean; left: any; right: { bytes: Uint8Array } }): string {
  if (v.is_left) {
    if (v.left instanceof Uint8Array) {
      return Buffer.from(v.left).toString('hex');
    }
    if (v.left && v.left.bytes instanceof Uint8Array) {
      return Buffer.from(v.left.bytes).toString('hex');
    }
    return String(v.left);
  }
  return `ContractAddress(${Buffer.from(v.right.bytes).toString('hex')})`;
}

async function createProviders(walletCtx: WalletContext) {
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const coinPubKeyHex = walletCtx.shieldedSecretKeys.coinPublicKey;
  const encPubKeyHex = walletCtx.shieldedSecretKeys.encryptionPublicKey;
  const coinPubKey = ShieldedCoinPublicKey.fromHexString(coinPubKeyHex);
  const encPubKey = ShieldedEncryptionPublicKey.fromHexString(encPubKeyHex);

  const walletProvider = {
    getCoinPublicKey: () => coinPubKeyHex,
    getEncryptionPublicKey: () => encPubKeyHex,
    async balanceTx(tx: any, ttl?: Date) {
      const opts = { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) };

      // Try normal balance with DUST
      try {
        const recipe = await walletCtx.wallet.balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
          { ...opts, tokenKindsToBalance: 'all' },
        );
        const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
          walletCtx.unshieldedKeystore.signData(payload),
        );
        return walletCtx.wallet.finalizeRecipe(signedRecipe);
      } catch (e) {
        if (!isDustShortage(e)) throw e;
      }

      // DUST shortage — local proof + ProofStation /balance-only
      console.log('  DUST unavailable — using local proof + ProofStation...');
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ...opts, tokenKindsToBalance: ['unshielded', 'shielded'] },
      );
      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );
      const finalizedTx = await walletCtx.wallet.finalizeRecipe(signedRecipe);
      return proofStationBalanceOnly(finalizedTx);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  const privateStateProvider = levelPrivateStateProvider({
    privateStateStoreName: 'swda-state',
    accountId,
    privateStoragePasswordProvider: () => privateStatePassword,
  });

  // Pre-seed private state with owner secretKey from deploy (if available)
  const savedSecretKeyHex = getSwdaSecretKey();
  const deploymentInfo = getSwda();
  if (savedSecretKeyHex && deploymentInfo) {
    const secretKeyBytes = new Uint8Array(Buffer.from(savedSecretKeyHex, 'hex'));
    (privateStateProvider as any).setContractAddress(deploymentInfo.address);
    await (privateStateProvider as any).set('swda-state', { secretKey: secretKeyBytes });
    console.log('  Loaded owner secretKey from .midnight-state.json');
  } else {
    console.log('  ⚠ No owner secretKey found in .midnight-state.json — owner-only ops (mint) may fail');
  }

  return {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
    encryptionPublicKeyResolver: async (
      coinPublicKey: unknown,
    ): Promise<Uint8Array> => {
      const hex = (() => {
        if (typeof coinPublicKey === 'string') return coinPublicKey.toLowerCase();
        if (coinPublicKey instanceof Uint8Array) return Buffer.from(coinPublicKey).toString('hex').toLowerCase();
        const obj = coinPublicKey as Record<string, unknown>;
        if (obj.bytes instanceof Uint8Array) return Buffer.from(obj.bytes).toString('hex').toLowerCase();
        if (obj.data instanceof Uint8Array) return Buffer.from(obj.data).toString('hex').toLowerCase();
        throw new Error(`Cannot parse coinPublicKey: ${typeof coinPublicKey}`);
      })();

      if (hex === coinPubKeyHex.toLowerCase()) {
        return encPubKey.data;
      }

      throw new Error(
        `Unknown encryption key for ${hex}. Only own wallet key is resolved.`,
      );
    },
  };
}

async function sendTNightWithProofStation(
  walletCtx: WalletContext,
  recipientStr: string,
  amountStr: string,
): Promise<void> {
  const amount = parseAmount(amountStr, TNIGHT_DECIMALS);
  const parsed = MidnightBech32m.parse(recipientStr);
  const receiverAddress = parsed.decode(UnshieldedAddress, network);

  const outputs: any[] = [
    {
      type: 'unshielded',
      outputs: [
        {
          type: unshieldedToken().raw,
          receiverAddress,
          amount,
        },
      ],
    },
  ];

  // Try normal transfer
  try {
    const recipe = await walletCtx.wallet.transferTransaction(
      outputs,
      {
        shieldedSecretKeys: walletCtx.shieldedSecretKeys,
        dustSecretKey: walletCtx.dustSecretKey,
      },
      {
        ttl: new Date(Date.now() + 30 * 60 * 1000),
        payFees: true,
      },
    );
    const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
      walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalizedTx = await walletCtx.wallet.finalizeRecipe(signedRecipe);
    const txId = await walletCtx.wallet.submitTransaction(finalizedTx);
    console.log(`\n  ✅ tNIGHT sent! TxID: ${txId}\n`);
    return;
  } catch (e) {
    if (!isDustShortage(e)) throw e;
  }

  // DUST shortage — use wallet provider's balanceTx with ProofStation
  // Build an unshielded transfer via the wallet provider (which has ProofStation fallback)
  console.log('  DUST unavailable — using ProofStation for fees...');
  const recipe = await walletCtx.wallet.transferTransaction(
    outputs,
    {
      shieldedSecretKeys: walletCtx.shieldedSecretKeys,
      dustSecretKey: walletCtx.dustSecretKey,
    },
    {
      ttl: new Date(Date.now() + 30 * 60 * 1000),
      payFees: true,
    },
  );
  const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
    walletCtx.unshieldedKeystore.signData(payload),
  );
  const finalizedTx = await walletCtx.wallet.finalizeRecipe(signedRecipe);
  const balancedTx = await proofStationBalanceOnly(finalizedTx);
  const txId = await walletCtx.wallet.submitTransaction(balancedTx);
  console.log(`\n  ✅ tNIGHT sent! TxID: ${txId}\n`);
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║       SWDA CLI (via ProofStation)                           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  const deployment = getSwda();
  if (!deployment) {
    console.error(`No swda deployment on file for network ${network}. Run \`npm run deploy:proofstation\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Network: ${network}\n`);

  const levelDbPath = path.resolve(process.cwd(), 'midnight-level-db');
  try { fs.rmSync(path.join(levelDbPath, 'LOCK'), { force: true }); } catch {}

  try {
    const seed = SEED;

    console.log('  Creating wallet (shielded sync disabled)...');
    const walletCtx = await createWallet({ network, networkConfig, seed, skipStart: true });

    const walletAddress = walletCtx.unshieldedKeystore.getBech32Address();
    console.log(`  Wallet Address: ${walletAddress}\n`);

    console.log('  Starting unshielded + dust wallets...');
    await startUnshieldedAndDust(walletCtx.wallet, walletCtx.dustSecretKey);

    const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
    if (restoredCount > 0) {
      console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state`);
    }

    console.log('  Syncing unshielded wallet...\n');
    const syncStart = Date.now();
    const syncInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - syncStart) / 1000);
      process.stdout.write(`\r  Syncing... (${elapsed}s elapsed)   `);
    }, 5000);

    try {
      await Promise.race([
        (walletCtx.wallet as any).unshielded.waitForSyncedState(),
        new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error('Unshielded sync timeout')), 300_000),
        ),
      ]);
      clearInterval(syncInterval);
      process.stdout.write('\r  ✓ Unshielded synced.                              \n');
    } catch {
      clearInterval(syncInterval);
      process.stdout.write('\r  ⚠ Unshielded sync timeout — continuing with polling.\n');
    }

    let tNightBalance = 0n;
    try {
      const s = await Rx.firstValueFrom(walletCtx.wallet.state());
      tNightBalance = s.unshielded?.balances?.[unshieldedToken().raw] ?? 0n;
    } catch {}
    await persistWalletState(network, walletCtx);
    console.log(`  tNIGHT: ${tNightBalance.toLocaleString()}\n`);

    if (tNightBalance === 0n && network !== 'undeployed' && networkConfig.faucet) {
      const address = walletCtx.unshieldedKeystore.getBech32Address();
      console.log('  Wallet has no tNight. Fund it from the faucet:');
      console.log(`     ${networkConfig.faucet}`);
      console.log(`     Wallet address: ${address}\n`);
    }

    console.log('  Connecting to contract...');
    const providers = await createProviders(walletCtx);

    console.log('  Calling findDeployedContract (timeout 120s)...');
    const deployed: any = await Promise.race([
      findDeployedContract(providers, {
        compiledContract: compiledContract as any,
        contractAddress: deployment.address,
        privateStateId: 'swda-state',
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('findDeployedContract timed out after 120s')), 120_000),
      ),
    ]);

    console.log('  Connected!\n');

    function unwrap(v: unknown): Uint8Array {
      if (v instanceof Uint8Array) return v;
      if (v && typeof v === 'object' && 'bytes' in (v as any) && (v as any).bytes instanceof Uint8Array) return (v as any).bytes;
      throw new Error(`Expected Uint8Array or {bytes}, got ${typeof v}`);
    }
    const call = (method: string, ...args: any[]) =>
      (deployed.callTx as any)[method](...args).then((r: any) => r.private.result);

    let running = true;
    while (running) {
      console.log('─── Menu ───────────────────────────────────────────────────────');
      console.log('  1. My Account ID');
      console.log('  2. Token Info');
      console.log('  3. Token Color');
      console.log('  4. Mint (owner only)');
      console.log('  5. Transfer (shielded, no receipt)');
      console.log('  6. Transfer with Receipt');
      console.log('  7. Get Receipt (by ID)');
      console.log('  8. Wallet Balance');
      console.log('  9. My WDAS Balance');
      console.log(' 10. Send tNIGHT');
      console.log(' 11. Exit\n');

      const choice = await rl.question('  Your choice: ');

      switch (choice.trim()) {
        case '1': {
          const s = await Rx.firstValueFrom(walletCtx.wallet.state());
          const bech32Addr = ShieldedAddress.codec.encode(network, s.shielded.address).toString();
          console.log(`\n  Your Shielded Address: ${bech32Addr}\n`);
          console.log('  Share this address to receive shielded tokens.\n');
          break;
        }

        case '2': {
          console.log('\n  Fetching token info...');
          try {
            const info: any = await call('tokenInfo');
            console.log(`\n  Name:          ${info.name}`);
            console.log(`  Symbol:        ${info.symbol}`);
            console.log(`  Decimals:      ${info.decimals.toString()}`);
            console.log(`  Total Supply:  ${fmt(info.totalSupply)}`);
            console.log(`  Owner:         ${formatEither(info.owner)}`);
            console.log(`  Is Paused:     ${info.isPaused}`);
            console.log();
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '3': {
          console.log('\n  Fetching token color...');
          try {
            const result = await call('tokenColor');
            const hex = Buffer.from(unwrap(result)).toString('hex');
            console.log(`\n  Token Color:  ${hex}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '4': {
          const recipientStr = await rl.question('  Recipient shielded address (shield1...) or coin public key (64 hex): ');
          const valueStr = await rl.question('  Amount (e.g. 100 or 0.05): ');
          const value = parseAmount(valueStr);

          if (value > BigInt('18446744073709551615')) {
            console.log('\n  Amount too large. Shielded tokens cap at Uint<64> (max 18,446,744,073,709,551,615).\n');
            break;
          }

          const recipient = recipientFromShieldedAddress(recipientStr, network);
          const encMappings = new Map<string, string>();
          if (recipient.encryptionKey) {
            encMappings.set(
              recipient.coinPublicKeyHex.toLowerCase(),
              Buffer.from(recipient.encryptionKey).toString('hex'),
            );
          }

          const nonce = getRandomValues(new Uint8Array(32));
          console.log('\n  Submitting mint...');
          try {
            const result = await withContractScopedTransaction(
              providers as any,
              async (txCtx) => {
                await (deployed.callTx as any).mint(txCtx, recipient.coinPublicKey, value, nonce);
              },
              { additionalCoinEncPublicKeyMappings: encMappings },
            );
            const coin = (result as any).private.result;
            console.log(`\n  ✅ Mint submitted!`);
            console.log(`\n  ── ShieldedCoinInfo ──────────────────────────────────`);
            console.log(`  Nonce:  ${Buffer.from(unwrap(coin.nonce)).toString('hex')}`);
            console.log(`  Color:  ${Buffer.from(unwrap(coin.color)).toString('hex')}`);
            console.log(`  Value:  ${fmt(coin.value)}`);
            console.log('  ───────────────────────────────────────────────────────');
            console.log('\n  ⚠  SAVE THIS INFO. It is the ONLY copy of the minted coin.\n');
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '5': {
          console.log('\n  ── Transfer (shielded, no receipt) ────────────────────\n');
          const nonceHex = await rl.question('  Your coin nonce (64 hex chars): ');
          const colorHex = await rl.question('  Your coin color (64 hex chars): ');
          const valueStr = await rl.question('  Your coin value (e.g. 100 or 0.05): ');
          const amountStr = await rl.question('  Amount to transfer (e.g. 100 or 0.05): ');
          const refundHex = await rl.question('  Refund to coin public key (64 hex chars, your own key): ');
          const recipientStr = await rl.question('  Recipient shielded address (shield1...) or hex: ');

          const recipient = recipientFromShieldedAddress(recipientStr, network);
          const encMappings = new Map<string, string>();
          if (recipient.encryptionKey) {
            encMappings.set(
              recipient.coinPublicKeyHex.toLowerCase(),
              Buffer.from(recipient.encryptionKey).toString('hex'),
            );
          }

          const amount = parseAmount(amountStr);
          const coin = parseShieldedCoinInfo(nonceHex, colorHex, valueStr);
          const mintNonce = getRandomValues(new Uint8Array(32));

          console.log('\n  Submitting transfer...');
          try {
            const result = await withContractScopedTransaction(
              providers as any,
              async (txCtx) => {
                await (deployed.callTx as any).transfer(
                  txCtx,
                  coin,
                  amount,
                  parseCoinPublicKey(refundHex),
                  recipient.coinPublicKey,
                  mintNonce,
                );
              },
              { additionalCoinEncPublicKeyMappings: encMappings },
            );
            const r = (result as any).private.result;
            console.log(`\n  ✅ Transfer submitted!`);
            if (r.change.is_some) {
              const change = r.change.value;
              console.log(`\n  ── Change Coin ───────────────────────────────────────`);
              console.log(`  Nonce:  ${Buffer.from(unwrap(change.nonce)).toString('hex')}`);
              console.log(`  Color:  ${Buffer.from(unwrap(change.color)).toString('hex')}`);
              console.log(`  Value:  ${fmt(change.value)}`);
              console.log('  ───────────────────────────────────────────────────────');
            } else {
              console.log('  No change (full coin consumed).\n');
            }
            console.log(`\n  ── Minted Coin (for recipient) ────────────────────────`);
            console.log(`  Nonce:  ${Buffer.from(unwrap(r.minted.nonce)).toString('hex')}`);
            console.log(`  Color:  ${Buffer.from(unwrap(r.minted.color)).toString('hex')}`);
            console.log(`  Value:  ${fmt(r.minted.value)}`);
            console.log('  ───────────────────────────────────────────────────────');
            console.log('\n  ⚠  Forward the minted coin info to the recipient out-of-band.\n');
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '6': {
          console.log('\n  ── Transfer with Receipt ──────────────────────────────\n');
          const nonceHex2 = await rl.question('  Your coin nonce (64 hex chars): ');
          const colorHex2 = await rl.question('  Your coin color (64 hex chars): ');
          const valueStr2 = await rl.question('  Your coin value (e.g. 100 or 0.05): ');
          const amountStr2 = await rl.question('  Amount to transfer (e.g. 100 or 0.05): ');
          const refundHex2 = await rl.question('  Refund to coin public key (64 hex chars, your own key): ');
          const recipientStr2 = await rl.question('  Recipient shielded address (shield1...) or hex: ');
          const requestNonceHex = await rl.question('  Request nonce from server (64 hex chars): ');

          const recipient2 = recipientFromShieldedAddress(recipientStr2, network);
          const encMappings = new Map<string, string>();
          if (recipient2.encryptionKey) {
            encMappings.set(
              recipient2.coinPublicKeyHex.toLowerCase(),
              Buffer.from(recipient2.encryptionKey).toString('hex'),
            );
          }

          const amount2 = parseAmount(amountStr2);
          const coin2 = parseShieldedCoinInfo(nonceHex2, colorHex2, valueStr2);
          const mintNonce2 = getRandomValues(new Uint8Array(32));

          console.log('\n  Submitting transfer with receipt...');
          try {
            const result = await withContractScopedTransaction(
              providers as any,
              async (txCtx) => {
                await (deployed.callTx as any).transferWithReceipt(
                  txCtx,
                  coin2,
                  amount2,
                  parseCoinPublicKey(refundHex2),
                  recipient2.coinPublicKey,
                  mintNonce2,
                  Buffer.from(requestNonceHex, 'hex'),
                );
              },
              { additionalCoinEncPublicKeyMappings: encMappings },
            );
            const r = (result as any).private.result;
            console.log(`\n  ✅ Transfer with Receipt submitted!`);
            console.log(`  Receipt ID: ${r.receiptId.toString()}\n`);
            if (r.change.is_some) {
              const change = r.change.value;
              console.log(`  ── Change Coin ───────────────────────────────────────`);
              console.log(`  Nonce:  ${Buffer.from(unwrap(change.nonce)).toString('hex')}`);
              console.log(`  Color:  ${Buffer.from(unwrap(change.color)).toString('hex')}`);
              console.log(`  Value:  ${fmt(change.value)}`);
              console.log('  ───────────────────────────────────────────────────────');
            } else {
              console.log('  No change (full coin consumed).');
            }
            console.log(`\n  ── Minted Coin (for recipient) ────────────────────────`);
            console.log(`  Nonce:  ${Buffer.from(unwrap(r.minted.nonce)).toString('hex')}`);
            console.log(`  Color:  ${Buffer.from(unwrap(r.minted.color)).toString('hex')}`);
            console.log(`  Value:  ${fmt(r.minted.value)}`);
            console.log('  ───────────────────────────────────────────────────────');
            console.log('\n  ⚠  Forward the minted coin info + receipt ID to the recipient.\n');
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '7': {
          const idStr = await rl.question('  Receipt ID: ');
          const id = BigInt(idStr);
          console.log('\n  Fetching receipt...');
          try {
            const receipt: any = await call('receipt', id);
            if (!receipt) {
              console.log(`\n  Receipt #${idStr} not found.\n`);
            } else {
              console.log(`\n  ── Receipt #${idStr} ────────────────────────────────────`);
              console.log(`  To:           ${formatEither(receipt.to)}`);
              console.log(`  Amount:       ${receipt.amount.toString()}`);
              console.log(`  RequestNonce: ${Buffer.from(unwrap(receipt.requestNonce)).toString('hex')}`);
              console.log('  ───────────────────────────────────────────────────────\n');
            }
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '8': {
          console.log('\n  Checking balance...');
          try {
            const s = await Rx.firstValueFrom(walletCtx.wallet.state());
            const currentTNight = s.unshielded?.balances?.[unshieldedToken().raw] ?? 0n;
            console.log(`\n  tNIGHT: ${currentTNight.toLocaleString()}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '9': {
          console.log('\n  Checking SWDA balance...');
          try {
            const tokenColorResult = await call('tokenColor');
            const colorHex = Buffer.from(unwrap(tokenColorResult)).toString('hex');
            const s = await Rx.firstValueFrom(walletCtx.wallet.state());
            const wdasBalance = s.shielded?.balances?.[colorHex] ?? 0n;
            console.log(`\n  SWDA Balance: ${fmt(wdasBalance)}\n`);
            if (wdasBalance === 0n) {
              console.log('  (Shielded wallet may not be fully synced yet — balance is best-effort)\n');
            }
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '10': {
          const recipientStr = await rl.question('  Recipient unshielded address (mn_addr_...): ');
          const amountStr = await rl.question('  Amount (tNIGHT, e.g. 5 or 0.1): ');

          console.log('\n  Sending tNIGHT...');
          try {
            await sendTNightWithProofStation(walletCtx, recipientStr, amountStr);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '11':
          running = false;
          console.log('\n  Goodbye!\n');
          break;

        default:
          console.log('\n  Invalid choice. Please enter 1-11.\n');
      }
    }

    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
