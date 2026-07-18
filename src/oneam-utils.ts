import 'dotenv/config';

const PROOFSTATION_URL = process.env.PROOFSTATION_URL || 'https://api-preprod.1am.xyz';
const SESSION_TOKEN = process.env.PROOFSTATION_SESSION_TOKEN || '';

function authHeaders(): Record<string, string> {
  return { 'x-session-token': SESSION_TOKEN };
}
function jsonHeaders(): Record<string, string> {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

// ─── Auth ──────────────────────────────────────────────────────────────────────

/** GET /auth/challenge — get a nonce for wallet auth */
export async function getChallenge(): Promise<{ nonce: string; domain: string; expiresAt: number }> {
  const res = await fetch(`${PROOFSTATION_URL}/auth/challenge`);
  if (!res.ok) throw new Error(`challenge failed (${res.status})`);
  return res.json();
}

/** POST /auth/verify — create a session by signing the nonce */
export async function verifySignature(body: {
  nonce: string;
  timestamp: number;
  pubkey: string;
  signature: string;
}): Promise<{ token: string; address: string; expires_in: number }> {
  const res = await fetch(`${PROOFSTATION_URL}/auth/verify`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`verify failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// ─── RPC (via POST /rpc/midnight) ──────────────────────────────────────────────

export async function rpcCall(method: string, params: unknown[] = []): Promise<any> {
  const res = await fetch(`${PROOFSTATION_URL}/rpc/midnight`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC call failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ─── Wallet Status (GET /wallet-status) ────────────────────────────────────────

export interface DustUtxo {
  amount: string;
  initialValue: string;
  ctime: string;
  seq: number;
  mtIndex: string;
  backingNight: string;
  backingNightValue: string;
  backingNightSpentAt: string | null;
  maxCap: string;
  rate: string;
}

export interface WalletStatusResponse {
  total: number;
  available: number;
  wallets: Array<{
    index: number;
    ready: boolean;
    syncState: string;
    address: string;
    dust: {
      balance: string;
      utxoCount: number;
      totalUtxoCount: number;
      pendingUtxoCount: number;
      isSynced: boolean;
      syncProgress: string;
      address: string;
      appliedIndex: string;
      highestIndex: string;
      isConnected: boolean;
      unavailableCause: string | null;
      syncError: string | null;
      syncErrorAt: string | null;
      utxos: {
        available: DustUtxo[];
        pending: DustUtxo[];
      };
    };
  }>;
  version: string;
  pendingTxs: {
    pending: number;
    oldest: string | null;
    lastTransactionAt: number;
    lastTransactionAgo: number;
  };
}

export async function walletStatus(): Promise<WalletStatusResponse> {
  const res = await fetch(`${PROOFSTATION_URL}/wallet-status`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`wallet-status failed (${res.status})`);
  return res.json();
}

export async function getDustBalance(): Promise<{ balance: bigint; utxoCount: number }> {
  const status = await walletStatus();
  const dust = status.wallets?.[0]?.dust;
  if (!dust) return { balance: 0n, utxoCount: 0 };
  return { balance: BigInt(dust.balance), utxoCount: dust.utxoCount };
}

// ─── Chain Data: Shielded (POST /chain-data/shielded) ──────────────────────────

export async function shieldedScan(
  viewingKeyHex: string,
  coinPublicKeyHex: string,
  options?: {
    from?: number;
    to?: number;
    contractAddress?: string;
    includeEvidence?: boolean;
  },
): Promise<{ data: Buffer; outputCount: number; lastEventId: number }> {
  const params = new URLSearchParams();
  if (options?.from !== undefined) params.set('from', String(options.from));
  if (options?.to !== undefined) params.set('to', String(options.to));
  if (options?.contractAddress) params.set('contractAddress', options.contractAddress);
  if (options?.includeEvidence) params.set('includeEvidence', 'true');

  const url = `${PROOFSTATION_URL}/chain-data/shielded${params.toString() ? '?' + params.toString() : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ viewingKey: viewingKeyHex, coinPublicKey: coinPublicKeyHex }),
  });
  if (!res.ok) throw new Error(`shielded scan failed (${res.status}): ${await res.text()}`);

  return {
    data: Buffer.from(await res.arrayBuffer()),
    outputCount: parseInt(res.headers.get('X-Output-Count') || '0', 10),
    lastEventId: parseInt(res.headers.get('X-Last-Event-Id') || '0', 10),
  };
}

