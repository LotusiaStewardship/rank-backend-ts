# RNKE Protocol Specification

## Overview

The **RNKE** (RANK Comment Edit) protocol is a Lotus OP\_RETURN-based protocol for applying incremental edits to existing RNKC comment transactions. It uses the LOKAD prefix `0x524e4b45` ("RNKE" in ASCII) to identify transactions that implement this protocol.

Because RNKC transactions are immutable once confirmed on the blockchain, a user who burns Lotus to publish an RNKC comment has no on-chain mechanism to modify its text. RNKE resolves this by allowing the original author to broadcast a supplementary transaction that encodes a **Run-Length Skip/Write (RLSW)** patch against the original RNKC comment. Indexers that support RNKE reconstruct the edited comment by applying the patch to the source text retrieved from the referenced RNKC transaction.

RNKE is a **supplement** to the RNKC protocol, not a replacement. An RNKE transaction is only valid in relation to an existing, indexed RNKC transaction, and the edit chain is always rooted in an original RNKC transaction.

## LOKAD Prefix

- **Prefix**: `0x524e4b45` (4 bytes, big-endian)
- **ASCII Representation**: "RNKE"
- **Version**: v1

## Relationship with RNKC Protocol

RNKE is designed to extend RNKC without altering it. The following invariants govern the relationship between the two protocols:

- An RNKE transaction **must** reference exactly one RNKC transaction by its `txid`.
- The referenced RNKC transaction must be fully confirmed and indexed before the RNKE transaction is processed.
- An RNKE transaction **must** be signed by the same key that funded the referenced RNKC transaction's inputs, establishing authorship continuity.
- Multiple RNKE transactions may reference the same RNKC transaction. The **most recent valid RNKE** (by block height, then by transaction index within the block) is the canonical edit. Earlier RNKE transactions against the same RNKC `txid` are superseded.
- An RNKE transaction **may** reference a previous RNKE transaction as its source instead of the original RNKC transaction, enabling chained edits. In this case, the `source_txid` field refers to the RNKE transaction being amended, and the patch is applied to that RNKE's resolved output text. The chain always terminates at the original RNKC transaction. Indexers **must** resolve the full chain to reconstruct the current canonical text.
- A single RNKE transaction establishes one discrete revision. There is no batch-edit operation.

## Transaction Structure

An RNKE transaction requires exactly **2 OP\_RETURN outputs** and may include an optional **3rd OP\_RETURN output** if the patch payload exceeds 220 bytes:

- **Output 0**: Metadata (LOKAD prefix, platform, profile ID, source txid, source CRC32)
- **Output 1**: Patch data (first chunk, up to 220 bytes)
- **Output 2** (optional): Patch data (second chunk, up to 220 bytes)

### Multi-Output Layout

```
Output 0: [OP_RETURN] [PUSH 4] [LOKAD] [PUSH 1] [PLATFORM] [PUSH N] [PROFILE_ID] [PUSH 32] [SOURCE_TXID] [PUSH 4] [SOURCE_CRC32]
Output 1: [OP_RETURN] [OP_PUSHDATA1] [LENGTH] [PATCH_DATA_1]
Output 2: [OP_RETURN] [OP_PUSHDATA1] [LENGTH] [PATCH_DATA_2]  (optional)
```

### Output 0: Metadata

| Offset | Length | Field | Description |
| --- | --- | --- | --- |
| 0 | 1 | OP\_RETURN | `0x6a` — OP\_RETURN opcode |
| 1 | 1 | PUSH OP | `0x04` — Push 4 bytes |
| 2–5 | 4 | LOKAD Prefix | `0x524e4b45` — "RNKE" |
| 6 | 1 | PUSH OP | `0x01` — Push 1 byte |
| 7 | 1 | Platform | Platform identifier (see Platform Codes) |
| 8 | 1 | PUSH OP | Platform-specific profile ID length |
| 9+ | Variable | Profile ID | Platform-specific profile identifier |
| ... | 1 | PUSH OP | `0x20` — Push 32 bytes |
| ... | 32 | Source TXID | `txid` of the RNKC (or prior RNKE) transaction being edited, in **little-endian** byte order |
| ... | 1 | PUSH OP | `0x04` — Push 4 bytes |
| ... | 4 | Source CRC32 | CRC-32/ISO-HDLC checksum of the **source comment bytes** (the UTF-8 encoded text as stored, prior to patching), big-endian |

