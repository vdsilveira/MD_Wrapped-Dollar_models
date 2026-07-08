# Wrapped Dollar for Agents (WDA)

## Visão Geral

O **Wrapped Dollar for Agents** é um contrato Midnight de token público com **receipts verificáveis**, projetado para o fluxo de pagamento **x402**: o cliente paga por requisição HTTP individual, e um **facilitador** (off-chain) valida o pagamento consultando o ledger público do contrato.

| Característica | WDA | WDollar (transparente) | WDollar Shielded |
|---|---|---|---|
| Saldos | Público (`Map`) | Público (`Map`) | Privado (UTXOs shieldeds) |
| Identidade do caller | Witness `wit_WDASK` | Witness `wit_FungibleTokenSK` | Witness `wit_OwnableSK` |
| Receipts | Sim — `{ to, amount, requestNonce }` | Não | Não |
| Anti-replay | `requestNonce` por transação | N/A | N/A |
| Autenticação | Sim — sender derivado do witness | Sim — sender derivado do witness | N/A (mint only) |

---

## Contrato (`contracts/wdollar-agent.compact`)

### Ledgers

```
_tokenName:  Opaque<"string">                    — "Wrapped Dollar for Agents"
_tokenSymbol: Opaque<"string">                   — "WDA"
_tokenDecimals: Uint<8>                          — 6
balances: Map<Either<Bytes<32>, ContractAddress>, Uint<64>>
receipts: Map<Uint<64>, Receipt>
nextReceiptId: Uint<64>
_totalSupply: Uint<64>                             — total de tokens em circulação
```

### Structs

```
Receipt {
  to:           Either<Bytes<32>, ContractAddress>   — quem recebeu
  amount:       Uint<64>
  requestNonce: Bytes<32>                             — vincula a 1 requisição HTTP
}
```

### Witness

```
wit_WDASK(): Bytes<32>
```

O witness retorna a chave secreta do caller armazenada no `privateState`. O contrato deriva a identidade:

```
_computeAccountId(): Bytes<32> = persistentHash<Vector<1, Bytes<32>>>([wit_WDASK()])
_sender(): Either<Bytes<32>, ContractAddress> = left<Bytes<32>, ContractAddress>(_computeAccountId())
```

Nenhum parâmetro público define o `sender` — ele é **sempre** quem assina a transação com a chave secreta. Impossível falsificar.

### Circuits

| Circuit | Acesso | Descrição |
|---|---|---|
| `name()` | Público | Retorna nome do token |
| `symbol()` | Público | Retorna símbolo |
| `decimals()` | Público | Retorna decimais |
| `owner()` | Público | Retorna dono do contrato (Ownable) |
| `tokenInfo()` | Público | Retorna name, symbol, decimals, totalSupply, owner, isPaused (1 chamada) |
| `balanceOf(account)` | Público | Saldo de qualquer conta |
| `totalSupply()` | Público | Total de tokens em circulação |
| `receipt(id)` | Público | Retorna receipt pelo ID |
| `mint(to, amount)` | Owner only | Cria tokens para `to` |
| `burnFrom(account, amount)` | Owner only | Queima tokens de qualquer conta (compliance) |
| `transferWithReceipt(to, amount, requestNonce)` | Autenticado | Transfere saldo + emite receipt |
| `pause()` | Owner only | Pausa o contrato (emergência) |
| `unpause()` | Owner only | Retoma o contrato |

### Circuito `transferWithReceipt` (detalhado)

```
1. sender = _sender()                    ← witness (não é parâmetro)
2. canonSender = canonicalize(sender)
3. canonTo = canonicalize(to)
4. senderBal = balanceOf(canonSender)
5. assert(senderBal >= amount)
6. balances[canonSender] -= amount
7. balances[canonTo]    += amount
8. receiptId = nextReceiptId
9. receipts[receiptId] = Receipt { canonTo, amount, requestNonce }
10. nextReceiptId += 1
11. return receiptId                      ← private output (só o caller vê)
```

---

## Fluxo x402

### Atores

| Ator | Responsabilidade |
|---|---|
| **Cliente** | Faz requisições HTTP, paga com WDA via Midnight |
| **Servidor** | Oferece o serviço, gera `requestNonce`, consulta o Facilitador |
| **Facilitador** | Valida pagamentos no ledger Midnight, responde OK/REJEITADO |

### Diagrama

