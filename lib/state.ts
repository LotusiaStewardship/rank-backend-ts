import type { Block } from 'lotus-lib'

export class RuntimeState {
  private _checkpoint: Block | null

  constructor() {
    this._checkpoint = null
  }

  get checkpoint() {
    return this._checkpoint
  }

  set checkpoint(checkpoint: Block) {
    this._checkpoint = checkpoint
  }
}