#### Source TXID Encoding

The `source_txid` field is the raw 32-byte transaction hash in **internal byte order** (little-endian), consistent with how transaction IDs are stored and referenced throughout the Lotus/Bitcoin Cash ecosystem. Indexers must display or log the `txid` in **reversed byte order** (big-endian) for human-readable output.

#### Source CRC32

The `source_crc32` field is a CRC-32/ISO-HDLC (standard CRC-32 as used in Ethernet, zlib, PNG) checksum of the exact bytes of the source comment text — that is, the concatenated UTF-8 bytes of the comment as resolved from the referenced transaction — prior to applying the RNKE patch. The checksum is encoded as a 4-byte big-endian unsigned integer.

This field serves as a safety guard: if the checksum of the fetched source text does not match `source_crc32`, the indexer **must reject** the RNKE transaction as invalid and **must not** apply the patch. This prevents patch misapplication in edge cases such as:

- Chain reorganizations that alter the referenced transaction's content
- Indexer state inconsistency
- An RNKE transaction constructed against a chained RNKE that has itself been superseded

### Output 1 & 2: Patch Data

| Offset | Length | Field | Description |
| --- | --- | --- | --- |
| 0 | 1 | OP\_RETURN | `0x6a` — OP\_RETURN opcode |
| 1 | 1 | OP\_PUSHDATA1 | `0x4c` — Push up to 255 bytes |
| 2 | 1 | Data Length | Number of bytes to push (1–220) |
| 3+ | Variable | Patch Data | RLSW-encoded patch payload (see Patch Encoding) |

Patch data from Output 1 and Output 2 is concatenated in order before parsing:

```
Patch Payload = Output1PatchData + Output2PatchData
```

The concatenated payload is then parsed as a sequence of RLSW records from left to right.

## Platform Codes

RNKE inherits the platform code definitions from RNKC without modification:

| Platform | Code | Hex Value | Profile ID Format | Notes |
| --- | --- | --- | --- | --- |
| Lotusia | 0 | `0x00` | 20-byte P2PKH address (hex) | Profile must match RNKC source |
| Twitter/X | 1 | `0x01` | 1–16 character username (UTF-8) | Profile must match RNKC source |

The `platform` and `profile_id` fields in Output 0 of the RNKE transaction **must** be identical to those in the referenced RNKC transaction's Output 0. An RNKE transaction that specifies a different platform or profile ID than its source is invalid and must be rejected.

## Patch Encoding: Run-Length Skip/Write (RLSW)

The RLSW encoding describes edits to the source comment as a sequential stream of records. Each record instructs the indexer to advance through the source string and optionally overwrite bytes. Unvisited bytes at the tail of the source string are implicitly preserved. The encoding is read from left to right; records must be applied strictly in the order they appear.

### Record Format

Each RLSW record has the following structure:

```
[2 bytes: skip_count] [1 byte: write_length] [write_length bytes: write_data]
```

| Field | Size | Type | Description |
| --- | --- | --- | --- |
| `skip_count` | 2 bytes | BE uint16 | Number of bytes to advance the source cursor without modification. `0xFFFF` is the **terminator sentinel** (see below). |
| `write_length` | 1 byte | uint8 | Number of bytes to write (and simultaneously consume from the source). `0x00` indicates a pure skip with no replacement. |
| `write_data` | `write_length` bytes | raw bytes | UTF-8 encoded replacement text. Present only when `write_length > 0`. |

### Terminator Sentinel

A record with `skip_count = 0xFFFF` signals the end of the patch stream. Upon encountering this sentinel, the indexer **must** emit all remaining source bytes from the current cursor position to the end of the source string, then halt processing. The terminator's `write_length` byte **must** be `0x00` and **must** be present; any `write_length` value other than `0x00` following a `0xFFFF` skip is invalid and the RNKE transaction must be rejected.

