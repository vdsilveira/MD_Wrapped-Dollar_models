import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Buffer } from 'buffer';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateSeed, getWdollarAgentAddress, getWdollarAgentAccountId } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

globalThis.WebSocket = WebSocket as any;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'wdollar-agent');

const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\nContract not compiled! Run: npm run compile:agent\n');
  process.exit(1);
}

const WdollarAgent = await import(pathToFileURL(contractPath).href);

const witnesses = {
  wit_OwnableSK(context: any) {
    return [context.privateState, Uint8Array.from(context.privateState.secretKey)];
  },
  wit_WDASK(context: any) {
    return [context.privateState, Uint8Array.from(context.privateState.secretKey)];
  },
};

const compiledContract = CompiledContract.make('wdollar-agent', WdollarAgent.Contract).pipe(
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
  throw new Error('Invalid address. Use a 64-character hex string (account ID).');
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
      privateStateStoreName: 'wdollar-agent-state',
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
  console.log('║       Wrapped Dollar for Agents CLI                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  const agentAddress = getWdollarAgentAddress();
  if (!agentAddress) {
    console.error(`No Wrapped Dollar for Agents deployment on file for network ${network}. Run \`npm run deploy:agent\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${agentAddress}`);
  console.log(`  Network: ${network}\n`);

  const myAccountId = getWdollarAgentAccountId();
  if (myAccountId) {
    console.log(`  Your Account ID: ${myAccountId}\n`);
  }

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
      contractAddress: agentAddress,
      privateStateId: 'wdollar-agent-state',
    });

    console.log('  Connected!\n');

    const call = (method: string, ...args: any[]) =>
      (deployed.callTx as any)[method](...args).then((r: any) => r.private.result);
    const submit = (method: string, ...args: any[]) =>
      (deployed.callTx as any)[method](...args).then((r: any) => r.public);

    let running = true;
    while (running) {
      console.log('─── Menu ───────────────────────────────────────────────────────');
      console.log('  1. My Account ID');
      console.log('  2. My WDA Balance');
      console.log('  3. Token Info');
      console.log('  4. Mint (owner only)');
      console.log('  5. Burn from account (owner only)');
      console.log('  6. Transfer with Receipt');
      console.log('  7. Get Receipt (requestNonce)');
      console.log('  8. Check Another Balance');
      console.log('  9. Wallet Balance');
      console.log('  10. Exit\n');

      const choice = await rl.question('  Your choice: ');

      switch (choice.trim()) {
        case '1': {
          if (myAccountId) {
            console.log(`\n  Your Account ID: ${myAccountId}\n`);
          } else {
            console.log('\n  No Account ID on file. Re-deploy the contract.\n');
          }
          break;
        }

        case '2': {
          if (!myAccountId) {
            console.log('\n  No Account ID on file. Re-deploy the contract.\n');
            break;
          }
          console.log('\n  Fetching your WDA balance...');
          try {
            const result = await call('balanceOf', parseEitherAddress(myAccountId));
            console.log(`\n  Your WDA balance: ${result.toLocaleString()}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '3': {
          console.log('\n  Fetching token info...');
          try {
            const info = await call('tokenInfo');
            console.log(`\n  Name:          ${info.name}`);
            console.log(`  Symbol:        ${info.symbol}`);
            console.log(`  Decimals:      ${info.decimals.toString()}`);
            console.log(`  Total Supply:  ${info.totalSupply.toLocaleString()}`);
            console.log(`  Owner:         ${formatEither(info.owner)}`);
            console.log(`  Paused:        ${info.isPaused ? 'Yes' : 'No'}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '4': {
          const recipientHex = await rl.question('  Recipient account ID (64 hex chars): ');
          const valueStr = await rl.question('  Amount: ');
          const value = BigInt(valueStr);

          if (value > BigInt('18446744073709551615')) {
            console.log('\n  Amount too large. WDA caps at Uint<64> (max 18,446,744,073,709,551,615).\n');
            break;
          }

          console.log('\n  Submitting mint...');
          try {
            const tx = await submit('mint', parseEitherAddress(recipientHex), value);
            console.log(`\n  ✅ Mint submitted!`);
            console.log(`  Transaction ID: ${tx.txId}`);
            console.log(`  Block height: ${tx.blockHeight}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '5': {
          const burnHex = await rl.question('  Account ID to burn from (64 hex chars): ');
          const valueStr = await rl.question('  Amount to burn: ');
          const value = BigInt(valueStr);

          if (value > BigInt('18446744073709551615')) {
            console.log('\n  Amount too large. WDA caps at Uint<64> (max 18,446,744,073,709,551,615).\n');
            break;
          }

          console.log('\n  Submitting burnFrom...');
          try {
            const tx = await submit('burnFrom', parseEitherAddress(burnHex), value);
            console.log(`\n  ✅ Burn submitted!`);
            console.log(`  Transaction ID: ${tx.txId}`);
            console.log(`  Block height: ${tx.blockHeight}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '6': {
          const toHex = await rl.question('  Recipient account ID (64 hex chars): ');
          const valueStr = await rl.question('  Amount: ');
          const value = BigInt(valueStr);

          if (value > BigInt('18446744073709551615')) {
            console.log('\n  Amount too large. WDA caps at Uint<64> (max 18,446,744,073,709,551,615).\n');
            break;
          }

          const nonceHex = await rl.question('  Request nonce from server (64 hex chars): ');
          if (!/^[0-9a-fA-F]{64}$/.test(nonceHex)) {
            console.log('\n  Invalid nonce. Expected 64 hex chars.\n');
            break;
          }
          const nonce = Buffer.from(nonceHex, 'hex');

          console.log('  Submitting transfer with receipt (sender = you, from witness)...');
          try {
            const receiptId = await call('transferWithReceipt', parseEitherAddress(toHex), value, nonce);
            console.log(`\n  ✅ Transfer complete!`);
            console.log(`  Receipt ID: ${receiptId}`);
            console.log(`  Request Nonce: ${nonceHex}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '7': {
          const idStr = await rl.question('  Receipt ID (inteiro): ');
          if (!/^\d+$/.test(idStr.trim())) {
            console.log('\n  Entrada inválida. Digite apenas números.\n');
            break;
          }
          const id = BigInt(idStr);
          console.log('\n  Fetching receipt...');
          try {
            const receipt = await call('receipt', id);
            console.log(`\n  ── Receipt #${id} ────────────────────────────────────`);
            console.log(`  To:           ${formatEither(receipt.to)}`);
            console.log(`  Amount:       ${receipt.amount.toLocaleString()}`);
            console.log(`  RequestNonce: ${Buffer.from(receipt.requestNonce).toString('hex')}`);
            console.log('  ───────────────────────────────────────────────────────\n');
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '8': {
          const whoHex = await rl.question('  Account ID (64 hex chars): ');
          console.log('\n  Fetching balance...');
          try {
            const result = await call('balanceOf', parseEitherAddress(whoHex));
            console.log(`\n  Balance: ${result.toLocaleString()}\n`);
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