/** GET /chain-data/shielded/state — download collapsed shielded state */
export async function downloadShieldedState(
  options?: { from?: number; to?: number },
): Promise<Buffer> {
  const params = new URLSearchParams();
  if (options?.from !== undefined) params.set('from', String(options.from));
  if (options?.to !== undefined) params.set('to', String(options.to));
  const qs = params.toString();
  const url = `${PROOFSTATION_URL}/chain-data/shielded/state${qs ? '?' + qs : ''}`;
  const res = await fetch(url, { headers: jsonHeaders() });
  if (!res.ok) throw new Error(`shielded state download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Chain Data: Dust (POST /chain-data/dust) ──────────────────────────────────

export async function dustScan(
  dustPublicKeyHex: string,
  options?: { from?: number; to?: number },
): Promise<{ data: Buffer; utxoCount: number }> {
  const params = new URLSearchParams();
  if (options?.from !== undefined) params.set('from', String(options.from));
  if (options?.to !== undefined) params.set('to', String(options.to));
  const qs = params.toString();
  const url = `${PROOFSTATION_URL}/chain-data/dust${qs ? '?' + qs : ''}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ dustPublicKey: dustPublicKeyHex }),
  });
  if (!res.ok) throw new Error(`dust scan failed (${res.status}): ${await res.text()}`);

  return {
    data: Buffer.from(await res.arrayBuffer()),
    utxoCount: parseInt(res.headers.get('X-Uxout-Count') || '0', 10),
  };
}

// ─── Chain Data: Unshielded (GET /chain-data/unshielded) ───────────────────────

export async function getUnshieldedRecords(walletAddress: string): Promise<{
  data: Buffer;
  recordCount: number;
}> {
  const res = await fetch(
    `${PROOFSTATION_URL}/chain-data/unshielded?wallet_address=${encodeURIComponent(walletAddress)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error(`unshielded query failed (${res.status})`);
  return {
    data: Buffer.from(await res.arrayBuffer()),
    recordCount: parseInt(res.headers.get('X-Record-Count') || '0', 10),
  };
}

// ─── Price (GET /price/{symbol}) ────────────────────────────────────────────────

export async function getPrice(symbol: string): Promise<{ price: number }> {
  const res = await fetch(`${PROOFSTATION_URL}/price/${encodeURIComponent(symbol)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`price failed (${res.status})`);
  return res.json();
}

// ─── Activities (POST /activities) ─────────────────────────────────────────────

export async function lookupActivities(txHashes: string[]): Promise<Buffer> {
  const res = await fetch(`${PROOFSTATION_URL}/activities`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ hashes: txHashes.slice(0, 200) }),
  });
  if (!res.ok) throw new Error(`activities lookup failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Chain Data Status (GET /chain-data/status) ────────────────────────────────

export async function chainDataStatus(): Promise<Record<string, any>> {
  const res = await fetch(`${PROOFSTATION_URL}/chain-data/status`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`chain-data status failed (${res.status})`);
  return res.json();
}

// ─── GraphQL Proxy (POST /api/v4/graphql) ───────────────────────────────────────

export async function graphQL<T = any>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T; errors?: Array<{ message: string }> }> {
  const res = await fetch(`${PROOFSTATION_URL}/api/v4/graphql`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (!res.ok) throw new Error(`GraphQL failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// ─── Proof / Balance (POST /prove, /balance-only, /prove-and-balance, /check, /verify) ───

/** POST /balance-only — send a proved tx, get back a DUST-sponsored tx */
export async function balanceOnly(
  txBytes: Uint8Array,
  retries = 3,
): Promise<{ txBytes: string; txHash: string; expiresAt: string; contractAddresses: string[]; dustCost: string }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${PROOFSTATION_URL}/balance-only`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
      body: txBytes as any,
    });

    if (res.status === 429) {
      const wait = 30_000;
      console.log(`  ⏳ Rate limited, waiting ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(`ProofStation /balance-only failed (${res.status}): ${JSON.stringify(err)}`);
    }

    return res.json();
  }
  throw new Error('Rate limited after all retries');
}

/** POST /prove — generate ZK proof */
export async function prove(body: Uint8Array): Promise<Buffer> {
  const res = await fetch(`${PROOFSTATION_URL}/prove`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
    body: body as any,
  });
  if (!res.ok) throw new Error(`prove failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** POST /prove-and-balance — prove and balance in one call */
export async function proveAndBalance(body: Uint8Array): Promise<any> {
  const res = await fetch(`${PROOFSTATION_URL}/prove-and-balance`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
    body: body as any,
  });
  if (!res.ok) throw new Error(`prove-and-balance failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// ─── Health ─────────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  version: string;
  build: string;
  cluster: any[];
  chainData: Record<string, { ready: boolean; eventCount: number; lastEventId: number; size: number; sizeHuman: string }>;
  release: {
    services: Record<string, { service: string; version: string; status: string; environment: string }>;
  };
  authenticated: boolean;
}

export async function health(): Promise<HealthResponse> {
  const res = await fetch(`${PROOFSTATION_URL}/health`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`health failed (${res.status})`);
  return res.json();
}

// ─── Utils ─────────────────────────────────────────────────────────────────────

export function validateUrl(url: string | undefined, name: string): string {
  if (!url) throw new Error(`${name} not set in .env`);
  return url;
}
