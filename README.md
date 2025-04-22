# RANK Protocol Backend Services – v0.3.0

### **Tested on openSUSE Tumbleweed x86_64 with NodeJS 20.18.0+**

`rank-backend-ts` connects to the Lotus blockchain daemon using NNG (via npm `nanomsg` library) in order to index all transactions containing a valid RANK output. RANK outputs are indexed into a PostgreSQL database. Retrieving records from this database is made possible by the built-in REST API library.

`rank-backend-ts` is _fast_. Benchmarks performed on moderate hardware show a transaction processing rate of over 6,900 RANK tx/s during initial sync. During runtime, the indexer will queue NNG messages and process them in the order they were received, ensuring the state of the index remains intact.

As of v0.1.0, `rank-backend-ts` is considered **stable** and **performant**. Implementing parallelization through `worker_threads` isn't planned at this time, but we will revist `worker_threads` in the future if the RANK protocol evolves and requires the indexer to evolve with it.

**\*\*\*** **For best indexing performance, run lotusd, PostgreSQL, and `rank-backend-ts` on the same host**

# Prerequisites

- Configure lotusd – refer to [`raipay/chronik` setup instructions](https://github.com/raipay/chronik#setting-up-ecash-or-lotus-node-for-chronik)
- Clone `rank-backend-ts` repo:

  ```
  git clone --recurse-submodules https://github.com/LotusiaStewardship/rank-backend-ts.git
  ```

### PostgreSQL - Linux

**NOTE: These instructions were tested on openSUSE Tumbleweed and are working as of October 23, 2024**

1. Install `postgresql-server` using your system's package manager (package name may differ depending on your distribution)
2. Open a terminal **with `root` privileges** and change to the directory where you cloned `rank-backend-ts`
3. Enable password authentication on PostgreSQL for localhost (if not already enabled):

   ```
   sudo -u postgres sed -rn -i.bak 'p; s/(host\s+all.*127\.0\.0\.1\/32\s+)password!/\1password/p' /var/lib/pgsql/data/pg_hba.conf
   ```

4. Start (or restart) PostgreSQL service:

   ```
   systemctl restart postgresql.service
   ```

   You should see that the sevice is `active (running)`

   ```
   ● postgresql.service - PostgreSQL database server
       Loaded: loaded (/usr/lib/systemd/system/postgresql.service; enabled; preset: disabled)
       Active: active (running) since Fri 2024-10-18 10:18:46 CDT; 4 days ago
   ```

5. Execute the database setup script:
   ```
   sudo -u postgres psql -f install/rank-index.sql
   ```

\*\*\* **IMPORTANT: The location of `pg_hba.conf` will vary depending on your distribution**

# Install – Docker

**COMING SOON**

# Install – Linux / macOS

**NOTE: There is currently no plan to support Windows**

1. Open a terminal and change to the directory where you cloned `rank-backend-ts`
2. Install prod and dev dependencies:

   ```
   npm install --include=dev
   ```

3. Apply Prisma schema to PostgreSQL and generate runtime client artifacts:

   ```
   npx prisma db push
   ```

4. Clean install to remove dev dependencies (`omit=dev` is defined in `.npmrc`):

   ```
   npm clean-install
   ```

5. Start the indexer:

   ```
   npx tsc && node scripts/start [pub socket path] [rpc socket path]
   ```

   Example:

   ```
   npx tsc && node scripts/start ~/.lotus/pub.pipe ~/.lotus/rpc.pipe
   ```

   **NOTE: If no command-line arguments are provided, the indexer will attempt to connect to `ipc://~/.lotus/pub.pipe` and `ipc://~/.lotus/rpc.pipe`**

# Runtime

Once the indexer is running, you will begin to see scrolling messages with `init=syncBlocks`. After the initial block sync, the mempool will be synced and the NNG sub socket will begin listening for new events.

```
.. snip ..
2024-11-23T11:21:21.301Z init=syncBlocks status=finished totalBlocks=0 totalRanks=0 elapsed=0.000s
2024-11-23T11:21:21.326Z init=syncMempool txsLength=27 ranksLength=27 action=upsertProfiles elapsed=24.528ms
2024-11-23T11:21:21.326Z init=nng status=subscribed channels=mempooltxadd,mempooltxrem,blkconnected,blkdisconctd
2024-11-23T11:21:21.327Z init=api status=connected httpServer=listening httpServerPort=10655
```

### Example NNG events

```
# mempooltxadd
2024-11-23T11:23:10.265Z nng=mempooltxadd txid=dabd3946ecf0a01af3792357e6f3c9bf7e98041428c87d32b478f6189b15eaa5 timestamp=1732360990 sats=1000000 sentiment=negative platform=twitter profileId=caincurrency postId=1859129590142153145 action=upsertProfiles elapsed=3.177ms

# mempooltxrem
2024-10-23T15:23:22.453Z nng=mempooltxrem txid=da7ccad023e6b4c9cde8ff6546e21824c2d4a2378807b950c09de43d83bf9530 timestamp=1729696985898 platform=01 profileId=0000000000616c657875676f726a695f sats=1000000 sentiment=00 action=rewindProfiles elapsed=1.199ms

# blkconnected
2024-10-23T15:23:22.457Z nng=blkconnected hash=00000000018ec3f1027a002be790431b05f392b77a6f5d6e6246a39864846ca2 height=883260 timestamp=1729697001 ranksLength=4 action=saveBlock elapsed=3.339ms

# blkdisconctd
2024-11-11T13:20:59.918Z nng=blkdisconctd hash=000000000205072f83f59100bda1dd1c29763c703a447ae22b75a7ef4ec62683 height=895465 timestamp=1731331231 ranksLength=0 txsLength=0 action=rewindBlock elapsed=1.872ms
```

### NNG Event Field Index

| Field          | Description                                                     |
| -------------- | --------------------------------------------------------------- |
| `nng=`         | Indicates an NNG event and which type                           |
| `txid=`        | txid containing the RANK output                                 |
| `hash=`        | Block hash                                                      |
| `height=`      | Block height                                                    |
| `ranksLength=` | Number of RANK outputs in the block                             |
| `txsLength=`   | Number of total transactions in the block                       |
| `timestamp=`   | If mempool, current time; if block, timestamp in block header   |
| `platform=`    | String indicating target platform (e.g. `twitter`)              |
| `profileId=`   | String of profile name, decoded from hex                        |
| `sentiment=`   | String indicating sentiment (e.g. `positive`, `negative`, etc.) |
| `sats=`        | Number of satoshis burned in the RANK output                    |
| `action=`      | Indexer action taken for the init stage or received NNG message |
| `elapsed=`     | Time taken to process the `action=`                             |