```
┌─────────┐          ┌──────────┐          ┌──────────────┐         ┌──────────────┐
│ Cliente │          │ Servidor │          │  Facilitador  │         │ Midnight     │
│         │          │          │          │  (indexer)    │         │ (ledger)     │
└────┬────┘          └─────┬────┘          └──────┬────────┘         └──────┬───────┘
     │                     │                      │                        │
     │  1. request HTTP    │                      │                        │
     │────────────────────>│                      │                        │
     │                     │                      │                        │
     │  2. requestNonce    │                      │                        │
     │<────────────────────│                      │                        │
     │  (64 hex chars)     │                      │                        │
     │                     │                      │                        │
     │  3. transferWithReceipt(serverID, amount, requestNonce)             │
     │─────────────────────────────────────────────────────────────────────>
     │                     │                      │                        │
     │  4. receiptId       │                      │                        │
     │<─────────────────────────────────────────────────────────────────────
     │                     │                      │                        │
     │  5. { receiptId, requestNonce }            │                        │
     │────────────────────>│                      │                        │
     │                     │                      │                        │
     │                     │  6. { receiptId, requestNonce }               │
     │                     │─────────────────────>│                        │
     │                     │                      │                        │
     │                     │                      │  7. query receipt(id)  │
     │                     │                      │────────────────────────>
     │                     │                      │                        │
     │                     │                      │  8. { to, amount,      │
     │                     │                      │      requestNonce }    │
     │                     │                      │<────────────────────────│
     │                     │                      │                        │
     │                     │  9. OK / REJEITADO   │                        │
     │                     │<─────────────────────│                        │
     │                     │                      │                        │
     │  10. resposta HTTP  │                      │                        │
     │<────────────────────│                      │                        │
     │  (serviço ou erro)  │                      │                        │
```

### Passo a Passo

1. **Cliente** faz requisição HTTP ao **Servidor**
2. **Servidor** gera `requestNonce = crypto.randomBytes(32)` único, envia ao cliente
3. **Cliente** (off-chain) constrói e submete `transferWithReceipt(serverID, amount, requestNonce)` via SDK Midnight
4. O circuito ZK roda, deduz do saldo do cliente, credita o servidor, emite `Receipt`, retorna `receiptId`
5. **Cliente** envia `{ receiptId, requestNonce }` ao **Servidor** (header HTTP ou body)
6. **Servidor** encaminha `{ receiptId, requestNonce }` ao **Facilitador**
7. **Facilitador** consulta `receipt(receiptId)` no indexer Midnight (GraphQL)
8. **Facilitador** valida:
   - `receipt.to == serverID`
   - `receipt.amount >= valor esperado`
   - `receipt.requestNonce == requestNonce` (nunca visto antes)
9. **Facilitador** responde `OK` ou `REJEITADO` ao **Servidor**
10. **Servidor** libera o serviço ou retorna erro

---

## Segurança

### Autenticação

O `sender` em `transferWithReceipt` **não é um parâmetro público**. É derivado do witness `wit_WDASK`, que só o dono da chave secreta consegue fornecer. Um atacante não pode passar um `sender` arbitrário — ao contrário do FungibleToken tradicional onde `from` é um parâmetro.

### Anti-replay

Cada requisição HTTP tem `requestNonce` único. O circuito armazena o nonce no receipt público. O facilitador mantém uma tabela local de nonces já consumidos — se o mesmo `requestNonce` aparecer de novo, rejeita.

Mesmo que o cliente tente reenviar o mesmo `receiptId`, o `requestNonce` já foi consumido.

### Pause (emergência)

O owner pode chamar `pause()` para travar `mint`, `burnFrom` e `transferWithReceipt`. Útil em caso de vulnerabilidade ou migração. Todos os circuits mutáveis chamam `Pausable_assertNotPaused()` no início.

### Burn (owner controla supply)

`burnFrom(account, amount)` permite que o owner queime tokens de **qualquer conta**. Útil para:
- **Compliance**: queimar tokens de endereço comprometido ou irregular
- **Lastro**: quando o usuário resgata o USD subjacente, o owner queima os WDA correspondentes
- **Supply**: `_totalSupply` é decrementado, mantendo o supply consistente

### Ledger público

Todos os receipts são armazenados no ledger on-chain. Qualquer um pode consultar `receipt(id)` e verificar:

```
{
  to:           "0xabcd...server_account_id",
  amount:       10,
  requestNonce: "0xfeed...unique_per_request"
}
```

---

## Facilitador

O facilitador é o único ator que precisa de acesso ao **indexer Midnight** (GraphQL). O servidor e o cliente não precisam rodar nós.

### Infraestrutura — sem container, sem nó

O facilitador **não precisa** rodar um nó Midnight, container Docker, proof server, nem ter wallet/seed.

| Componente | Precisa? | Motivo |
|---|---|---|
| Indexer HTTP (GraphQL) | ✅ Sim | Consulta `contractAction(address)` — estado completo do contrato |
| SDK Midnight | ✅ Sim | Decodificar o blob hex do estado em dados estruturados |
| Proof server | ❌ Não | Só quem **submete** transações precisa |
| Full node / validator | ❌ Não | Indexer já abstrai o chain |
| Wallet / seed / private key | ❌ Não | Só leitura de dados públicos |

Basta um endpoint HTTP do indexer (ex: `http://127.0.0.1:8088/api/v4/graphql`). O facilitador pode rodar num **Raspberry Pi** ou numa **AWS Lambda** — o peso é uma query GraphQL.

**Na devnet local**, o indexer já sobe no `docker-compose.yml`.
**Em produção**, o operador da rede Midnight expõe um endpoint público do indexer.

### Query GraphQL

O indexer expõe `contractAction(address)` que retorna o **estado completo** do contrato como hex blob. O facilitador precisa do SDK Midnight para decodificar:

