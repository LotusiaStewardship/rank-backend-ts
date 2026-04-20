# RANK Protocol Backend Services – v0.5.0

### **Tested on openSUSE Tumbleweed x86_64 with NodeJS 20.18.0+**

`rank-backend-ts` connects to the Lotus blockchain daemon using NNG (via `nanomsg`) in order to index transactions containing valid RANK/RNKC outputs into PostgreSQL. That indexed state is then exposed through HTTP APIs for wallet/extension/app consumers.

`rank-backend-ts` is designed for high-throughput indexing. During runtime, NNG messages are queued and processed in order to preserve index consistency.

As of v0.1.0, `rank-backend-ts` has been considered stable/performant. `worker_threads` parallelization is intentionally not used right now, but can be revisited if protocol/runtime needs evolve.

**For best indexing performance, run `lotusd`, PostgreSQL, and `rank-backend-ts` on the same host.**

---

## What runs at runtime

The process boots and runs these modules together:

1. **Indexer**
   - Reconciles checkpoint state with chain tip
   - Syncs historical blocks + mempool
   - Subscribes to runtime NNG channels:
     - `mempooltxadd`
     - `mempooltxrem`
     - `blkconnected`
     - `blkdisconctd`

2. **REST API**
   - Express server at `/api/v1`
   - Listens on port `10655`

3. **Push API**
   - Express server at `/push`
   - Listens on port `3001`

4. **Temporal integration**
   - Initialized at startup
   - Some features are workflow/query-backed and require a working Temporal config/server

Startup order is:

1. DB connect → 2. push cache init → 3. indexer init/sync → 4. REST API init → 5. push API init → 6. Temporal init.

Graceful shutdown is handled on `SIGINT` / `SIGTERM`.

---

## Prerequisites