A terminator sentinel is **required** when the patch does not modify or visit all bytes through the end of the source string (i.e., when trailing bytes must be preserved implicitly). It is **optional** if the patch explicitly covers every byte of the source string with skip and write records that together account for all source bytes.

### Reconstruction Algorithm

The following pseudocode describes patch application. `src` is the UTF-8 byte array of the source comment; `patch` is the concatenated RLSW payload bytes; `out` is the output buffer.

```
src_cursor  ← 0
patch_cursor ← 0
out ← []

while patch_cursor < len(patch):
    skip_count   ← BE_uint16(patch[patch_cursor : patch_cursor + 2])
    patch_cursor ← patch_cursor + 2

    if skip_count == 0xFFFF:
        write_length ← patch[patch_cursor]
        patch_cursor ← patch_cursor + 1
        if write_length != 0x00:
            REJECT transaction
        out.append(src[src_cursor :])   // emit remaining source tail
        break

    write_length ← patch[patch_cursor]
    patch_cursor ← patch_cursor + 1

    // Emit the skipped source bytes unchanged
    out.append(src[src_cursor : src_cursor + skip_count])
    src_cursor ← src_cursor + skip_count

    if write_length > 0:
        write_data   ← patch[patch_cursor : patch_cursor + write_length]
        patch_cursor ← patch_cursor + write_length

        // Consume source bytes that are being replaced
        src_cursor   ← src_cursor + write_length

        // Emit replacement bytes
        out.append(write_data)

// If patch stream ended without a terminator and src_cursor < len(src),
// emit the remaining source tail implicitly.
if src_cursor < len(src):
    out.append(src[src_cursor :])
```

After reconstruction, the output buffer must be validated as well-formed UTF-8. If it is not, the RNKE transaction must be rejected.

### Length Constraints on Reconstructed Text

The reconstructed comment text (after patch application) is subject to the same length constraints as an original RNKC comment:

- **Minimum Length**: 1 byte (configurable, matching the RNKC minimum)
- **Maximum Length**: 440 bytes

An RNKE transaction that would produce a reconstructed comment outside these bounds is invalid and must be rejected.

### RLSW Design Notes

- Records are strictly sequential; there is no random-access addressing. All operations progress left-to-right through the source string.
- **Insertions** (growing the comment) are expressed as a record with `skip_count = 0` and `write_length > 0`, where `write_length` bytes of `write_data` replace zero source bytes. Because `skip_count = 0` means no source bytes are consumed before writing, and `write_length` bytes of source are consumed during the write step: a net insertion requires `write_length` bytes of new content to be written while consuming `write_length` source bytes. To insert **without** consuming source bytes, use `write_length = 0` (pure skip of 0) followed by a separate record.

  > **Clarification — pure insertion:** To insert new text between two source positions without replacing any source bytes, emit a record with `skip_count` equal to the offset of the insertion point (to advance the cursor there), `write_length = 0` (no replacement), and then immediately follow with another record where `skip_count = 0` and `write_length > 0`, with `write_data` containing the inserted text, and source bytes consumed by `write_length` set to 0. This requires the two-record sequence:
  >
  > ```
  > [offset] [00]          // advance to insertion point, no replacement
  > [0000]   [N] [data]   // write N bytes, consume 0 source bytes
  > ```
  >
  > However, a simpler model is that `write_length` always consumes that many source bytes. **Pure insertion (no consumption)** is therefore modeled as `write_length = 0` on the advance record, and the payload record uses `skip_count = 0` with `write_length > 0` consuming source bytes that are intended to remain. If a true zero-consumption insert is needed (e.g., inserting text before the first character without overwriting it), the implementer **must** re-encode the first character(s) into `write_data` along with the inserted text, adjusting `write_length` accordingly.

