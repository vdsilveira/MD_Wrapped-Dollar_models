// verify-receipt — read-only receipt check for the x402 facilitator.
//
// Decodes the WDA contract's public ledger state from the indexer and checks
// that receipt `--receipt` exists and matches the expected requestNonce,
// recipient, and amount. No wallet, no proof server, no transaction — this is
// the facilitator's on-chain settlement confirmation (AJUSTES.md §1.4 step 5).
//
// Prints exactly one JSON verdict on stdout:
//   {"ok":true,"receipt":{"to":"…","amount":"…","requestNonce":"…"}}
//   {"ok":false,"reason":"<why>"}
// Exit code 0 for any verdict; 1 only for infrastructure errors (bad args,
// indexer unreachable, contract not compiled).
//
// Usage:
//   npx tsx src/verify-receipt.ts --receipt <id> --nonce <hex64> \
//     --to <hex64> --amount <atomic-int> [--contract <hex64>]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Buffer } from 'buffer';

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { resolveNetwork, getWdollarAgentAddress } from './network';

globalThis.WebSocket = WebSocket as any;

function infraFail(message: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: 'infra_error', message })}\n`);
  process.exit(1);
}

function verdict(v: Record<string, unknown>): never {
  process.stdout.write(`${JSON.stringify(v)}\n`);
  process.exit(0);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

const receiptStr = argValue('--receipt');
const nonceHex = argValue('--nonce');
const toHex = argValue('--to');
const amountStr = argValue('--amount');
const contractArg = argValue('--contract');

if (!receiptStr || !/^\d+$/.test(receiptStr)) infraFail('--receipt must be a non-negative integer');
if (!nonceHex || !HEX64.test(nonceHex)) infraFail('--nonce must be a 64-char hex string');
if (!toHex || !HEX64.test(toHex)) infraFail('--to must be a 64-char hex account id');
if (!amountStr || !/^\d+$/.test(amountStr)) infraFail('--amount must be a positive integer');
if (contractArg && !HEX64.test(contractArg)) infraFail('--contract must be a 64-char hex address');

const receiptId = BigInt(receiptStr);
const amount = BigInt(amountStr);

const { network, config: networkConfig } = resolveNetwork();
setNetworkId(networkConfig.networkId);

const contractAddress = contractArg ?? getWdollarAgentAddress();
if (!contractAddress) infraFail(`no contract address (no --contract and no deployment on file for ${network})`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'wdollar-agent');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
if (!fs.existsSync(contractPath)) infraFail('Contract not compiled — run `npm run compile:agent`.');
const WdollarAgent = await import(pathToFileURL(contractPath).href);

async function main() {
  const publicDataProvider = indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS);
  const onChain = await publicDataProvider.queryContractState(contractAddress);
  if (!onChain) verdict({ ok: false, reason: 'contract_not_found' });

  const state = WdollarAgent.ledger(onChain.data);

  if (!state.receipts.member(receiptId)) {
    verdict({ ok: false, reason: 'receipt_not_found' });
  }
  const receipt = state.receipts.lookup(receiptId);

  const recNonce = Buffer.from(receipt.requestNonce).toString('hex');
  const recTo = receipt.to.is_left
    ? Buffer.from(receipt.to.left).toString('hex')
    : Buffer.from(receipt.to.right.bytes).toString('hex');

  if (recNonce !== nonceHex.toLowerCase()) {
    verdict({ ok: false, reason: 'nonce_mismatch', expected: nonceHex.toLowerCase(), actual: recNonce });
  }
  if (recTo !== toHex.toLowerCase()) {
    verdict({ ok: false, reason: 'recipient_mismatch', expected: toHex.toLowerCase(), actual: recTo });
  }
  if (receipt.amount < amount) {
    verdict({ ok: false, reason: 'amount_mismatch', expected: amount.toString(), actual: receipt.amount.toString() });
  }

  verdict({
    ok: true,
    receipt: {
      id: receiptId.toString(),
      to: recTo,
      amount: receipt.amount.toString(),
      requestNonce: recNonce,
    },
  });
}

main().catch((err) => {
  infraFail(err instanceof Error ? err.message : String(err));
});
