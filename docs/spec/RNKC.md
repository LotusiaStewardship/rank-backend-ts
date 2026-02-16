# RNKC Protocol Specification

## Overview

The **RNKC** (RANK Comment) protocol is a Lotus OP_RETURN-based protocol for attaching text comments to RANK votes. It uses the LOKAD prefix `0x524e4b43` ("RNKC" in ASCII) to identify transactions that implement this protocol.

The RNKC protocol enables users to provide textual context, reasoning, or additional information alongside their RANK sentiment votes. Comments are burned as part of the transaction, creating a permanent, immutable record on the blockchain.

## LOKAD Prefix

- **Prefix**: `0x524e4b43` (4 bytes, big-endian)
- **ASCII Representation**: "RNKC"
- **Version**: v1

## Transaction Structure

An RNKC transaction requires a minimum of **2 OP_RETURN outputs** and can have up to **3 OP_RETURN outputs**:

- **Output 0**: Metadata (platform, profile ID, optional post ID)
- **Output 1**: Comment data (first chunk, up to 220 bytes)
- **Output 2** (optional): Comment data (second chunk, up to 220 bytes)

### Multi-Output Layout

```
Output 0: [OP_RETURN] [PUSH 4] [LOKAD] [PUSH 1] [PLATFORM] [PUSH N] [PROFILE_ID] [PUSH M] [POST_ID]
Output 1: [OP_RETURN] [OP_PUSHDATA1] [LENGTH] [COMMENT_DATA_1]
Output 2: [OP_RETURN] [OP_PUSHDATA1] [LENGTH] [COMMENT_DATA_2]  (optional)
```

### Output 0: Metadata

| Offset | Length   | Field        | Description                                  |
| ------ | -------- | ------------ | -------------------------------------------- |
| 0      | 1        | OP_RETURN    | `0x6a` - OP_RETURN opcode                    |
| 1      | 1        | PUSH OP      | `0x04` - Push 4 bytes                        |
| 2-5    | 4        | LOKAD Prefix | `0x524e4b43` - "RNKC"                        |
| 6      | 1        | PUSH OP      | `0x01` - Push 1 byte                         |
| 7      | 1        | Platform     | Platform identifier (see Platform Codes)     |
| 8      | 1        | PUSH OP      | Platform-specific profile ID length          |
| 9+     | Variable | Profile ID   | Platform-specific profile identifier         |
| ...    | 1        | PUSH OP      | Post ID length (optional)                    |
| ...    | Variable | Post ID      | Platform-specific post identifier (optional) |

### Output 1 & 2: Comment Data

| Offset | Length   | Field        | Description                     |
| ------ | -------- | ------------ | ------------------------------- |
| 0      | 1        | OP_RETURN    | `0x6a` - OP_RETURN opcode       |
| 1      | 1        | OP_PUSHDATA1 | `0x4c` - Push up to 255 bytes   |
| 2      | 1        | Data Length  | Number of bytes to push (1-220) |
| 3+     | Variable | Comment Data | UTF-8 encoded comment text      |

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

#### Twitter/X Platform

- **Profile ID Length**: 16 bytes (padded with null bytes if shorter)
- **Profile ID Format**: UTF-8 encoded username (1-16 characters)
- **Profile ID Regex**: `/^[a-z0-9_]{1,16}$/`
- **Post ID Length**: 8 bytes
- **Post ID Format**: 64-bit unsigned integer (big-endian)
- **Post ID Regex**: `/^[0-9]+$/`

## Comment Data

### Encoding

- **Format**: UTF-8 text encoding
- **Minimum Length**: 1 byte (configurable, default 1)
- **Maximum Length**: 440 bytes (220 bytes per output × 2 outputs)
- **Chunk Size**: 220 bytes per OP_RETURN output (limited by MAX_OP_RETURN_DATA)

### Chunking

Comments longer than 220 bytes are split across Output 1 and Output 2:

```
Comment Text (up to 440 bytes total)
├─ Chunk 1 (Output 1): bytes 0-219 (max 220 bytes)
└─ Chunk 2 (Output 2): bytes 220-439 (max 220 bytes)
```

The chunks are concatenated in order during processing to reconstruct the original comment.

## Fee Rate Validation

RNKC transactions must meet a minimum fee rate requirement to prevent spam:

### Calculation