- **Deletions** (shrinking the comment) are expressed as a record with `skip_count` advancing to the deletion site, `write_length = 0` (no replacement data written), and the source cursor advanced by the number of bytes to delete. Because `write_length = 0` means no write data follows, the bytes at `src[src_cursor : src_cursor + delete_count]` are simply not emitted. In practice, deletions are encoded by **not emitting** those bytes: the skip advances the cursor past the deleted region with no write. This means deletion requires a following record (or terminator) that skips past the deleted bytes by having the *next* skip_count begin after them — **or** by using `write_length = 0` on a record that sits at the deletion site with `skip_count` advancing to just before it, and then consuming the deleted bytes with the next record's `write_length = 0` and no write_data.

  > **Simplified deletion model:** The cleanest way to delete bytes `[A, B)` from the source is a two-record sequence:
  >
  > ```
  > [A]      [0]           // skip to start of deleted region, no write
  > [0000]   [0]           // skip_count=0, write_length=0, then advance src_cursor by (B-A) in the next step
  > ```
  >
  > Given the ambiguity above, the **canonical deletion encoding** for RNKE v1 is: advance the src_cursor to position A via `skip_count = A`, then encode the deleted byte count implicitly by having the following record's `skip_count` begin at position B. That is, the record at position A simply has `write_length = 0` with `skip_count` pointing past the deleted bytes, meaning the deleted bytes are never emitted. Indexers must treat any bytes between the last emitted skip region and the next skip's start as consumed/deleted.

- **Replacements** (same-length or different-length substitution) are the most natural operation: advance to the target position with `skip_count`, set `write_length` to the number of source bytes being replaced, and provide `write_data` with the replacement text. `write_data` may be longer or shorter than the replaced region.

- The total byte length of all RLSW records (including all headers and `write_data` payloads) must not exceed 440 bytes (the combined capacity of Outputs 1 and 2).

## Fee Rate Validation

RNKE transactions must meet a minimum fee rate requirement, calculated against the **patch payload size** (the total bytes of RLSW-encoded data across Outputs 1 and 2), not the reconstructed comment length.

### Calculation

```
Minimum Fee Rate   = RNKE.minFeeRate (satoshis per byte)
Required Satoshis  = Minimum Fee Rate × Patch Payload Length (bytes)
Actual Satoshis Burned = Sum of all output values
```

### Validation Rule

```
Actual Satoshis Burned ≥ Required Satoshis
```

### Default Configuration

- **Minimum Fee Rate**: 10,000,000 satoshis per byte (10 XPI per byte), matching the RNKC default
- **Minimum Patch Length**: 3 bytes (the minimum possible RLSW record: 2-byte skip + 1-byte write_length)

### Fee Examples

| Patch Payload Length | Satoshis Required | XPI Required |
| --- | --- | --- |
| 3 bytes (1 op, minimal) | 30,000,000 | 30 XPI |
| 11 bytes (1 op, 8-byte replacement) | 110,000,000 | 110 XPI |
| 50 bytes | 500,000,000 | 500 XPI |
| 220 bytes | 2,200,000,000 | 2,200 XPI |
| 440 bytes | 4,400,000,000 | 4,400 XPI |

Note that the fee for a typical single-word edit (a replacement record of roughly 11–20 bytes) is substantially lower than the cost of re-broadcasting the entire comment as a new RNKC transaction.

## Validation Rules

### Required Fields

- **Platform**: Must be a supported platform code (`0x00` or `0x01`)
- **Profile ID**: Must match platform-specific format, length, and encoding requirements
- **Source TXID**: Must be a 32-byte value referencing a confirmed, indexed RNKC or RNKE transaction
- **Source CRC32**: Must match the CRC-32/ISO-HDLC checksum of the source comment bytes
- **Patch Data**: Must be a valid, parseable RLSW byte stream

### Output Requirements

- **Output 0**: Must be a valid OP\_RETURN with RNKE LOKAD prefix, correct metadata fields in order
- **Output 1**: Must be a valid OP\_RETURN with at least 3 bytes of patch data
- **Output 2**: Optional; must be a valid OP\_RETURN with patch data if present
- **Output Count**: Minimum 2, maximum 3 OP\_RETURN outputs

### Authorship Validation

