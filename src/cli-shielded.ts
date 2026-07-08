import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Buffer } from 'buffer';
import { getRandomValues } from 'node:crypto';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateSeed, getWdollarShielded } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

globalThis.WebSocket = WebSocket as any;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'wdollar-shielded');

const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\nContract not compiled! Run: npm run compile:shielded\n');
  process.exit(1);
}

const WdollarShielded = await import(pathToFileURL(contractPath).href);

const witnesses = {
  wit_OwnableSK(context: any) {
    return [context.privateState, Uint8Array.from(context.privateState.secretKey)];
  },
};

const compiledContract = CompiledContract.make('wdollar-shielded', WdollarShielded.Contract).pipe(
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
    'Invalid coin public key. Expected 64 hex chars.\n' +
      '  Get yours via option "1. My Coin Public Key".',
  );
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
  const state = await walletCtx.wallet.waitForSyncedState();

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );
      return walletCtx.wallet.finalizeRecipe(signedRecipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'wdollar-shielded-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║          WDollar Shielded CLI                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  const deployment = getWdollarShielded();
  if (!deployment) {
    console.error(`No shielded deployment on file for network ${network}. Run \`npm run deploy:shielded\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Network: ${network}\n`);

  try {
    const seed = SEED;

    console.log('  Connecting to wallet...');
    const walletCtx = await createWallet({ network, networkConfig, seed });
    const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
    if (restoredCount > 0) {
      console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state`);
    }

    console.log('  Syncing with network...\n');
    const syncStart = Date.now();
    const syncInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - syncStart) / 1000);
      process.stdout.write(`\r  Syncing... (${elapsed}s elapsed)   `);
    }, 5000);
    const state = await walletCtx.wallet.waitForSyncedState();
    clearInterval(syncInterval);
    process.stdout.write('\r  Synced.                                      \n');

    await persistWalletState(network, walletCtx);
    const tNightBalance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    console.log(`  tNIGHT: ${tNightBalance.toLocaleString()}\n`);

    if (tNightBalance === 0n && network !== 'undeployed' && networkConfig.faucet) {
      const address = walletCtx.unshieldedKeystore.getBech32Address();
      console.log('  Wallet has no tNight. Fund it from the faucet:');
      console.log(`     ${networkConfig.faucet}`);
      console.log(`     Wallet address: ${address}\n`);
    }

    console.log('  Connecting to contract...');
    const providers = await createProviders(walletCtx);

    const deployed: any = await findDeployedContract(providers, {
      compiledContract: compiledContract as any,
      contractAddress: deployment.address,
      privateStateId: 'wdollar-shielded-state',
    });

    console.log('  Connected!\n');

    function unwrap(v: unknown): Uint8Array {
      if (v instanceof Uint8Array) return v;
      if (v && typeof v === 'object' && 'bytes' in (v as any) && (v as any).bytes instanceof Uint8Array) return (v as any).bytes;
      throw new Error(`Expected Uint8Array or {bytes}, got ${typeof v}`);
    }
    const call = (method: string, ...args: any[]) =>
      (deployed.callTx as any)[method](...args).then((r: any) => r.private.result);
    const submit = (method: string, ...args: any[]) =>
      (deployed.callTx as any)[method](...args).then((r: any) => r.public);

    let running = true;
    while (running) {
      console.log('─── Menu ───────────────────────────────────────────────────────');
      console.log('  1. My Coin Public Key');
      console.log('  2. Token Info');
      console.log('  3. Token Color');
      console.log('  4. Mint (owner only)');
      console.log('  5. Owner');
      console.log('  6. Transfer Ownership');
      console.log('  7. Pause (owner only)');
      console.log('  8. Unpause (owner only)');
      console.log('  9. Wallet Balance');
      console.log('  10. Exit\n');

      const choice = await rl.question('  Your choice: ');

      switch (choice.trim()) {
        case '1': {
          const coinPubKey = state.shielded.coinPublicKey.toHexString();
          console.log(`\n  Your Coin Public Key: ${coinPubKey}\n`);
          console.log('  Share this hex with the contract owner so they can mint tokens to you.');
          console.log('  This is NOT your wallet address — it is your shielded identity.\n');
          break;
        }

        case '2': {
          console.log('\n  Fetching token info...');
          try {
            const [name, symbol, decimals, owner] = await Promise.all([
              call('name'),
              call('symbol'),
              call('decimals'),
              call('owner'),
            ]);
            console.log(`\n  Name:          ${name}`);
            console.log(`  Symbol:        ${symbol}`);
            console.log(`  Decimals:      ${decimals.toString()}`);
            console.log(`  Owner:         ${formatEither(owner)}\n`);
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
          const recipientHex = await rl.question('  Recipient coin public key (64 hex chars): ');
          const valueStr = await rl.question('  Amount: ');
          const value = BigInt(valueStr);

          if (value > BigInt('18446744073709551615')) {
            console.log('\n  Amount too large. Shielded tokens cap at Uint<64> (max 18,446,744,073,709,551,615).\n');
            break;
          }

          const nonce = getRandomValues(new Uint8Array(32));
          console.log('\n  Submitting mint...');
          try {
            const coin = await call('mint', parseCoinPublicKey(recipientHex), value, nonce);
            console.log(`\n  ✅ Mint submitted!`);
            console.log(`\n  ── ShieldedCoinInfo ──────────────────────────────────`);
            console.log(`  Nonce:  ${Buffer.from(unwrap(coin.nonce)).toString('hex')}`);
            console.log(`  Color:  ${Buffer.from(unwrap(coin.color)).toString('hex')}`);
            console.log(`  Value:  ${coin.value.toLocaleString()}`);
            console.log('  ───────────────────────────────────────────────────────');
            console.log('\n  ⚠  SAVE THIS INFO. It is the ONLY copy of the minted coin.');
            console.log('     The recipient cannot detect it by scanning the chain.\n');
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '5': {
          console.log('\n  Fetching owner...');
          try {
            const owner = await call('owner');
            console.log(`\n  Owner:  ${formatEither(owner)}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '6': {
          const newOwnerHex = await rl.question('  New owner account ID (64 hex chars): ');
          console.log('\n  Submitting transfer ownership...');
          try {
            const tx = await submit('transferOwnership', parseEitherAddress(newOwnerHex));
            console.log(`\n  Ownership transfer submitted!`);
            console.log(`  Transaction ID: ${tx.txId}`);
            console.log(`  Block height: ${tx.blockHeight}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '7': {
          console.log('\n  Pausing contract...');
          try {
            const tx = await submit('pause');
            console.log(`\n  Contract paused!`);
            console.log(`  Transaction ID: ${tx.txId}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '8': {
          console.log('\n  Unpausing contract...');
          try {
            const tx = await submit('unpause');
            console.log(`\n  Contract unpaused!`);
            console.log(`  Transaction ID: ${tx.txId}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '9': {
          console.log('\n  Checking balance...');
          const currentState = await walletCtx.wallet.waitForSyncedState();
          const currentTNight = currentState.unshielded.balances[unshieldedToken().raw] ?? 0n;
          const dustBalance = currentState.dust.balance(new Date());
          console.log(`\n  tNIGHT: ${currentTNight.toLocaleString()}`);
          console.log(`  DUST:   ${dustBalance.toLocaleString()}\n`);
          break;
        }

        case '10':
          running = false;
          console.log('\n  Goodbye!\n');
          break;

        default:
          console.log('\n  Invalid choice. Please enter 1-10.\n');
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
