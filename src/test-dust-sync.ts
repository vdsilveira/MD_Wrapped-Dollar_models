import 'dotenv/config';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';
import { resolveNetwork, getOrCreateSeed } from './network';
import { createWallet, startUnshieldedAndDust, unshieldedToken } from './wallet';

globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const seed = getOrCreateSeed(network);

async function main() {
  console.log(`\n  Network: ${network}`);
  console.log(`  Node: ${networkConfig.node}`);
  console.log(`  Indexer: ${networkConfig.indexer}\n`);

  console.log('─── Creating wallet ─────────────────────────────\n');
  const walletCtx = await createWallet({ network, networkConfig, seed, skipStart: true });

  console.log('─── Starting unshielded + dust ──────────────────\n');
  await startUnshieldedAndDust(walletCtx.wallet, walletCtx.dustSecretKey);

  // Unshielded with timeout
  console.log('  Waiting for unshielded sync (30s timeout)...');
  try {
    await Promise.race([
      (walletCtx.wallet as any).unshielded.waitForSyncedState(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000)),
    ]);
    const s = await Rx.firstValueFrom(walletCtx.wallet.state());
    const bal = s.unshielded?.balances?.[unshieldedToken().raw] ?? 0n;
    console.log(`  ✓ Unshielded synced. Balance: ${bal.toLocaleString()} tNight\n`);
  } catch (e: any) {
    console.log(`  ⚠ Unshielded: ${e.message}\n`);
  }

  // DUST with timeout
  console.log('  Waiting for DUST sync (60s timeout)...');
  const dustStart = Date.now();
  const dustLog = setInterval(() => {
    const elapsed = Math.round((Date.now() - dustStart) / 1000);
    try {
      const s = (walletCtx.wallet as any).dust?.currentState;
      process.stdout.write(`\r  ⏳ DustWallet state: ${JSON.stringify(s?.type ?? 'unknown')} (${elapsed}s)     `);
    } catch {}
  }, 5000);

  try {
    const dustState = await Promise.race([
      walletCtx.wallet.dust.waitForSyncedState(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('DUST sync timeout')), 60_000)),
    ]);
    clearInterval(dustLog);
    const balance = dustState.balance(new Date());
    console.log(`\r  ✓ DUST synced. Balance: ${balance.toLocaleString()}                                \n`);
  } catch (e: any) {
    clearInterval(dustLog);
    console.log(`\r  ⚠ DUST sync: ${e.message}                                \n`);
  }

  // Check raw state
  console.log('─── Raw wallet state ────────────────────────────\n');
  try {
    const state = await Rx.firstValueFrom(walletCtx.wallet.state());
    console.log(`  Unshielded balance: ${state.unshielded?.balances?.[unshieldedToken().raw] ?? 0n}`);
    console.log(`  DUST balance: ${state.dust?.balance(new Date()) ?? 'N/A'}`);
    console.log(`  DUST type: ${state.dust?.constructor?.name ?? 'unknown'}`);
    console.log(`  isSynced: ${state.isSynced}`);
  } catch (e: any) {
    console.log(`  Error reading state: ${e.message}`);
  }

  await walletCtx.wallet.stop();
  console.log('\n  Done.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
