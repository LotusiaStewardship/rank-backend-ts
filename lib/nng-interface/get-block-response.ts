// automatically generated by the FlatBuffers compiler, do not modify

/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */

import * as flatbuffers from 'flatbuffers';

import { Block } from '../nng-interface/block.js';


export class GetBlockResponse {
  bb: flatbuffers.ByteBuffer|null = null;
  bb_pos = 0;
  __init(i:number, bb:flatbuffers.ByteBuffer):GetBlockResponse {
  this.bb_pos = i;
  this.bb = bb;
  return this;
}

static getRootAsGetBlockResponse(bb:flatbuffers.ByteBuffer, obj?:GetBlockResponse):GetBlockResponse {
  return (obj || new GetBlockResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

static getSizePrefixedRootAsGetBlockResponse(bb:flatbuffers.ByteBuffer, obj?:GetBlockResponse):GetBlockResponse {
  bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
  return (obj || new GetBlockResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
}

block(obj?:Block):Block|null {
  const offset = this.bb!.__offset(this.bb_pos, 4);
  return offset ? (obj || new Block()).__init(this.bb!.__indirect(this.bb_pos + offset), this.bb!) : null;
}

static startGetBlockResponse(builder:flatbuffers.Builder) {
  builder.startObject(1);
}

static addBlock(builder:flatbuffers.Builder, blockOffset:flatbuffers.Offset) {
  builder.addFieldOffset(0, blockOffset, 0);
}

static endGetBlockResponse(builder:flatbuffers.Builder):flatbuffers.Offset {
  const offset = builder.endObject();
  return offset;
}

static createGetBlockResponse(builder:flatbuffers.Builder, blockOffset:flatbuffers.Offset):flatbuffers.Offset {
  GetBlockResponse.startGetBlockResponse(builder);
  GetBlockResponse.addBlock(builder, blockOffset);
  return GetBlockResponse.endGetBlockResponse(builder);
}
}