```graphql
query {
  contractAction(address: "<WDA_CONTRACT_ADDRESS>") {
    state
  }
}
```

A resposta é um hex blob. Para decodificar e extrair o receipt:

```typescript
import { deserialize } from '@midnight-ntwrk/compact-runtime';

// 1. Buscar state no indexer
const res = await fetch('http://127.0.0.1:8088/api/v4/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `{ contractAction(address: "${contractAddress}") { state } }`
  }),
});
const { data } = await res.json();
const stateHex = data.contractAction.state;

// 2. Decodificar com SDK
const decoded = deserialize(stateHex);
const receipts = decoded.ledger.receipts;
const receipt = receipts[receiptId];
```

> ⚠️ O indexer retorna apenas o blob hex. **Não há campos GraphQL estruturados** para cada ledger. O decoder do SDK é obrigatório.

### Validação (pseudocódigo)

```typescript
import { deserialize } from '@midnight-ntwrk/compact-runtime';

const USED_NONCES = new Set<string>();

async function validatePayment(
  receiptId: number,
  requestNonce: string,
  serverId: string,
  expectedAmount: bigint,
  contractAddress: string,
  indexerUrl: string,
): Promise<'OK' | 'REJEITADO'> {
  // 1. Buscar state do contrato no indexer
  const res = await fetch(indexerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ contractAction(address: "${contractAddress}") { state } }`
    }),
  });
  const { data } = await res.json();
  if (!data?.contractAction?.state) return 'REJEITADO';

  // 2. Decodificar blob hex com SDK Midnight
  const decoded = deserialize(data.contractAction.state);
  const receipts = decoded.ledger.receipts;
  const receipt = receipts[receiptId];

  if (!receipt)                              return 'REJEITADO';  // receipt não existe
  if (receipt.to !== serverId)               return 'REJEITADO';  // destino errado
  if (receipt.amount < expectedAmount)       return 'REJEITADO';  // valor insuficiente
  if (receipt.requestNonce !== requestNonce) return 'REJEITADO';  // nonce não corresponde
  if (USED_NONCES.has(requestNonce))         return 'REJEITADO';  // replay detectado

  USED_NONCES.add(requestNonce);
  return 'OK';
}
```

### Requisitos mínimos

- Acesso HTTP ao indexer Midnight (ex: `http://127.0.0.1:8088/api/v4/graphql`)
- SDK Midnight (`@midnight-ntwrk/compact-runtime`) para decodificar o blob hex
- Tabela local de `requestNonce`s consumidos (pode ser Redis, SQLite, etc.)
- Conhecimento do `contractAddress` do WDA e do `serverID` (account ID do servidor)

---

## Deploy

```bash
# Compilar
npm run compile:agent

# Deploy na devnet local
npm run deploy:agent

# Deploy em rede pública
npm run deploy:agent -- --network preview
```

O deploy:
1. Gera chave secreta `secretKey = crypto.randomBytes(32)`
2. Computa `accountId = persistentHash([secretKey])` — esta é a identidade do deployer no contrato
3. Salva o `contractAddress` e `accountId` em `.midnight-state.json`
4. Passa os argumentos do construtor: `"Wrapped Dollar for Agents"`, `"WDA"`, `6`, `eitherAddress(accountId)`

### Construtor

```
constructor(
  _name:      Opaque<"string">,
  _symbol:    Opaque<"string">,
  _decimals:  Uint<8>,
  _initOwner: Either<Bytes<32>, ContractAddress>,
)
```

---

## CLI

```bash
npm run cli:agent
```

### Menu

```
  1. My Account ID              — mostra accountId do deployer
  2. My WDA Balance             — saldo do deployer
  3. Token Info                 — name, symbol, decimals, totalSupply, owner, paused
  4. Mint (owner only)          — criar tokens para um account ID
  5. Burn from account (owner only) — queimar tokens de qualquer conta
  6. Transfer with Receipt      — transferir + emitir receipt (com requestNonce)
  7. Get Receipt (requestNonce) — consultar receipt por ID
  8. Check Another Balance      — saldo de qualquer account ID
  9. Wallet Balance             — tNIGHT e DUST da carteira
  10. Exit
```

### Exemplo de transferência x402

```
> 6
  Recipient account ID (64 hex chars): abcd...1234     ← serverID
  Amount: 10
  Request nonce from server (64 hex chars): feed...5678 ← gerado pelo servidor
  Submitting transfer with receipt...
  ✅ Transfer complete!
  Receipt ID: 3
  Request Nonce: feed...5678
```

---

## Arquivos

| Arquivo | Descrição |
|---|---|
| `contracts/wdollar-agent.compact` | Código fonte do contrato Compact |
| `contracts/managed/wdollar-agent/` | Compilado (ZKIR, keys, contract) |
| `src/deploy-agent.ts` | Script de deploy |
| `src/cli-agent.ts` | CLI interativa |
| `src/network.ts` | Helpers de estado (.midnight-state.json) |
| `docs/WDA.md` | Esta documentação |
