import { config as dotenv } from 'dotenv'
type TemporalWorkflowQuery = {
  workflowId: string
  queryType: string
}
type ParsedConfig = {
  datasourceUrl: string
  temporal: {
    host: string
    namespace: string
    taskQueue: string
    command: {
      workflowType: string
      workflowId: string
      signal: string
    }
    api: {
      chartsWalletActivity: TemporalWorkflowQuery
    }
  }
}

class Config {
  private env: ReturnType<typeof dotenv>
  constructor(path?: string) {
    this.env = dotenv({ path })
  }

  get parsedConfig() {
    return this.parseConfig()
  }

  private parseConfig(): ParsedConfig {
    return {
      datasourceUrl: this.env.parsed?.DATABASE_URL,
      temporal: {
        host: this.env.parsed?.TEMPORAL_HOST,
        namespace: this.env.parsed?.TEMPORAL_NAMESPACE,
        taskQueue: this.env.parsed?.TEMPORAL_TASKQUEUE,
        command: {
          workflowType: this.env.parsed?.TEMPORAL_COMMAND_WORKFLOW_TYPE,
          workflowId: this.env.parsed?.TEMPORAL_COMMAND_WORKFLOW_ID,
          signal: this.env.parsed?.TEMPORAL_COMMAND_WORKFLOW_SIGNAL,
        },
        api: {
          chartsWalletActivity: {
            workflowId: this.env.parsed?.TEMPORAL_API_CHARTS_WALLET_ACTIVITY,
            queryType:
              this.env.parsed?.TEMPORAL_API_CHARTS_WALLET_ACTIVITY_QUERY_TYPE,
          },
        },
      },
    }
  }
}

const config = new Config()
console.log(config.parsedConfig)
export default config.parsedConfig
