# RANK Protocol Specification

## Overview

The **RANK** protocol is a Lotus OP_RETURN-based protocol for expressing sentiment (positive, negative, or neutral) toward online identities. It uses the LOKAD prefix `0x52414e4b` ("RANK" in ASCII) to identify transactions that implement this protocol.

The RANK protocol enables users to burn XPI (Lotus currency) to establish verifiable, cost-based reputation signals. This creates a Proof-of-Burn mechanism where reputation cannot be manipulated without continuous monetary expenditure.

## LOKAD Prefix

- **Prefix**: `0x52414e4b` (4 bytes, big-endian)
- **ASCII Representation**: "RANK"
- **Version**: v1

## Transaction Structure

A RANK transaction consists of one or more OP_RETURN outputs. Each output encodes a single ranking vote.

### Output Format (Minimum)

```
[OP_RETURN] [PUSH 4] [LOKAD] [SENTIMENT] [PUSH 1] [PLATFORM] [PUSH N] [PROFILE_ID]
```

### Output Format (With Post ID)

```
[OP_RETURN] [PUSH 4] [LOKAD] [SENTIMENT] [PUSH 1] [PLATFORM] [PUSH N] [PROFILE_ID] [PUSH M] [POST_ID]
```

### Byte-Level Breakdown

| Offset | Length   | Field        | Description                                               |
| ------ | -------- | ------------ | --------------------------------------------------------- |
| 0      | 1        | OP_RETURN    | `0x6a` - OP_RETURN opcode                                 |
| 1      | 1        | PUSH OP      | `0x04` - Push 4 bytes                                     |
| 2-5    | 4        | LOKAD Prefix | `0x52414e4b` - "RANK"                                     |
| 6      | 1        | Sentiment    | `0x00` (negative), `0x51` (positive), or `0x60` (neutral) |
| 7      | 1        | PUSH OP      | `0x01` - Push 1 byte                                      |
| 8      | 1        | Platform     | Platform identifier (see Platform Codes)                  |
| 9      | 1        | PUSH OP      | Platform-specific profile ID length                       |
| 10+    | Variable | Profile ID   | Platform-specific profile identifier                      |
| ...    | 1        | PUSH OP      | Post ID length (optional)                                 |
| ...    | Variable | Post ID      | Platform-specific post identifier (optional)              |

## Sentiment Codes

Sentiment is encoded as a single byte using Bitcoin Script opcodes:

| Sentiment | Opcode | Hex Value | Description                    |
| --------- | ------ | --------- | ------------------------------ |
| Negative  | OP_0   | `0x00`    | Negative sentiment / downvote  |
| Positive  | OP_1   | `0x51`    | Positive sentiment / upvote    |
| Neutral   | OP_16  | `0x60`    | Neutral sentiment / no opinion |

## Platform Codes

Platforms are identified by a single byte code:

| Platform  | Code | Hex Value | Profile ID Format               | Post ID Format            |
| --------- | ---- | --------- | ------------------------------- | ------------------------- |
| Lotusia   | 0    | `0x00`    | 20-byte P2PKH address (hex)     | 32-byte SHA256 hash (hex) |
| Twitter/X | 1    | `0x01`    | 1-16 character username (UTF-8) | 64-bit unsigned integer   |

### Platform Configuration Details

#### Lotusia Platform

- **Profile ID Length**: 20 bytes (40 hex characters)
- **Profile ID Format**: Hexadecimal representation of a Bitcoin Cash P2PKH address
- **Profile ID Regex**: `/^[0-9a-fA-F]{40}$/`
- **Post ID Length**: 32 bytes (64 hex characters)
- **Post ID Format**: Hexadecimal representation of a SHA256 hash
- **Post ID Regex**: `/^[0-9a-f]{64}$/`

Example Profile ID: `1234567890abcdef1234567890abcdef12345678`

#### Twitter/X Platform

- **Profile ID Length**: 16 bytes (padded with null bytes if shorter)
- **Profile ID Format**: UTF-8 encoded username (1-16 characters)
- **Profile ID Regex**: `/^[a-z0-9_]{1,16}$/`
- **Post ID Length**: 8 bytes
- **Post ID Format**: 64-bit unsigned integer (big-endian)
- **Post ID Regex**: `/^[0-9]+$/`

Example Profile ID: `elonmusk` (padded to 16 bytes: `\x00\x00\x00\x00\x00\x00\x00\x00elonmusk`)
Example Post ID: `1234567890123456789` (encoded as 8-byte big-endian integer)

## Multiple Outputs

A single RANK transaction can contain multiple OP_RETURN outputs (up to 3 outputs at indices 0, 1, and 2). Each output represents a separate ranking vote and is processed independently.

### Multi-Output Example

```
Output 0: OP_RETURN [RANK data for profile A]
Output 1: OP_RETURN [RANK data for profile B]
Output 2: OP_RETURN [RANK data for profile C]
```

Each output must:

- Be a valid OP_RETURN script
- Contain a valid RANK LOKAD prefix
- Meet minimum satoshi requirements (see Validation Rules)

## Validation Rules

### Required Fields

- **Sentiment**: Must be one of: `0x00` (negative), `0x51` (positive), `0x60` (neutral)
- **Platform**: Must be a supported platform code (0 or 1)
- **Profile ID**: Must match platform-specific format and length requirements
- **Post ID**: Optional, but if provided, must match platform-specific format and length requirements

### Satoshi Requirements

- **Output 0 (Primary)**: Minimum 1,000,000 satoshis (1 XPI)
- **Output 1-2 (Secondary)**:
  - Neutral sentiment: 0 satoshis required
  - Positive/Negative sentiment: Minimum 1,000,000 satoshis (1 XPI)

### Script Length

