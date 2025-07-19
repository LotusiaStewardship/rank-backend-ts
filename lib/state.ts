import type { Block } from 'rank-lib'

export default class RuntimeState {
  public checkpoint: Block

  constructor() {
    this.checkpoint = null
  }
}