The RNKE transaction must be funded by at least one UTXO whose locking script corresponds to the same address that funded the original RNKC transaction's inputs. Indexers must verify that the spending address of at least one RNKE input matches at least one RNKC input address. If authorship cannot be confirmed, the RNKE transaction must be rejected.

### Patch Validity

- **Parseable**: The RLSW byte stream must be fully parseable without buffer overruns
- **UTF-8 Output**: The reconstructed comment must be valid UTF-8
- **Length Bounds**: The reconstructed comment must be between 1 and 440 bytes (inclusive)
- **CRC32 Match**: The source comment bytes must match `source_crc32` before the patch is applied
- **Terminator Integrity**: If a terminator sentinel (`0xFFFF`) is present, its accompanying `write_length` must be `0x00`

### Cross-Field Consistency

- `platform` and `profile_id` in the RNKE Output 0 must exactly match those in the referenced source transaction's Output 0
- If the source is an RNKE transaction (chained edit), the platform and profile ID are compared against that RNKE transaction's Output 0, which itself must have matched the original RNKC chain

## Example Transactions

### Example 1: Single-Word Replacement

**Scenario**: The original RNKC comment is `"This project is bad and you should feel bad."` (45 bytes). The author wishes to change the first `"bad"` (bytes 16–18) to `"great"`.

**Source CRC32**: Computed over the 45 UTF-8 bytes of the original comment. For illustration, assume the result is `0xA1B2C3D4`.

**RLSW Patch Construction**:

```
Record 1: skip 16 bytes, replace 3 bytes with "great" (5 bytes)
  skip_count   = 0x0010
  write_length = 0x05
  write_data   = 6772656174 ("great")

Terminator:
  skip_count   = 0xFFFF
  write_length = 0x00
```

**Patch payload** (hex):
```
0010 05 6772656174 FFFF 00
```
Total: 2 + 1 + 5 + 2 + 1 = **11 bytes**

**Output 0** (Lotusia platform, 20-byte profile ID `1234...5678`, source txid `abcd...ef01`):
```
6a
04 524e4b45
01 00
14 1234567890abcdef1234567890abcdef12345678
20 01efcdab...  (32-byte source txid, little-endian)
04 a1b2c3d4     (source CRC32)
```

**Output 1**:
```
6a 4c 0b 001005677265616174ffff00
```

**Reconstructed Comment**: `"This project is great and you should feel bad."`

---

### Example 2: Typo Fix (Character Transposition)

**Scenario**: Original RNKC comment is `"The quikc brown fox jumps over the lazy dog."` (45 bytes). Author wishes to correct `"quikc"` (bytes 4–8) to `"quick"`.

**RLSW Patch Construction**:

```
Record 1: skip 4 bytes ("The "), replace 5 bytes ("quikc") with "quick"
  skip_count   = 0x0004
  write_length = 0x05
  write_data   = 717569636b ("quick")

Terminator:
  skip_count   = 0xFFFF
  write_length = 0x00
```

**Patch payload** (hex):
```
0004 05 717569636b FFFF 00
```
Total: **11 bytes**

**Output 1**:
```
6a 4c 0b 00040571756963 6bffff00
```

**Reconstructed Comment**: `"The quick brown fox jumps over the lazy dog."`

---

### Example 3: Multi-Region Edit (Two Replacements)

**Scenario**: Original comment is `"Alice is a bad developer and writes bad code."` (46 bytes). Author wishes to replace both `"bad"` occurrences: first at byte 10 (replacing "bad developer" → "skilled engineer", 13 chars replacing 13) and second at byte 37 ("bad code" → "clean code").

**RLSW Patch Construction**:

```
Record 1: skip 10 ("Alice is a"), replace 3 ("bad") with "skilled" (7 bytes)
  0x000A 07 736b696c6c6564

Record 2: skip 24 (remaining unchanged region " developer and writes "),
          replace 3 ("bad") with "clean" (5 bytes)
  0x0018 05 636c65616e

Terminator:
  FFFF 00
```

**Patch payload** (hex):
```
000a 07 736b696c6c6564 0018 05 636c65616e ffff 00
```
Total: 3+7 + 3+5 + 3 = **21 bytes**

