# Rank Backend API Documentation

This document describes the HTTP API endpoints provided by the Rank Backend service. The API is built on Express.js and provides endpoints for querying profile/post rankings, statistics, wallet activity, and more.

**Base URL:** `/api/v1`

---

## Table of Contents

- [Authentication](#authentication)
- [Common Types](#common-types)
- [GET Endpoints](#get-endpoints)
- [POST Endpoints](#post-endpoints)
- [PATCH Endpoints](#patch-endpoints)
- [Temporal Workflows](#temporal-workflows)
- [Error Responses](#error-responses)

---

## Authentication

Certain endpoints require authentication via a `BlockDataSig` scheme. The authorization header must include:

```
Authorization: BlockDataSig blockhash=<hash>, blockheight=<height>
```

Authenticated endpoints will return a `401 Unauthorized` with an authentication challenge if credentials are invalid or missing.

---

## Common Types

### ScriptChunkPlatformUTF8

Platform identifier (e.g., `'twitter'`, `'youtube'`, `'github'`). Validated against `PlatformConfiguration`.

### ScriptChunkSentimentUTF8

Sentiment value: `'positive'`, `'negative'`, or `'neutral'`.

### Timespan

Time range specifier:

- `'now'` - Current timestamp
- `'today'` - Start of current UTC day
- `'day'` - Last 24 hours
- `'week'` - Last 7 days
- `'month'` - Last 30 days
- `'quarter'` - Last 90 days
- `'all'` - All time

### TargetEntityMetricsAPI

```typescript
{
  ranking: string // Ranking score as string
  satsPositive: string // Positive sats as string
  satsNegative: string // Negative sats as string
  votesPositive: number // Total positive votes
  votesNegative: number // Total negative votes
}
```

### RankTopProfile

```typescript
{
  platform: ScriptChunkPlatformUTF8;
  profileId: string;         // Profile identifier
  postId?: string;           // Post identifier (only for posts)
  total: {
    ranking: string;         // Total ranking score
    satsPositive: string;    // Total positive sats
    satsNegative: string;    // Total negative sats
    votesPositive: number;   // Total positive votes
    votesNegative: number;   // Total negative votes
  };
  changed: {
    ranking: string;         // Change in ranking
    rate: string;            // Rate of change percentage
    satsPositive: string;    // New positive sats
    satsNegative: string;    // New negative sats
    votesPositive: number;   // New positive votes
    votesNegative: number;   // New negative votes
  };
  votesTimespan: string[] | null;  // Array of txids or null
}
```

### RankTopPost

Extends `RankTopProfile` (identical structure, used for posts).

### ProfileAPI

```typescript
{
  id: string;
  platform: ScriptChunkPlatformUTF8;
  ranking: string;
  satsPositive: string;
  satsNegative: string;
  votesPositive: number;
  votesNegative: number;
  ranks?: IndexedTransactionRANK[];
  comments?: PostAPI[];
  voters?: Voter[];
  profileMeta?: VoterProfileMetadata;
}
```

### PostAPI

```typescript
{
  id: string;
  platform: ScriptChunkPlatformUTF8;
  profileId: string;
  profile: TargetEntityMetricsAPI & { profileMeta?: VoterProfileMetadata };
  ranking: string;
  satsPositive: string;
  satsNegative: string;
  votesPositive: number;
  votesNegative: number;
  data?: string;             // Post content (Lotusia posts)
  inReplyToPlatform?: ScriptChunkPlatformUTF8;
  inReplyToProfileId?: string;
  inReplyToPostId?: string;
  firstSeen?: string;
  timestamp?: string;
  ranks?: IndexedTransactionRANK[];
  comments?: PostAPI[];
  postMeta?: VoterPostMetadata;
}
```

### IndexedTransactionRANKAPI

```typescript
{
  // ... PrismaRANK fields
  txid: string
  outIdx: number
  platform: ScriptChunkPlatformUTF8
  profileId: string
  postId: string | null
  scriptPayload: string
  sentiment: ScriptChunkSentimentUTF8
  firstSeen: string // ISO timestamp
  timestamp: string | null // ISO timestamp
  sats: string // Formatted as string
  date: string // ISO-formatted date
}
```

### Voter

```typescript
{
  voterId: string // 20-byte P2PKH hex
  ranking: string
  satsPositive: string
  satsNegative: string
  votesPositive: number
  votesNegative: number
  votesNeutral: number
}
```

### VoterProfileMetadata

```typescript
{
  hasWalletUpvoted: boolean
  hasWalletDownvoted: boolean
}
```

### VoterPostMetadata

```typescript
{
  hasWalletUpvoted: boolean;
  hasWalletDownvoted: boolean;
  satsUpvoted: string;
  satsDownvoted: string;
  txidsUpvoted: string[];
  txidsDownvoted: string[];
}
```

### FeedResponse

```typescript
{
  posts: PostAPI[];
  pagination: {
    page: number;
    pageSize: number;
    totalPages: number;
    totalItems: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}
```

### ChartWalletSummary

```typescript
{
  totalVotes: number // Total votes cast
  totalUpvotes: number // Total upvotes
  totalDownvotes: number // Total downvotes
  totalUniqueWallets: number // Unique voting wallets
  totalSatsBurned: number // Total Lotus burned
}
```

### VoterActivitySummary

```typescript
{
  scriptPayload: string
  totalVotes: number
  totalSats: string
  lastSeen: string // ISO timestamp
  firstSeen: string // ISO timestamp
}
```

### WalletRankActivityWorkflowResult

```typescript
{
  totalVotes: number // Total votes
  totalPayoutsSent: number // Total payouts
  totalPayoutAmount: number // Total sats sent
}
```

### ProfilesResponse

```typescript
{
  profiles: ProfileAPI[];
  numPages: number;
}
```

### PostsResponse

```typescript
{
  posts: PostAPI[];
  numPages: number;
}
```

### PlatformPostsResponse

```typescript
{
  platform: ScriptChunkPlatformUTF8;
  posts: PostAPI[];
}
```

### VotesResponse

```typescript
{
  votes: IndexedTransactionRANKAPI[] | VoteActivityAPI[];
  numPages: number;
}
```

### VoteActivityAPI

```typescript
{
  platform: ScriptChunkPlatformUTF8
  profileId: string
  postId: string | null
  scriptPayload: string
  txid: string
  firstSeen: string
  sentiment: ScriptChunkSentimentUTF8
  timestamp: string | null
  sats: string
}
```

---

## GET Endpoints

### GET `/api/v1/feed/posts`

Retrieves a paginated feed of posts with profile data, rankings, RNKC comment content, and reply threads. This is the primary unified feed endpoint.

**Query Parameters:**

- `platform` (optional): Filter by platform (e.g., `twitter`, `lotusia`)
- `sortBy` (optional): Sort mode — `ranking` (default), `recent`, or `controversial`
- `startTime` (optional): Time filter — only posts with votes in this window (e.g., `day`, `week`, `month`, `all`)
- `page` (optional): Page number (default: 1)
- `pageSize` (optional): Items per page (default: 20, max: 20)
- `scriptPayload` (optional): Wallet P2PKH hex — includes Vote-to-Reveal (R1) `postMeta` in response

**Response:** `FeedResponse` — `{ posts: PostAPI[], pagination: { page, pageSize, totalPages, totalItems, hasNext, hasPrev } }`

Each `PostAPI` includes:

- Post ranking metrics (`ranking`, `satsPositive`, `satsNegative`, `votesPositive`, `votesNegative`)
- Parent `profile` metrics
- Lotusia post content (`data`, `inReplyTo*`, `timestamp`, `firstSeen`) when applicable
- Reply threads (`comments: PostAPI[]`)
- Wallet vote metadata (`postMeta`) when `scriptPayload` is provided

**Examples:**

```bash
GET /api/v1/feed/posts?sortBy=ranking&pageSize=20
GET /api/v1/feed/posts?platform=lotusia&sortBy=recent&startTime=week
GET /api/v1/feed/posts?sortBy=controversial&scriptPayload=abc123...
```

### GET `/api/v1/feed/trending/:windowHours?/:limit?`

Retrieves trending posts based on recent vote activity volume. Returns full `PostAPI` objects ordered by activity count.

**Path Parameters:**

- `windowHours` (optional): Time window in hours (default: 24)
- `limit` (optional): Maximum results (default: 20)

**Query Parameters:**

- `scriptPayload` (optional): Wallet P2PKH hex — includes Vote-to-Reveal `postMeta`

**Response:** `PostAPI[]`

**Examples:**

```bash
GET /api/v1/feed/trending/24/10
GET /api/v1/feed/trending/6/20?scriptPayload=abc123...
```

### GET `/api/v1/feed/leaderboard/:period/:limit?`

Retrieves a leaderboard of top voters ranked by total sats burned in a period, enriched with engagement data.

**Path Parameters:**

- `period`: Time period (`daily` or `weekly`)
- `limit` (optional): Maximum entries (default: 20, max: 100)

**Response:**

```typescript
Array<{
  rank: number
  scriptPayload: string
  totalVotes: number
  totalBurned: string
  tier: number
  currentStreak: number
  engagementPoints: number
}>
```

**Examples:**

```bash
GET /api/v1/feed/leaderboard/daily/10
GET /api/v1/feed/leaderboard/weekly
```

### GET `/api/v1/profiles/:page?/:pageSize?`

Retrieve a paginated list of all profiles.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| page | number | No | Page number (default: 1) |
| pageSize | number | No | Items per page, max 40 (default: 10) |

**Returns:** `ProfilesResponse`

**Example:**

```http
GET /api/v1/profiles/1/20
```

---

### GET /:platform/:profileId

Retrieve a specific profile's ranking information.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| platform | ScriptChunkPlatformUTF8 | Yes | Social media platform |
| profileId | string | Yes | Profile identifier |

**Returns:** `ProfileAPI`

**Example:**

```http
GET /api/v1/twitter/elonmusk
```

---

### GET /:platform/:profileId/posts/:page?/:pageSize?

Retrieve posts for a specific profile.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| platform | ScriptChunkPlatformUTF8 | Yes | Social media platform |
| profileId | string | Yes | Profile identifier |
| page | number | No | Page number (default: 1) |
| pageSize | number | No | Items per page, max 40 (default: 10) |

**Returns:** `PostsResponse`

---

### GET /:platform/:profileId/:postId

Retrieve a specific post.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| platform | ScriptChunkPlatformUTF8 | Yes | Social media platform |
| profileId | string | Yes | Profile identifier |
| postId | string | Yes | Post identifier |

**Returns:** `PostAPI`

---

### GET /:platform/:profileId/:postId/:scriptPayload

Retrieve a post with voter metadata (requires authentication).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| platform | ScriptChunkPlatformUTF8 | Yes | Social media platform |
| profileId | string | Yes | Profile identifier |
| postId | string | Yes | Post identifier |
| scriptPayload | string | Yes | P2PKH script payload (20-byte hex) |

**Headers:**
| Name | Value |
|------|-------|
| Authorization | `BlockDataSig blockhash=<hash>, blockheight=<height>` |

**Returns:** `PostAPI` (with `postMeta` field)

---

### GET /txs/:platform/:profileId/:page?/:pageSize?

Retrieve vote transactions for a profile.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| platform | ScriptChunkPlatformUTF8 | Yes | Social media platform |
| profileId | string | Yes | Profile identifier |
| page | number | No | Page number (default: 1) |
| pageSize | number | No | Items per page, max 40 (default: 10) |

**Returns:** `VotesResponse` (votes contain `post` with `id` and `ranking` fields)

---

### GET /stats/:statsRoute/:timespan?/:votes?/:pageNum?

Retrieve ranking statistics.

**Stats Routes:**
| Route | Description |
|-------|-------------|
| `profiles/top-ranked` | Top ranked profiles |
| `profiles/lowest-ranked` | Lowest ranked profiles |
| `posts/top-ranked` | Top ranked posts |
| `posts/lowest-ranked` | Lowest ranked posts |

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| statsRoute | string | Yes | One of the routes above |
| timespan | Timespan | No | Time range (default: 'day') |
| votes | 'includeVotes' | No | Include vote details |
| pageNum | number | No | Page number for pagination (default: 0) |

**Returns:** `RankTopProfile[]` or `RankTopPost[]`

**Examples:**

```http
GET /api/v1/stats/profiles/top-ranked/week
GET /api/v1/stats/posts/top-ranked/month/includeVotes/0
```

---

### GET /search/:searchType/:query

Search for profiles or posts.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| searchType | 'profile' \| 'post' | Yes | Type of search |
| query | string | Yes | Search query (min 2 characters) |

**Returns:** `ProfileAPI[]` or `PostAPI[]`

---

### GET /charts/:chartType/:dataType/:timespan?

Retrieve chart data.

**Chart Types:**
| Type | Description |
|------|-------------|
| `wallet` | Wallet-related charts |

**Data Types:**
| Type | Description |
|------|-------------|
| `activity` | Wallet activity over time |
| `summary` | Wallet summary statistics |

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| chartType | ChartType | Yes | Type of chart |
| dataType | ChartDataType | Yes | Type of data |
| timespan | Timespan | No | Time range (default: 'day') |

**Returns:**

- Activity: `WalletRankActivityWorkflowResult`
- Summary: `ChartWalletSummary`

**Examples:**

```http
GET /api/v1/charts/wallet/activity/week
GET /api/v1/charts/wallet/summary/month
```

---

### GET /wallet/:instanceId/:scriptPayload/:startTime?/:endTime?

Retrieve wallet activity (requires authentication).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| instanceId | string | Yes | 64-char hex instance ID |
| scriptPayload | string | Yes | P2PKH script payload (20-byte hex) |
| startTime | Timespan | No | Start time (default: 'today') |
| endTime | Timespan | No | End time (default: 'now') |

**Headers:**
| Name | Value |
|------|-------|
| Authorization | `BlockDataSig blockhash=<hash>, blockheight=<height>` |

**Returns:** `VoterActivityAPI[]`

---

### GET /wallet/summary/:instanceId/:scriptPayload/:startTime?/:endTime?

Retrieve wallet activity summary (requires authentication).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| instanceId | string | Yes | 64-char hex instance ID |
| scriptPayload | string | Yes | P2PKH script payload (20-byte hex) |
| startTime | Timespan | No | Start time (default: 'day') |
| endTime | Timespan | No | End time (default: 'today') |

**Headers:**
| Name | Value |
|------|-------|
| Authorization | `BlockDataSig blockhash=<hash>, blockheight=<height>` |

**Returns:** `VoterActivitySummary[]`

---

### GET /votes/:page?/:pageSize?

Retrieve global vote activity.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| page | number | No | Page number (default: 1) |
| pageSize | number | No | Items per page, max 40 (default: 10) |

**Returns:** `VotesResponse`

---

## POST Endpoints

### POST /posts/:platform/:scriptPayload

Retrieve multiple posts by their IDs (batch request).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| platform | ScriptChunkPlatformUTF8 | Yes | Social media platform |
| scriptPayload | string | Yes | P2PKH script payload |

**Headers:**
| Name | Value |
|------|-------|
| Content-Type | `application/json` |

**Request Body:**

```typescript
Array<{
  profileId: string
  postId: string
}>
```

**Returns:** `PlatformPostsResponse`

**Example:**

```http
POST /api/v1/posts/twitter/<scriptPayload>
Content-Type: application/json

[
  { "profileId": "elonmusk", "postId": "123456" },
  { "profileId": "naval", "postId": "789012" }
]
```

---

### POST /instance/register (Not Implemented)

Register a new extension instance. Currently commented out.

**Request Body:**

```typescript
{
  instanceId: string // 64-char hex
  createdAt: string // ISO date string
  runtimeId: string
  startTime: string
  nonce: number
  scriptPayload: string // 20-byte hex
  signature: string // Message signature
}
```

---

## PATCH Endpoints

### PATCH /:platform/:profileId/:postId

Update post content. Currently stubbed (not implemented).

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| platform | ScriptChunkPlatformUTF8 | Yes | Social media platform |
| profileId | string | Yes | Profile identifier |
| postId | string | Yes | Post identifier |

**Request Body:**

```typescript
{
  content: string
}
```

---

## Temporal Workflows

The API integrates with Temporal for background workflow execution. The following activities are available:

### Workflow Activities

| Activity                       | Description                                  |
| ------------------------------ | -------------------------------------------- |
| `listWorkflows`                | List all workflows matching a SQL-like query |
| `resultWorkflow`               | Get the result of a workflow execution       |
| `queryWorkflow`                | Query a running workflow                     |
| `startWorkflow`                | Start a new workflow                         |
| `signalWithStart`              | Signal and start a workflow                  |
| `getWalletRankActivity`        | Get wallet rank activity                     |
| `getWalletRankActivitySummary` | Get wallet activity summary                  |
| `getAllTimeTopRankedProfiles`  | Get all-time top profiles                    |
| `getTopRankedProfiles`         | Get top profiles for timespan                |
| `getTopRankedPosts`            | Get top posts for timespan                   |

---

## Error Responses

### HTTP Status Codes

| Status           | Description             |
| ---------------- | ----------------------- |
| 200 OK           | Request successful      |
| 400 Bad Request  | Invalid parameters      |
| 401 Unauthorized | Authentication required |
| 404 Not Found    | Resource not found      |

### Error Response Format

```typescript
{
  error: string;
  params?: Record<string, unknown>;
}
```

### Common Error Messages

| Message                           | Cause                                |
| --------------------------------- | ------------------------------------ |
| `invalid platform specified`      | Unknown platform                     |
| `invalid profileId specified`     | Malformed profile ID                 |
| `postId is invalid format`        | Post ID doesn't match platform regex |
| `invalid instanceId specified`    | Instance ID not 64 hex chars         |
| `invalid scriptPayload specified` | Script payload not 20 bytes          |
| `invalid txid specified`          | TXID not 64 hex chars                |
| `invalid content type`            | POST without application/json        |

---

## Parameter Validation

### Platform Validation

- Converted to lowercase
- Must exist in `PlatformConfiguration`

### ProfileId Validation

- Converted to lowercase
- Must be valid for the platform (via `toProfileIdBuf`)

### PostId Validation

- Converted to lowercase
- Must match platform-specific regex
- For `BigInt` types: must be valid hex with correct length

### ScriptPayload Validation

- Must be valid 20-byte hex string (P2PKH hash)

### InstanceId Validation

- Must be 64-character hexadecimal string

### TXID Validation

- Must be 64-character hexadecimal string

### Page Size Limits

- Maximum page size: 40 items
- Values > 40 are clamped to 40

---

_Generated from `/home/matthew/Documents/Code/rank-backend-ts/lib/api.ts`_
