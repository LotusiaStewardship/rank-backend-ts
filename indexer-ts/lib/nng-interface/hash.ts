// automatically generated by the FlatBuffers compiler, do not modify

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import * as flatbuffers from 'flatbuffers';

export class Hash {
  bb: flatbuffers.ByteBuffer|null = null;
  bb_pos = 0;
  __init(i:number, bb:flatbuffers.ByteBuffer):Hash {
  this.bb_pos = i;
  this.bb = bb;
  return this;
}

data(index: number):number|null {
    return this.bb!.readUint8(this.bb_pos + 0 + index);
}

static sizeOf():number {
  return 32;
}

static createHash(builder:flatbuffers.Builder, data: number[]|null):flatbuffers.Offset {
  builder.prep(1, 32);

  for (let i = 31; i >= 0; --i) {
    builder.writeInt8((data?.[i] ?? 0));

  }

  return builder.offset();
}

}