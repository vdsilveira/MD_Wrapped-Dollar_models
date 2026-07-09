import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Buffer } from 'buffer';
import { getRandomValues } from 'node:crypto';
import { ShieldedAddress, MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

import { findDeployedContract, withContractScopedTransaction } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateSeed, getWdollarAgentShielded } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

globalThis.WebSocket = WebSocket as any;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'wdollar-agent-shielded');

const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\nContract not compiled! Run: npm run compile:agent-shielded\n');
  process.exit(1);
}

const WdollarAgentShielded = await import(pathToFileURL(contractPath).href);

const witnesses = {
  wit_OwnableSK(context: any) {
    return [context.privateState, Uint8Array.from(context.privateState.secretKey)];
  },
};

const compiledContract = CompiledContract.make('wdollar-agent-shielded', WdollarAgentShielded.Contract).pipe(
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
  // Fallback: raw hex coin public key (self-mint)
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return {
      coinPublicKey: parseCoinPublicKey(input),
      encryptionKey: null as any,
      coinPublicKeyHex: input.toLowerCase(),
    };
  }

  // Midnight bech32 (ex: mn_shield-addr_undeployed1...)
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
      privateStateStoreName: 'wdollar-agent-shielded-state',
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
  console.log('║          WDA Shielded CLI                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  const deployment = getWdollarAgentShielded();
  if (!deployment) {
    console.error(`No agent-shielded deployment on file for network ${network}. Run \`npm run deploy:agent-shielded\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Network: ${network}\n`);

  // Limpa lock residual do LevelDB (deploy anterior pode deixar LOCK travado)
  const levelDbPath = path.resolve(process.cwd(), 'midnight-level-db');
  try { fs.rmSync(path.join(levelDbPath, 'LOCK'), { force: true }); } catch {}

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
      privateStateId: 'wdollar-agent-shielded-state',
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
          const shieldState = await walletCtx.wallet.waitForSyncedState();
          const bech32Addr = ShieldedAddress.codec.encode(network, shieldState.shielded.address).toString();
          const coinPubKey = shieldState.shielded.coinPublicKey.toHexString();
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
          const receiptToHex = await rl.question('  Receipt "to" account ID (64 hex chars, e.g. server ID): ');
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
                  parseEitherAddress(receiptToHex),
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
          const currentState = await walletCtx.wallet.waitForSyncedState();
          const currentTNight = currentState.unshielded.balances[unshieldedToken().raw] ?? 0n;
          const dustBalance = currentState.dust.balance(new Date());
          console.log(`\n  tNIGHT: ${currentTNight.toLocaleString()}`);
          console.log(`  DUST:   ${dustBalance.toLocaleString()}\n`);
          break;
        }

        case '9': {
          console.log('\n  Checking WDAS balance...');
          try {
            const tokenColorResult = await call('tokenColor');
            const colorHex = Buffer.from(unwrap(tokenColorResult)).toString('hex');
            const currentState = await walletCtx.wallet.waitForSyncedState();
            const wdasBalance = currentState.shielded.balances[colorHex] ?? 0n;
            console.log(`\n  WDAS Balance: ${fmt(wdasBalance)}\n`);
          } catch (error) {
            console.error('\n  Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '10': {
          const recipientStr = await rl.question('  Recipient unshielded address (mn_addr_...): ');
          const amountStr = await rl.question('  Amount (tNIGHT, e.g. 5 or 0.1): ');
          const amount = parseAmount(amountStr, TNIGHT_DECIMALS);

          console.log('\n  Sending tNIGHT...');
          try {
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