**Reconstructed Comment**: `"Alice is a skilled developer and writes clean code."`

---

### Example 4: Chained RNKE (Edit of an Edit)

**Scenario**: After Example 1, the author decides to also fix the second `"bad"` in the already-edited comment `"This project is great and you should feel bad."`. The `source_txid` now references the prior RNKE transaction, and `source_crc32` is computed over `"This project is great and you should feel bad."` (46 bytes).

The patch targets byte 41 (`"bad"` → `"good"`):

```
Record 1: skip 41, replace 3 ("bad") with "good" (4 bytes)
  0x0029 04 676f6f64

Terminator:
  FFFF 00
```

**Patch payload** (hex):
```
0029 04 676f6f64 ffff 00
```
Total: **10 bytes**

**Reconstructed Comment**: `"This project is great and you should feel good."`

## Processing Rules

### Indexing

The rank-backend-ts indexer processes RNKE transactions according to these rules:

1. **Transaction Discovery**: Scan all transactions for OP\_RETURN outputs with RNKE LOKAD prefix in Output 0
2. **LOKAD Validation**: Verify LOKAD prefix is `0x524e4b45` in Output 0
3. **Output Validation**: Verify minimum 2 and maximum 3 OP\_RETURN outputs
4. **Metadata Extraction**: Parse platform, profile ID, source TXID, and source CRC32 from Output 0
5. **Source Resolution**: Retrieve the source comment bytes from the indexed RNKC (or prior RNKE) transaction identified by `source_txid`
6. **CRC32 Verification**: Compute CRC-32/ISO-HDLC over the source comment bytes and compare against `source_crc32`; reject if mismatch
7. **Authorship Verification**: Confirm that at least one RNKE input address matches at least one input address of the root RNKC transaction
8. **Patch Extraction**: Concatenate patch data from Outputs 1 and 2
9. **Patch Application**: Apply the RLSW patch per the reconstruction algorithm
10. **Output Validation**: Validate that the reconstructed comment is well-formed UTF-8 and within length bounds
11. **Fee Validation**: Verify that total satoshis burned meets the minimum fee rate against patch payload length
12. **Canonicalization**: If a more recent valid RNKE already exists for the same source RNKC `txid`, mark this transaction as superseded; otherwise, store as the current canonical edit
13. **Database Storage**: Store validated and reconstructed comment text in the database

### Comment Canonicalization

When multiple RNKE transactions reference the same root RNKC `txid` (directly or through a chain), the following precedence rules apply:

1. The RNKE transaction confirmed at the **greater block height** takes precedence.
2. If two RNKE transactions are confirmed in the same block, the one with the **lower transaction index** within the block takes precedence.
3. Superseded RNKE transactions are retained in the database for audit purposes but are not used for comment display.

Indexers must maintain the full edit history for each RNKC `txid`, including all superseded RNKE transactions, to support audit trails and chain reorganization handling.

### Chained Edit Resolution

When an RNKE's `source_txid` references a prior RNKE (rather than the root RNKC), the indexer must resolve the chain recursively:

1. Identify the `source_txid` of the RNKE being processed.
2. If `source_txid` is an RNKE transaction, retrieve its resolved output text.
3. Apply the current RNKE's patch to that resolved text.
4. Repeat until the chain is fully resolved.

Circular references (RNKE A → RNKE B → RNKE A) are invalid and must be detected and rejected. Indexers must enforce a maximum chain depth of **16** edits; RNKE transactions that would exceed this depth are rejected.

### Mempool Handling

- **Unconfirmed RNKE Transactions**: Cached in memory with timestamp, pending confirmation
- **Dependency Ordering**: An RNKE in the mempool whose `source_txid` has not yet been confirmed is held pending until the source is confirmed or the RNKE transaction is evicted
- **Confirmation**: Moved to persistent storage when included in a block
- **Reorg Handling**: On block disconnection, affected RNKE transactions are reverted; the prior canonical edit (or original RNKC comment) is restored

### State Management

The indexer maintains:

