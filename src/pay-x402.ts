// pay-x402 — non-interactive x402 payment bridge for the WDA contract.
//
// Called by the midnight-x402 app's agent (MidnightWallet) as a child process.
// Pays `--amount` WDA to `--to` recording `--nonce` as the receipt's
// requestNonce, auto-minting to the agent (deployer/owner identity) when its
// balance is short.
//
// Output protocol: JSON lines on stdout. Progress lines are
//   {"event":"step","step":"<name>","detail":"<text>"}
// and the final line is either
//   {"event":"result","ok":true, txId, txHash, receiptId, blockHeight, ...}
// or
//   {"event":"error","message":"<text>"}  (exit code 1)
//
// Usage:
//   npx tsx src/pay-x402.ts --to <hex64> --amount <atomic-int> --nonce <hex64>

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
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { resolveNetwork, getOrCreateSeed, getWdollarAgentAddress, getWdollarAgentAccountId } from './network';
import { createWallet, persistWalletState, type WalletContext } from './wallet';

globalThis.WebSocket = WebSocket as any;

function out(obj: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function step(name: string, detail: string): void {
  out({ event: 'step', step: name, detail });
}

function fail(message: string): never {
  out({ event: 'error', message });
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

const toHex = argValue('--to');
const amountStr = argValue('--amount');
const nonceHex = argValue('--nonce');

if (!toHex || !HEX64.test(toHex)) fail('--to must be a 64-char hex WDA account id');
if (!amountStr || !/^\d+$/.test(amountStr)) fail('--amount must be a positive integer (atomic units)');
if (!nonceHex || !HEX64.test(nonceHex)) fail('--nonce must be a 64-char hex request nonce');
const amount = BigInt(amountStr);

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'wdollar-agent');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
if (!fs.existsSync(contractPath)) fail('Contract not compiled — run `npm run compile:agent`.');
const WdollarAgent = await import(pathToFileURL(contractPath).href);

const contractAddress = getWdollarAgentAddress();
if (!contractAddress) fail(`No WDA deployment on file for network ${network} — run \`npm run deploy:agent\`.`);
const myAccountId = getWdollarAgentAccountId();
if (!myAccountId) fail('No WDA account id on file — re-run `npm run deploy:agent`.');

const eitherAccount = (hex: string) => ({
  is_left: true,
  left: Buffer.from(hex, 'hex'),
  right: { bytes: new Uint8Array(32) },
});

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

/** Resolves the hash the indexer knows this transaction by (txHash vs txId). */
async function resolveIndexerHash(candidates: string[]): Promise<string | null> {
  const query = `query ($hash: HexEncoded!) { transactions(offset: { hash: $hash }) { hash } }`;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const res = await fetch(networkConfig.indexer, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { hash: candidate.toLowerCase().replace(/^0x/, '') } }),
      });
      const body: any = await res.json();
      const hash = body?.data?.transactions?.[0]?.hash;
      if (hash) return hash;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

async function main() {
  step('connect', `connecting wallet on ${network} (contract ${contractAddress.slice(0, 10)}…)`);
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);

  const providers = await createProviders(walletCtx);
  const deployed: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress,
    privateStateId: 'wdollar-agent-state',
  });
  step('connected', 'wallet synced and contract handle ready');

  // Read the agent's WDA balance from public state (no transaction needed).
  const onChain = await providers.publicDataProvider.queryContractState(contractAddress);
  if (!onChain) fail(`contract ${contractAddress} not found on the indexer`);
  const state = WdollarAgent.ledger(onChain.data);
  const me = eitherAccount(myAccountId);
  const balance: bigint = state.balances.member(me) ? state.balances.lookup(me) : 0n;

  if (balance < amount) {
    // Deployer identity is the token owner on the local devnet, so the agent
    // can top itself up. Mint enough for many demo payments in one proof.
    const mintAmount = amount * 1000n;
    step('mint', `WDA balance ${balance} < ${amount}; minting ${mintAmount} (owner) — generating ZK proof`);
    await deployed.callTx.mint(me, mintAmount);
    step('minted', `minted ${mintAmount} WDA to agent account`);
  }

  step('proof_start', `paying ${amount} WDA to ${toHex.slice(0, 10)}… — proof server is generating the ZK proof`);
  const r = await deployed.callTx.transferWithReceipt(
    eitherAccount(toHex),
    amount,
    Buffer.from(nonceHex, 'hex'),
  );
  const receiptId: bigint = r.private.result;
  const pub = r.public;
  step('tx_submitted', `transaction included at block ${pub.blockHeight} (receipt #${receiptId})`);

  const indexerHash = await resolveIndexerHash([pub.txHash, pub.txId]);

  out({
    event: 'result',
    ok: true,
    txId: indexerHash ?? pub.txHash ?? pub.txId,
    txHash: pub.txHash ?? null,
    txIdOriginal: pub.txId ?? null,
    blockHeight: pub.blockHeight ?? null,
    receiptId: receiptId.toString(),
    contractAddress,
    to: toHex,
    amount: amount.toString(),
    nonce: nonceHex,
  });

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch((err) => {
  fail(err instanceof Error ? (err.cause ? `${err.message} (${(err.cause as Error).message ?? err.cause})` : err.message) : String(err));
});