- **Minimum**: 10 bytes (without post ID)
- **Maximum**: Variable (depends on platform and optional fields)

### Encoding Rules

- **Profile ID**: Must be properly padded to platform-specific length
- **Post ID**: Must be properly encoded according to platform specifications
- **Sentiment**: Must be a valid opcode

## Example Transactions

### Example 1: Positive Vote for Twitter Profile (No Post ID)

```
6a 04 52414e4b 51 01 10 0000000000000000656c6f6e6d75736b
```

Breakdown:

- `6a` - OP_RETURN
- `04` - Push 4 bytes
- `52414e4b` - RANK prefix
- `51` - Positive sentiment (OP_1)
- `01` - Push 1 byte
- `01` - Twitter platform
- `10` - Push 16 bytes (profile ID length)
- `0000000000000000656c6f6e6d75736b` - Profile ID (16 bytes, UTF-8 padded)

### Example 2: Negative Vote for Lotusia Profile with Post ID

```
6a 04 52414e4b 00 01 00 14 1234567890abcdef1234567890abcdef12345678 20 abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

Breakdown:

- `6a` - OP_RETURN
- `04` - Push 4 bytes
- `52414e4b` - RANK prefix
- `00` - Negative sentiment (OP_0)
- `01` - Push 1 byte
- `00` - Lotusia platform
- `14` - Push 20 bytes (profile ID length)
- `1234567890abcdef1234567890abcdef12345678` - Profile ID (20 bytes)
- `20` - Push 32 bytes (post ID length)
- `abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890` - Post ID (32 bytes)

### Example 3: Neutral Vote for Twitter Profile

```
6a 04 52414e4b 60 01 01 10 0000000000000000656c6f6e6d75736b
```

Breakdown:

- `6a` - OP_RETURN
- `04` - Push 4 bytes
- `52414e4b` - RANK prefix
- `60` - Neutral sentiment (OP_16)
- `01` - Push 1 byte
- `01` - Twitter platform
- `10` - Push 16 bytes (profile ID length)
- `0000000000000000656c6f6e6d75736b` - Profile ID (16 bytes, padded)

## Economic Model

### Proof-of-Burn

The RANK protocol implements a Proof-of-Burn economic model where:

1. **Cost Signal**: Users must burn XPI to create ranking votes
2. **Reputation Accumulation**: Profiles accumulate reputation based on total satoshis burned in their favor
3. **Manipulation Resistance**: Continuous expenditure is required to maintain or increase reputation
4. **Verification**: All votes are cryptographically verifiable on the blockchain

### Satoshi Tracking

The indexer tracks:

- **Total satoshis burned per profile** (aggregated across all votes)
- **Positive sentiment satoshis** (votes with positive sentiment)
- **Negative sentiment satoshis** (votes with negative sentiment)
- **Vote count** (number of votes per sentiment)

## Processing Rules

### Indexing

The rank-backend-ts indexer processes RANK transactions according to these rules:

1. **Transaction Discovery**: Scan all transactions for OP_RETURN outputs
2. **LOKAD Validation**: Verify LOKAD prefix is `0x52414e4b`
3. **Script Validation**: Validate all required fields and encoding
4. **Multi-Output Processing**: Process outputs 0, 1, and 2 independently
5. **Database Storage**: Store validated transactions in the database

### Mempool Handling

- **Unconfirmed Transactions**: Cached in memory with timestamp
- **Confirmation**: Moved to persistent storage when included in a block
- **Reorg Handling**: Transactions are rewound if blocks are disconnected

### State Management

The indexer maintains:

- **Profile Rankings**: Aggregated sentiment and satoshi counts per profile
- **Post Rankings**: Aggregated sentiment and satoshi counts per post (if post ID provided)
- **Transaction History**: Full transaction history for audit trails

## Integration with Other Protocols

### Relationship with RNKC

The **RNKC** (RANK Comment) protocol is a companion protocol that allows users to attach comments to RANK votes. While RANK expresses sentiment, RNKC provides textual context.

#### RNKC Economic Requirements

RNKC transactions have additional economic requirements to prevent spam:

- **Minimum Fee Rate**: 10,000,000 satoshis per byte of comment data
- **Minimum Comment Length**: 1 byte
- **Maximum Comment Length**: 440 bytes (across 2 OP_RETURN outputs)

The total burn required is calculated as: `comment_length * 10,000,000` satoshis.

#### RNKC Transaction Structure

RNKC transactions require at least 2 OP_RETURN outputs:

- **Output 0**: RNKC LOKAD prefix (`0x524e4b43`), platform, profileId, and optional postId
- **Output 1**: Comment data (first chunk, up to 220 bytes)
- **Output 2** (optional): Comment data (second chunk, up to 220 bytes)

The comment data is concatenated from outputs 1 and 2 (if present) to form the complete comment.

### Relationship with Other LOKAD Protocols

The RANK protocol is one of several LOKAD-based protocols in the Lotus ecosystem. Other protocols may coexist in the same transaction outputs, but each output is processed independently based on its LOKAD prefix.

## References

- [LOKAD Prefix Guideline](https://lotusia.org/docs/specs/bitcoin-cash/op_return-prefix-guideline)
- [Bitcoin Cash OP_RETURN Specification](https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/op_return.md)
- [Proof-of-Burn Concept](https://en.wikipedia.org/wiki/Proof_of_burn)

## Version History

- **v1** (Current): Initial RANK protocol specification
  - Support for positive, negative, and neutral sentiment
  - Support for Lotusia and Twitter/X platforms
  - Optional post ID field
  - Multi-output transaction support

## Future Considerations

- **v2**: Potential enhancements (reserved, not yet implemented)
  - Additional platform support
  - Extended metadata fields
  - Enhanced privacy features