```
Minimum Fee Rate = RNKC.minFeeRate (satoshis per byte)
Required Satoshis = Minimum Fee Rate × Comment Data Length
Actual Satoshis Burned = Sum of all output values
```

### Validation Rule

```
Actual Satoshis Burned ≥ Required Satoshis
```

### Default Configuration

- **Minimum Fee Rate**: 10,000,000 satoshis per byte (10 XPI per byte)
- **Minimum Data Length**: 1 byte

### Fee Examples

| Comment Length | Satoshis Required | XPI Required |
| -------------- | ----------------- | ------------ |
| 1 byte         | 10,000,000        | 10 XPI       |
| 27 bytes       | 270,000,000       | 270 XPI      |
| 100 bytes      | 1,000,000,000     | 1,000 XPI    |
| 220 bytes      | 2,200,000,000     | 2,200 XPI    |
| 440 bytes      | 4,400,000,000     | 4,400 XPI    |

## Validation Rules

### Required Fields

- **Platform**: Must be a supported platform code (0 or 1)
- **Profile ID**: Must match platform-specific format and length requirements
- **Comment Data**: Must be valid UTF-8 text

### Optional Fields

- **Post ID**: Optional, but if provided, must match platform-specific format and length requirements

### Output Requirements

- **Output 0**: Must be a valid OP_RETURN with RNKC LOKAD prefix
- **Output 1**: Must be a valid OP_RETURN with comment data
- **Output 2**: Optional, must be a valid OP_RETURN with comment data if present
- **Output Count**: Minimum 2, maximum 3 OP_RETURN outputs

### Comment Validation

- **UTF-8 Encoding**: Comment data must be valid UTF-8
- **Length**: Comment length must meet minimum and maximum requirements
- **Fee Rate**: Total satoshis burned must meet minimum fee rate requirement

### Profile ID Validation

- **Format**: Must match platform-specific regex
- **Length**: Must match platform-specific length requirements
- **Encoding**: Must be properly encoded according to platform specifications

## Example Transactions

### Example 1: Comment on Twitter Profile (No Post ID)

```
Output 0:
6a 04 524e4b43 01 01 10 0000000000000000656c6f6e6d75736b

Output 1:
6a 4c 1b 54686973206973206120636f6d6d656e7420616e6f7574206120747765657421
```

Breakdown:

- Output 0:

  - `6a` - OP_RETURN
  - `04` - Push 4 bytes
  - `524e4b43` - RNKC prefix
  - `01` - Push 1 byte
  - `01` - Twitter platform
  - `10` - Push 16 bytes (profile ID length)
  - `0000000000000000656c6f6e6d75736b` - Profile ID (16 bytes, UTF-8 padded)

- Output 1:
  - `6a` - OP_RETURN
  - `4c` - OP_PUSHDATA1
  - `1b` - Push 27 bytes
  - `54686973206973206120636f6d6d656e7420616e6f7574206120747765657421` - "This is a comment about a tweet!" (27 bytes)

### Example 2: Comment on Lotusia Profile with Post ID

```
Output 0:
6a 04 524e4b43 01 00 14 1234567890abcdef1234567890abcdef12345678 20 abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890

Output 1:
6a 4c dc [220 bytes of comment data]

Output 2:
6a 4c 7f [127 bytes of comment data]
```

Breakdown:

- Output 0:

  - `6a` - OP_RETURN
  - `04` - Push 4 bytes
  - `524e4b43` - RNKC prefix
  - `01` - Push 1 byte
  - `00` - Lotusia platform
  - `14` - Push 20 bytes (profile ID length)
  - `1234567890abcdef1234567890abcdef12345678` - Profile ID (20 bytes)
  - `20` - Push 32 bytes (post ID length)
  - `abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890` - Post ID (32 bytes)

- Output 1:

  - `6a` - OP_RETURN
  - `4c` - OP_PUSHDATA1
  - `dc` - Push 220 bytes
  - [220 bytes of comment data]

- Output 2:
  - `6a` - OP_RETURN
  - `4c` - OP_PUSHDATA1
  - `7f` - Push 127 bytes
  - [127 bytes of comment data]

## Processing Rules

### Indexing

The rank-backend-ts indexer processes RNKC transactions according to these rules:

