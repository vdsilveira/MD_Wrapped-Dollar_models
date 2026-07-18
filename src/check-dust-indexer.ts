import { WebSocket } from 'ws';
import * as dotenv from 'dotenv';
dotenv.config();

const DUST_ADDRESS = 'mn_dust_preprod1ww2xjj724p0vme8yzduf3g7vnyrf92qjd6qdzanjcm8egjlzqwz3csgwz49';
const INDEXER_WS = 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws';

interface DustGenerationsItem {
  owner: string;
  value: string;
  initialValue: string;
  backingNight: string;
  ctime: number;
  commitmentMtIndex: number;
  generationMtIndex: number;
  transactionId: number;
  transactionHash: string;
}

interface DustGenerationsProgress {
  highestIndex: number;
}

let msgId = 0;
function nextId(): string {
  return String(++msgId);
}

function waitForAck(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connection_ack') {
        ws.removeListener('message', handler);
        resolve();
      } else if (msg.type === 'connection_error') {
        ws.removeListener('message', handler);
        reject(new Error(`Connection error: ${JSON.stringify(msg.payload)}`));
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
  });
}

function subscribeDustGenerations(
  ws: WebSocket,
  dustAddress: string,
): Promise<{ items: DustGenerationsItem[]; highestIndex: number }> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const items: DustGenerationsItem[] = [];
    let highestIndex = 0;
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error(`Timeout waiting for DUST sync (got ${items.length} items, highestIndex=${highestIndex})`));
      }
    }, 120_000);

    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;

      if (msg.type === 'next') {
        const event = msg.payload?.data?.dustGenerations;
        if (!event) return;

        const typeName = event.__typename;

        if (typeName === 'DustGenerationsItem') {
          items.push(event as DustGenerationsItem);
          process.stdout.write(`\r  DUST items: ${items.length}    `);
        } else if (typeName === 'DustGenerationsProgress') {
          highestIndex = (event as DustGenerationsProgress).highestIndex;
          process.stdout.write(`\r  DUST sync complete. ${items.length} items, highestIndex=${highestIndex}    `);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.removeListener('message', handler);
            ws.send(JSON.stringify({ id, type: 'complete' }));
            resolve({ items, highestIndex });
          }
        } else if (typeName === 'DustGenerationDtimeUpdateItem') {
          process.stdout.write(`\r  DUST dtime update (items so far: ${items.length})    `);
        }
      } else if (msg.type === 'error') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          reject(new Error(`GraphQL error: ${JSON.stringify(msg.payload)}`));
        }
      } else if (msg.type === 'complete') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          ws.removeListener('message', handler);
          resolve({ items, highestIndex });
        }
      }
    };

    ws.on('message', handler);

    const query = `subscription {
      dustGenerations(dustAddress: "${dustAddress}", startIndex: 0) {
        __typename
        ... on DustGenerationsItem {
          owner value initialValue backingNight ctime
          commitmentMtIndex generationMtIndex
          transactionId transactionHash
        }
        ... on DustGenerationsProgress {
          highestIndex
        }
        ... on DustGenerationDtimeUpdateItem {
          commitmentMtIndex generationMtIndex
        }
      }
    }`;

    ws.send(JSON.stringify({ id, type: 'subscribe', payload: { query } }));
  });
}

async function checkDustBalance(dustAddress?: string): Promise<{ balance: bigint; itemCount: number; highestIndex: number }> {
  const addr = dustAddress || DUST_ADDRESS;

  const ws = new WebSocket(INDEXER_WS, ['graphql-transport-ws']);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  await waitForAck(ws);

  const { items, highestIndex } = await subscribeDustGenerations(ws, addr);

  ws.close();

  let balance = 0n;
  for (const item of items) {
    balance += BigInt(item.value);
  }

  return { balance, itemCount: items.length, highestIndex };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DUST Balance Checker (via Midnight Indexer)                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const dustAddr = process.argv[2] || DUST_ADDRESS;
  console.log(`  DUST Address: ${dustAddr}`);
  console.log(`  Indexer: ${INDEXER_WS}\n`);

  console.log('  Connecting to indexer...');
  const result = await checkDustBalance(dustAddr);

  const dustHuman = Number(result.balance) / 1e15;
  console.log(`\n\n  ─── DUST Balance ─────────────────────────────────────────\n`);
  console.log(`  Balance: ${result.balance.toLocaleString()} specks (${dustHuman.toFixed(6)} DUST)`);
  console.log(`  DUST items: ${result.itemCount}`);
  console.log(`  Highest index: ${result.highestIndex}\n`);

  const MIN_DUST = 10_000_000n;
  if (result.balance >= MIN_DUST) {
    console.log(`  ✅ Sufficient DUST for deploy (≥ ${MIN_DUST.toLocaleString()} specks)\n`);
  } else {
    console.log(`  ⚠ Insufficient DUST (need ≥ ${MIN_DUST.toLocaleString()} specks)\n`);
  }
}

main().catch((e) => { console.error(`\n  ❌ ${e.message}\n`); process.exit(1); });

export { checkDustBalance };