- **Edit History**: Full RNKE transaction history per RNKC `txid` for audit trails
- **Canonical Edit**: The current winning RNKE (or lack thereof) for each RNKC `txid`
- **Resolved Comment**: The fully reconstructed current comment text for display
- **Chain Map**: A mapping of RNKE `txid` → `source_txid` for chain traversal and cycle detection

## Constraints and Limitations

### Size Limitations

- **Maximum Patch Payload Length**: 440 bytes (220 bytes × 2 outputs)
- **Maximum Reconstructed Comment Length**: 440 bytes (inherited from RNKC)
- **Maximum Output Count**: 3 OP\_RETURN outputs
- **OP\_PUSHDATA1 Limit**: 255 bytes per output (minus overhead = 220 bytes max data)
- **Minimum Patch Payload Length**: 3 bytes (one minimal RLSW record)

### Encoding Limitations

- **Patch Payload**: Raw binary (RLSW-encoded); not required to be valid UTF-8 itself
- **Reconstructed Comment**: Must be valid UTF-8 after patch application
- **`write_data` Fields**: Must each be individually valid UTF-8 sequences (to ensure valid UTF-8 output when concatenated with surrounding source bytes)
- **Source TXID**: 32 bytes, little-endian internal byte order
- **Source CRC32**: 4 bytes, big-endian

### Operational Limitations

- **Authorship Only**: Only the original RNKC author (as determined by input address matching) may broadcast a valid RNKE against that RNKC transaction
- **Maximum Chain Depth**: 16 chained RNKE transactions per root RNKC `txid`
- **No Platform Change**: Platform and profile ID cannot be altered via RNKE
- **No Post ID Change**: The post ID association from the original RNKC transaction cannot be altered via RNKE
- **Confirmed Source Required**: The source transaction must be confirmed before an RNKE against it will be processed (mempool-to-mempool chaining is not supported)

## Integration with Other Protocols

### Relationship with RNKC

RNKE is strictly additive to RNKC. An RNKC transaction's on-chain data is never modified; RNKE only affects the **indexer's resolved view** of a comment. Applications that do not implement RNKE will continue to display the original RNKC comment text unmodified.

### Coexistence with Other LOKAD Protocols

Because RNKE consumes 2–3 OP\_RETURN outputs, it is not advisable to combine RNKE with other LOKAD protocols in the same transaction, consistent with the same guidance in the RNKC specification.

### Display Recommendations

Applications implementing RNKE support should:

- Display the resolved (post-edit) comment text as the primary content
- Indicate to the user that the comment has been edited (e.g., with an "edited" label)
- Optionally provide access to the full edit history, including the original RNKC text and each intermediate RNKE revision, for transparency

## References

- [RNKC Protocol Specification](https://github.com/LotusiaStewardship/rank-backend-ts/blob/master/docs/spec/RNKC.md)
- [LOKAD Prefix Guideline](https://lotusia.org/docs/specs/bitcoin-cash/op_return-prefix-guideline)
- [Bitcoin Cash OP\_RETURN Specification](https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/op_return.md)
- [RANK Protocol Specification](https://github.com/LotusiaStewardship/rank-backend-ts/blob/master/docs/spec/RANK.md)
- [CRC-32/ISO-HDLC (zlib CRC32)](https://reveng.sourceforge.io/crc-catalogue/all.htm#crc.cat.crc-32-iso-hdlc)
- [Proof-of-Burn Concept](https://en.wikipedia.org/wiki/Proof_of_burn)

## Version History

- **v1** (Current): Initial RNKE protocol specification
  - RLSW patch encoding for incremental comment edits
  - CRC32 source integrity verification
  - Authorship validation via input address matching
  - Chained edit support (RNKE referencing prior RNKE)
  - Maximum chain depth of 16
  - Fee rate based on patch payload length

## Future Considerations

- **v2**: Potential enhancements (reserved, not yet implemented)
  - Extended platform support (inheriting from RNKC v2)
  - Explicit deletion records in RLSW to simplify pure-deletion encoding
  - Delegated edit authorization (third-party editor whitelisting)
  - Patch compression for large edits approaching the 440-byte ceiling