- Configure lotusd (NNG sockets enabled) (refer to [`raipay/chronik` setup instructions](https://github.com/raipay/chronik#setting-up-ecash-or-lotus-node-for-chronik))
- Node.js 20+
- PostgreSQL
- Optional: Temporal server (required for workflow-backed features)

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/LotusiaStewardship/rank-backend-ts.git
cd rank-backend-ts
```

---

## PostgreSQL setup (Linux example)

> These are historical openSUSE instructions preserved from prior docs. Adapt paths/service names for your distro.

1. Install `postgresql-server` using your package manager.
2. Enable password auth on localhost if needed (edit `pg_hba.conf`).
3. Start/restart PostgreSQL.
4. Execute bootstrap SQL:

```bash
sudo -u postgres psql -f install/rank-index.sql
```

`install/rank-index.sql` creates a `lotusrank` role/db/schema. You can also provision DB/role manually.

Then apply Prisma schema:

```bash
npx prisma db push
```

---

## Install / Build / Start

Install dependencies:

```bash
npm install
```

Build TypeScript output to `.output/`:

```bash
npm run build:dev
```

Production build flow:

```bash
npm run build:prod
```

Start service (`.env` loaded by `dotenv-cli` in the start script):

```bash
npm start
```

Start with explicit NNG socket paths:

```bash
npm start -- /absolute/path/to/pub.pipe /absolute/path/to/rpc.pipe
```

If no CLI args are provided, defaults are:

- `~/.lotus/pub.pipe`
- `~/.lotus/rpc.pipe`

---

## Environment variables

Configured via `.env` (see `.env.example` in local checkout).

### Core

| Variable              | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `DATABASE_URL`        | PostgreSQL connection string                              |
| `RANK_GENESIS_HEIGHT` | Genesis height used when DB checkpoint does not yet exist |
| `RANK_GENESIS_HASH`   | Genesis hash paired with `RANK_GENESIS_HEIGHT`            |

### Referral / admin

| Variable          | Description                                   |
| ----------------- | --------------------------------------------- |
| `REFERRAL_SECRET` | HMAC secret used for referral code generation |
| `ADMIN_SECRET`    | Shared secret for admin referral endpoints    |

### Push notifications

| Variable            | Description                |
| ------------------- | -------------------------- |
| `VAPID_SUBJECT`     | Web Push VAPID subject     |
| `VAPID_PUBLIC_KEY`  | Web Push VAPID public key  |
| `VAPID_PRIVATE_KEY` | Web Push VAPID private key |
| `GCM_API_KEY`       | Optional legacy GCM key    |

### Temporal

| Variable                                         | Description                                    |
| ------------------------------------------------ | ---------------------------------------------- |
| `TEMPORAL_HOST`                                  | Temporal address (e.g. `localhost:7233`)       |
| `TEMPORAL_NAMESPACE`                             | Temporal namespace                             |
| `TEMPORAL_TASKQUEUE`                             | Worker task queue                              |
| `TEMPORAL_COMMAND_WORKFLOW_TYPE`                 | Workflow type for command signaling            |
| `TEMPORAL_COMMAND_WORKFLOW_ID`                   | Workflow ID for command signaling              |
| `TEMPORAL_COMMAND_WORKFLOW_SIGNAL`               | Signal name for command signaling              |
| `TEMPORAL_API_CHARTS_WALLET_ACTIVITY`            | Workflow ID queried for wallet activity charts |
| `TEMPORAL_API_CHARTS_WALLET_ACTIVITY_QUERY_TYPE` | Query type prefix used for chart query names   |

> Temporal-backed endpoints/features require this config and a reachable Temporal server.

---

## Runtime logs and event examples

Once the indexer is running, you'll see init messages (`syncBlocks`, `syncMempool`, subscriptions, API listeners):

```text
.. snip ..
2024-11-23T11:21:21.301Z init=syncBlocks status=finished totalBlocks=0 totalRanks=0 elapsed=0.000s
2024-11-23T11:21:21.326Z init=syncMempool txsLength=27 ranksLength=27 action=upsertProfiles elapsed=24.528ms
2024-11-23T11:21:21.326Z init=nng status=subscribed channels=mempooltxadd,mempooltxrem,blkconnected,blkdisconctd
2024-11-23T11:21:21.327Z init=api status=connected httpServer=listening httpServerPort=10655
```

### Example NNG events

```text
# mempooltxadd
2024-11-23T11:23:10.265Z nng=mempooltxadd txid=dabd3946ecf0a01af3792357e6f3c9bf7e98041428c87d32b478f6189b15eaa5 timestamp=1732360990 sats=1000000 sentiment=negative platform=twitter profileId=caincurrency postId=1859129590142153145 action=upsertProfiles elapsed=3.177ms

# mempooltxrem
2024-10-23T15:23:22.453Z nng=mempooltxrem txid=da7ccad023e6b4c9cde8ff6546e21824c2d4a2378807b950c09de43d83bf9530 timestamp=1729696985898 platform=01 profileId=0000000000616c657875676f726a695f sats=1000000 sentiment=00 action=rewindProfiles elapsed=1.199ms

# blkconnected
2024-10-23T15:23:22.457Z nng=blkconnected hash=00000000018ec3f1027a002be790431b05f392b77a6f5d6e6246a39864846ca2 height=883260 timestamp=1729697001 ranksLength=4 action=saveBlock elapsed=3.339ms

# blkdisconctd
2024-11-11T13:20:59.918Z nng=blkdisconctd hash=000000000205072f83f59100bda1dd1c29763c703a447ae22b75a7ef4ec62683 height=895465 timestamp=1731331231 ranksLength=0 txsLength=0 action=rewindBlock elapsed=1.872ms
```

### NNG Event Field Index (current runtime)

> Note: `nng=*` log fields are event-specific; not every field appears on every event.

| Field              | Appears in                                     | Description                                                                                                            |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `nng=`             | all NNG logs                                   | NNG event type (`mempooltxadd`, `mempooltxrem`, `blkconnected`, `blkdisconctd`, or `warn`)                             |
| `txid=`            | `mempooltxadd`, `mempooltxrem`                 | Transaction ID tied to the mempool event                                                                               |
| `hash=`            | `blkconnected`, `blkdisconctd`                 | Block hash                                                                                                             |
| `height=`          | `blkconnected`, `blkdisconctd`                 | Block height                                                                                                           |
| `timestamp=`       | `blkconnected`, `blkdisconctd`                 | Block header timestamp                                                                                                 |
| `ranksLength=`     | `mempooltxadd`, `blkconnected`, `blkdisconctd` | Count of parsed RANK outputs for that event context                                                                    |
| `rnkcsLength=`     | `blkconnected`, `blkdisconctd`                 | Count of parsed RNKC outputs for that block context                                                                    |
| `isComment=`       | `mempooltxadd`                                 | Whether an RNKC comment payload was detected in the tx (`true`/`false`)                                                |
| `outpointsLength=` | `mempooltxrem`                                 | Number of cached outpoints removed for that txid                                                                       |
| `txsLength=`       | `blkdisconctd`                                 | Number of transactions rewound when disconnecting the block                                                            |
| `action=`          | all NNG logs                                   | Handler action performed (e.g. `upsertProfiles`, `rewindProfiles`, `saveBlock`, `rewindBlock`, `checkFaucetMilestone`) |
| `elapsed=`         | success-path NNG handlers                      | Processing time for the logged action                                                                                  |
| `scriptPayload=`   | `nng=warn` (faucet milestone check)            | Wallet script payload associated with the warning                                                                      |
| `message=`         | `nng=warn`                                     | Warning/error message text                                                                                             |

---

## API / specs / utility scripts

- HTTP API reference: [`docs/API.md`](./docs/API.md)
- Protocol specs:
  - [`docs/spec/RANK.md`](./docs/spec/RANK.md)
  - [`docs/spec/RNKC.md`](./docs/spec/RNKC.md)
  - [`docs/spec/RNKE.md`](./docs/spec/RNKE.md)

Backfill wallet engagement data:

```bash
npx tsx scripts/backfill-engagement.ts
```

(Backfill script is idempotent and safe to re-run.)
