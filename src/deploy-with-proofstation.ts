import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveNetwork, getOrCreateSeed, saveSwda, saveSwdaSecretKey } from './network';
import { createWallet, startUnshieldedAndDust, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { Buffer } from 'buffer';
import { getRandomValues } from 'node:crypto';
import * as ledger from '@midnight-ntwrk/ledger-v8';


import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { persistentHash, CompactTypeVector, Bytes32Descriptor } from '@midnight-ntwrk/compact-runtime';
import { ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnight-ntwrk/wallet-sdk-address-format';

globalThis.WebSocket = WebSocket;

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

/**
 * Call ProofStation /balance-only — sends a proved transaction,
 * receives back a DUST-sponsored transaction.
 */
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
    throw new Error(`ProofStation /balance-only failed (${res.status}): ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  console.log(`  ProofStation txHash: ${data.txHash}`);
  console.log(`  Dust cost: ${JSON.stringify(data.dustCost)}`);
  console.log(`  Contract addresses: ${JSON.stringify(data.contractAddresses)}`);
  console.log(`  Expires at: ${data.expiresAt}`);

  const balancedHex = data.txBytes ?? data.tx;
  if (!balancedHex) throw new Error(`ProofStation response missing tx data: ${JSON.stringify(Object.keys(data))}`);

  const balancedBytes = new Uint8Array(balancedHex.match(/.{2}/g).map((b: string) => parseInt(b, 16)));
  return (ledger as any).Transaction.deserialize('signature', 'proof', 'binding', balancedBytes);
}

// ─── End of ProofStation Integration ─────────────────────────────────────────

async function waitForProofServer(maxAttempts = 60, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(networkConfig.proofServer, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      return true;
    } catch {
      // not ready yet
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`\r  Waiting for proof server... (${attempt}/${maxAttempts})   `);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'swda');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\n❌ Contract not compiled! Run: npm run compile\n');
  process.exit(1);
}

const Swda = await import(pathToFileURL(contractPath).href);

const secretKey = getRandomValues(new Uint8Array(32));
const ownerAccountId = persistentHash(new CompactTypeVector(1, Bytes32Descriptor), [secretKey]);
const domainSep = getRandomValues(new Uint8Array(32));

const eitherAddress = (hash: Uint8Array) => ({
  is_left: true,
  left: hash,
  right: { bytes: new Uint8Array(32) },
});

const witnesses = {
  wit_OwnableSK(context: any) {
    return [context.privateState, Uint8Array.from(context.privateState.secretKey)];
  },
};

const compiledContract = CompiledContract.make('swda', Swda.Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

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

      // Step 1: Try normal balance with DUST (in case DUST is available)
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
        // DUST shortage — fall through to ProofStation
      }

      // Step 2: Balance without DUST (only unshielded + shielded)
      console.log('  DUST unavailable locally — using local proof + ProofStation /balance-only...');
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ...opts, tokenKindsToBalance: ['unshielded', 'shielded'] },
      );

      // Step 3: Sign + finalize locally (proof server generates ZK proof)
      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );
      const finalizedTx = await walletCtx.wallet.finalizeRecipe(signedRecipe);

      // Step 4: Send proved tx to ProofStation for DUST sponsorship
      return proofStationBalanceOnly(finalizedTx);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'swda-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
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
        `Unknown encryption key for ${hex}. Deploy only resolves own wallet key.`,
      );
    },
  };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Deploy SWDA via ProofStation (${network})`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // Limpa lock residual do LevelDB
  const levelDbPath = path.resolve(process.cwd(), 'midnight-level-db');
  try { fs.rmSync(path.join(levelDbPath, 'LOCK'), { force: true }); } catch {}

  const seed = SEED;

  console.log('─── Wallet setup ───────────────────────────────────────────────\n');

  console.log('  Creating wallet (shielded sync disabled)...');
  const walletCtx = await createWallet({ network, networkConfig, seed, skipStart: true });

  const address = walletCtx.unshieldedKeystore.getBech32Address();
  console.log(`\n  Wallet Address: ${address}\n`);

  if (network !== 'undeployed' && networkConfig.faucet) {
    console.log('─── Fund Wallet ────────────────────────────────────────────────\n');
    console.log(`  Faucet: ${networkConfig.faucet}`);
    console.log(`  1. Copy the address above`);
    console.log(`  2. Open the faucet URL in your browser`);
    console.log(`  3. Paste the address and request tNIGHT`);
    console.log(`  4. Return here — funds auto-detected\n`);
  }

  // Start only unshielded + dust wallets
  console.log('  Starting unshielded + dust wallets...');
  await startUnshieldedAndDust(walletCtx.wallet, walletCtx.dustSecretKey);

  // Wait for unshielded sync
  console.log('  Syncing unshielded wallet...\n');
  const SYNC_TIMEOUT_MS = network === 'undeployed' ? 30_000 : 300_000;
  const syncStart = Date.now();
  const syncInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - syncStart) / 1000);
    process.stdout.write(`\r  ⏳ Syncing... (${elapsed}s elapsed)    `);
  }, 5000);

  try {
    await Promise.race([
      (walletCtx.wallet as any).unshielded.waitForSyncedState(),
      new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error('Unshielded sync timeout')), SYNC_TIMEOUT_MS)
      ),
    ]);
    clearInterval(syncInterval);
    process.stdout.write('\r  ✓ Unshielded synced.                              \n');
  } catch {
    clearInterval(syncInterval);
    process.stdout.write('\r  ⚠ Unshielded sync timeout — continuing with polling.\n');
  }

  // Read initial balance
  let balance = 0n;
  try {
    const s = await Rx.firstValueFrom(walletCtx.wallet.state());
    balance = s.unshielded?.balances?.[unshieldedToken().raw] ?? 0n;
  } catch {}
  console.log(`\n  Balance: ${balance.toLocaleString()} tNight\n`);

  if (network === 'undeployed' && balance === 0n) {
    console.error('\n❌ Genesis-seed wallet has zero NIGHT.\n');
    await walletCtx.wallet.stop();
    process.exit(1);
  }

  // Funding: poll state
  if (network !== 'undeployed' && networkConfig.faucet && balance === 0n) {
    console.log('  Waiting for tNIGHT (poll every 10s, up to 10 min)...\n');
    const timeoutMs = 600_000;
    const start = Date.now();
    while (true) {
      await new Promise((r) => setTimeout(r, 10_000));
      try {
        const s = await Rx.firstValueFrom(walletCtx.wallet.state());
        const tn = s.unshielded?.balances?.[unshieldedToken().raw] ?? 0n;
        if (tn > 0n) {
          balance = tn;
          console.log(`\n  ✅ Funded! tNIGHT balance: ${tn.toLocaleString()}\n`);
          break;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        console.log(`\n  ❌ Funding not received.`);
        console.log(`  Address: ${address}`);
        console.log(`  Faucet:  ${networkConfig.faucet}\n`);
        await walletCtx.wallet.stop();
        process.exit(1);
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r  ...still waiting (${elapsed}s elapsed)`);
    }
  }

  // --- DUST: skip sync (causes OOM) — ProofStation will handle DUST fees ---
  console.log('\n  Skipping local DUST sync (ProofStation will sponsor fees)...\n');

  console.log('─── Deploy Contract (via ProofStation) ─────────────────────────\n');

  // No local proof server needed — ProofStation handles proving + DUST
  console.log('  Setting up providers...');
  const providers = await createProviders(walletCtx);

  console.log('  Deploying contract...\n');

  const MAX_RETRIES = network === 'undeployed' ? 20 : 60;
  const RETRY_DELAY_MS = 5000;
  let deployed: Awaited<ReturnType<typeof deployContract>> | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      deployed = await deployContract(providers, {
        compiledContract: compiledContract as any,
        args: [
          domainSep,
          'SWDA',
          'SWDA',
          6n,
          eitherAddress(ownerAccountId),
        ],
        privateStateId: 'swda-state',
        initialPrivateState: { secretKey },
      });
      break;
    } catch (err: any) {
      const errMsg = err?.message || err?.toString() || '';
      const errCause = err?.cause?.message || err?.cause?.toString() || '';
      const fullError = `${errMsg} ${errCause}`;

      const isProofStationRetry =
        fullError.includes('ProofStation') ||
        fullError.includes('503') ||
        fullError.includes('502') ||
        fullError.includes('wallet still syncing');

      const isTransient =
        isProofStationRetry ||
        fullError.includes('Failed to connect') ||
        fullError.includes('ECONNREFUSED') ||
        fullError.includes('timeout');

      console.error(`  Attempt ${attempt}/${MAX_RETRIES} error: ${errMsg}`);
      if (errCause && errCause !== errMsg) console.error(`  Cause: ${errCause}`);

      if (attempt < MAX_RETRIES && isTransient) {
        const delay = isProofStationRetry ? 30_000 : RETRY_DELAY_MS;
        console.log(`  Retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        console.error('\n  ❌ Non-retryable error or max retries exceeded.\n');
        await walletCtx.wallet.stop();
        process.exit(1);
      }
    }
  }

  if (!deployed) throw new Error('Deployment failed after all retries');

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log('  ✅ Contract deployed successfully!\n');
  console.log(`  Contract Address: ${contractAddress}`);
  console.log(`  Domain Separator: ${Buffer.from(domainSep).toString('hex')}\n`);

  saveSwda(
    contractAddress,
    Buffer.from(domainSep).toString('hex'),
  );
  saveSwdaSecretKey(Buffer.from(secretKey).toString('hex'));
  console.log('  Saved to .midnight-state.json\n');

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Deployment complete ────────────────────────────────────────\n');
  console.log('  Next: npm run cli:proofstation\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
