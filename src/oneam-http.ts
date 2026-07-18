import 'dotenv/config';

const PROOFSTATION_URL = process.env.PROOFSTATION_URL || 'https://api-preprod.1am.xyz';
const SESSION_TOKEN = process.env.PROOFSTATION_SESSION_TOKEN || '';

function headers(): Record<string, string> {
  return {
    'x-session-token': SESSION_TOKEN,
    'Content-Type': 'application/json',
  };
}

export async function rpcCall(
  method: string,
  params: unknown[] = [],
): Promise<any> {
  const res = await fetch(`${PROOFSTATION_URL}/rpc/midnight`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`RPC call failed (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

export async function getBlockNumber(): Promise<number> {
  const result = await rpcCall('chain_getBlockHeader', []);
  return result?.number ?? 0;
}

export async function getContractState(
  contractAddress: string,
  key: string,
): Promise<any> {
  return rpcCall('contract_state_query', [
    contractAddress,
    key,
  ]);
}

export async function walletStatus(): Promise<any> {
  const res = await fetch(`${PROOFSTATION_URL}/wallet-status`, {
    headers: {
      'x-session-token': SESSION_TOKEN,
    },
  });

  if (!res.ok) throw new Error(`wallet-status failed (${res.status})`);

  return res.json();
}

export async function getDustBalance(): Promise<{ balance: bigint; utxoCount: number }> {
  const status = await walletStatus();
  if (status.wallets?.[0]?.dust) {
    const dust = status.wallets[0].dust;
    return {
      balance: BigInt(dust.balance || '0'),
      utxoCount: dust.utxoCount || 0,
    };
  }
  return { balance: 0n, utxoCount: 0 };
}

export async function shieldedScan(
  viewingKeyHex: string,
  coinPublicKeyHex: string,
  options?: {
    from?: number;
    to?: number;
    contractAddress?: string;
    includeEvidence?: boolean;
  },
): Promise<Buffer> {
  const params = new URLSearchParams();
  if (options?.from !== undefined) params.set('from', String(options.from));
  if (options?.to !== undefined) params.set('to', String(options.to));
  if (options?.contractAddress) params.set('contractAddress', options.contractAddress);
  if (options?.includeEvidence) params.set('includeEvidence', 'true');

  const url = `${PROOFSTATION_URL}/chain-data/shielded${params.toString() ? '?' + params.toString() : ''}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-session-token': SESSION_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      viewingKey: viewingKeyHex,
      coinPublicKey: coinPublicKeyHex,
    }),
  });

  if (!res.ok) {
    throw new Error(`shielded scan failed (${res.status}): ${await res.text()}`);
  }

  console.log(`  Shielded scan: output-count=${res.headers.get('X-Output-Count') || '?'}, last-event=${res.headers.get('X-Last-Event-Id') || '?'}`);

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

export async function getUnshieldedRecords(walletAddress: string): Promise<Buffer> {
  const res = await fetch(
    `${PROOFSTATION_URL}/chain-data/unshielded?wallet_address=${encodeURIComponent(walletAddress)}`,
    {
      headers: {
        'x-session-token': SESSION_TOKEN,
      },
    },
  );

  if (!res.ok) throw new Error(`unshielded query failed (${res.status})`);

  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer);
}

export async function graphQL(query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${PROOFSTATION_URL}/api/v4/graphql`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      query,
      variables: variables || {},
    }),
  });

  if (!res.ok) throw new Error(`GraphQL failed (${res.status}): ${await res.text()}`);
  return res.json();
}
