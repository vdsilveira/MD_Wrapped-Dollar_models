// state-x402 — read-only on-chain snapshot of the WDA ledger for the demo
// dashboard's "on-chain evidence" card.
//
// Decodes the contract's public state from the indexer (no wallet, no proof
// server) and prints one JSON object:
//   {
//     ok: true,
//     block: { height, hash },
//     contractAddress,
//     nextReceiptId: "3",
//     accounts: { "<hex64>": "<balance>", ... },   // agent (from state file) + --accounts
//     receipts: [ { id, to, amount, requestNonce }, ... ]  // most recent, newest first
//   }
//
// Usage:
//   npx tsx src/state-x402.ts [--accounts <hex64,hex64,...>] [--contract <hex64>] [--last <n>]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Buffer } from 'buffer';

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { resolveNetwork, getWdollarAgentAddress, getWdollarAgentAccountId } from './network';

globalThis.WebSocket = WebSocket as any;

function fail(message: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: 'infra_error', message })}\n`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

const contractArg = argValue('--contract');
const accountsArg = argValue('--accounts');
const lastArg = argValue('--last');

if (contractArg && !HEX64.test(contractArg)) fail('--contract must be a 64-char hex address');
const lastN = lastArg && /^\d+$/.test(lastArg) ? Math.min(Number(lastArg), 20) : 5;

const extraAccounts = (accountsArg ?? '')
  .split(',')
  .map((a) => a.trim())
  .filter(Boolean);
for (const a of extraAccounts) {
  if (!HEX64.test(a)) fail(`--accounts entries must be 64-char hex, got: ${a}`);
}

const { network, config: networkConfig } = resolveNetwork();
setNetworkId(networkConfig.networkId);

const contractAddress = contractArg ?? getWdollarAgentAddress();
if (!contractAddress) fail(`no contract address (no --contract and no deployment on file for ${network})`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'wdollar-agent');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
if (!fs.existsSync(contractPath)) fail('Contract not compiled — run `npm run compile:agent`.');
const WdollarAgent = await import(pathToFileURL(contractPath).href);

const eitherAccount = (hex: string) => ({
  is_left: true,
  left: Buffer.from(hex, 'hex'),
  right: { bytes: new Uint8Array(32) },
});

async function latestBlock(): Promise<{ height: number; hash: string } | null> {
  try {
    const res = await fetch(networkConfig.indexer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query { block { height hash } }' }),
    });
    const body: any = await res.json();
    return body?.data?.block ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const publicDataProvider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);
  const [onChain, block] = await Promise.all([
    publicDataProvider.queryContractState(contractAddress),
    latestBlock(),
  ]);
  if (!onChain) fail(`contract ${contractAddress} not found on the indexer`);

  const state = WdollarAgent.ledger(onChain.data);

  const accountIds = new Set<string>(extraAccounts.map((a) => a.toLowerCase()));
  const agentAccountId = getWdollarAgentAccountId();
  if (agentAccountId) accountIds.add(agentAccountId.toLowerCase());

  const accounts: Record<string, string> = {};
  for (const hex of accountIds) {
    const key = eitherAccount(hex);
    accounts[hex] = (state.balances.member(key) ? state.balances.lookup(key) : 0n).toString();
  }

  const nextReceiptId: bigint = state.nextReceiptId;
  const receipts: Array<Record<string, string>> = [];
  const first = nextReceiptId > BigInt(lastN) ? nextReceiptId - BigInt(lastN) : 0n;
  for (let id = nextReceiptId - 1n; id >= first && id >= 0n; id--) {
    if (!state.receipts.member(id)) continue;
    const r = state.receipts.lookup(id);
    receipts.push({
      id: id.toString(),
      to: r.to.is_left ? Buffer.from(r.to.left).toString('hex') : Buffer.from(r.to.right.bytes).toString('hex'),
      amount: r.amount.toString(),
      requestNonce: Buffer.from(r.requestNonce).toString('hex'),
    });
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      network,
      block,
      contractAddress,
      agentAccountId: agentAccountId ?? null,
      nextReceiptId: nextReceiptId.toString(),
      accounts,
      receipts,
    })}\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