1. **Transaction Discovery**: Scan all transactions for OP_RETURN outputs
2. **LOKAD Validation**: Verify LOKAD prefix is `0x524e4b43` in Output 0
3. **Output Validation**: Verify minimum 2 and maximum 3 OP_RETURN outputs
4. **Metadata Extraction**: Parse platform, profile ID, and optional post ID from Output 0
5. **Comment Extraction**: Extract and concatenate comment data from Outputs 1 and 2
6. **Validation**: Validate all fields and encoding
7. **Database Storage**: Store validated transactions in the database

### Comment Concatenation

Comments are reconstructed by:

1. Extract comment data from Output 1 (up to 220 bytes)
2. Extract comment data from Output 2 if present (up to 220 bytes)
3. Concatenate in order: `Output1Data + Output2Data`
4. Decode as UTF-8

### Mempool Handling

- **Unconfirmed Transactions**: Cached in memory with timestamp
- **Confirmation**: Moved to persistent storage when included in a block
- **Reorg Handling**: Transactions are rewound if blocks are disconnected

### State Management

The indexer maintains:

- **Comment History**: Full transaction history for audit trails
- **Profile Comments**: Comments associated with specific profiles
- **Post Comments**: Comments associated with specific posts (if post ID provided)

## Relationship with RANK Protocol

The RNKC protocol is designed to complement the RANK protocol:

- **RANK**: Expresses sentiment (positive, negative, neutral) with proof-of-burn
- **RNKC**: Provides textual context for sentiment votes

A typical workflow:

1. User creates a RANK transaction expressing sentiment toward a profile
2. User creates an RNKC transaction with a comment about the same profile
3. Both transactions are indexed and associated in the database
4. Applications can display the comment alongside the ranking vote

## Economic Model

### Proof-of-Burn with Commentary

The RNKC protocol implements a Proof-of-Burn model for comments:

1. **Cost Signal**: Users must burn XPI to create comments
2. **Fee Rate Validation**: Minimum fee rate prevents spam
3. **Immutability**: Comments are permanently recorded on the blockchain
4. **Verification**: All comments are cryptographically verifiable

### Satoshi Tracking

The indexer tracks:

- **Total satoshis burned per comment** (aggregated across all outputs)
- **Fee rate** (satoshis per byte of comment data)
- **Comment length** (in bytes)

## Constraints and Limitations

### Size Limitations

- **Maximum Comment Length**: 440 bytes (220 bytes × 2 outputs)
- **Maximum Output Count**: 3 OP_RETURN outputs
- **OP_PUSHDATA1 Limit**: 255 bytes per output (minus overhead = 220 bytes max data)

### Encoding Limitations

- **Character Encoding**: UTF-8 only
- **No Binary Data**: Comments must be valid UTF-8 text
- **No Null Bytes**: Null bytes are not allowed in comment data

### Platform Limitations

- **Supported Platforms**: Currently Lotusia and Twitter/X only
- **Profile ID Format**: Platform-specific validation required
- **Post ID Format**: Platform-specific validation required

## Integration with Other Protocols

### Relationship with Other LOKAD Protocols

The RNKC protocol is one of several LOKAD-based protocols in the Lotus ecosystem. Other protocols may coexist in the same transaction, but each output is processed independently based on its LOKAD prefix. Because the RNKC LOKAD protocol encompasses 2-3 OP_RETURN outputs, it is not advisable to associate RNKC with other LOKAD protocols in the same transaction.

### Cross-Protocol References

RNKC transactions can reference entities created by other protocols:

- Profile IDs from RANK transactions
- Post IDs from RANK transactions
- Other platform-specific identifiers

## References

- [LOKAD Prefix Guideline](https://lotusia.org/docs/specs/bitcoin-cash/op_return-prefix-guideline)
- [Bitcoin Cash OP_RETURN Specification](https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/op_return.md)
- [RANK Protocol Specification](./RANK.md)
- [Proof-of-Burn Concept](https://en.wikipedia.org/wiki/Proof_of_burn)

## Version History

- **v1** (Current): Initial RNKC protocol specification
  - Support for text comments up to 440 bytes
  - Support for Lotusia and Twitter/X platforms
  - Optional post ID field
  - Fee rate validation
  - Multi-output transaction support

## Future Considerations

- **v2**: Potential enhancements (reserved, not yet implemented)
  - Extended comment length support
  - Additional platform support
  - Comment editing/revision mechanisms
  - Enhanced privacy features
