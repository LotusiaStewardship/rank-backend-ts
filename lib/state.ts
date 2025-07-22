import type { Block } from 'lotus-lib'

export default class RuntimeState {
  public checkpoint: Block

  constructor() {
    this.checkpoint = null
  }
}
