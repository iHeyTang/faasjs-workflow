import { CloudFunction, useCloudFunction } from '@faasjs/cloud_function'
import { Http, useHttp } from '@faasjs/http'
import type {
  Steps,
  StepRecordAction,
  StepRecord,
  User,
} from '@faasjs/workflow-types'
import { resolve } from 'path'
import type { Knex } from 'knex'
import type { Func } from '@faasjs/func'

type InvokeStepAction<TName extends keyof Steps> = { stepAction: `${TName}/${StepRecordAction}` } | {
  stepId: TName
  action: StepRecordAction
}

export type InvokeStepOptions<
  TName extends keyof Steps,
  TExtend extends Record<string, any>,
> = InvokeStepAction<TName> & {
  record: Partial<StepRecord<TName>>
  previous?: {
    id: string
    stepId: string
    ancestorIds: string[]
    user?: User
  }
  user?: User
  /**
   * Request with session data
   * @default {}
   * @example { uid: 1 }
   */
  session?: Record<string, any>
  cf?: CloudFunction
  http?: Http
  /** only available in mono mode */
  trx?: Knex.Transaction
  /** @default steps */
  basePath?: string
} & TExtend

/**
 * Invoke a step
 *
 * ```ts
 * await invokeStep({
 *   stepId: 'basic',
 *   action: 'draft',
 *   record: {
 *     data: { productName: 'name' }
 *   },
 *   session: {
 *    uid: 'test'
 *   },
 * })
 * ```
 */
export async function invokeStep<
  TName extends keyof Steps,
  TExtend extends Record<string, any>,
>(props: InvokeStepOptions<TName, TExtend>) {
  const stepId = 'stepAction' in props ? props.stepAction.split('/')[0] : props.stepId
  const action = 'stepAction' in props ? props.stepAction.split('/')[1] : props.action

  if (!props.cf) props.cf = await useCloudFunction().mount()
  if (!props.http) props.http = await useHttp().mount()

  const body: Record<string, any> = {
    action: action,
    ...props.record,
  }

  if (process.env.FaasMode === 'mono' && props.trx) body.trx = props.trx

  if (props.previous) {
    body.previousId = props.previous.id
    body.previousStepId = props.previous.stepId
    body.previousUserId = props.previous.user?.id
    body.ancestorIds = props.previous.ancestorIds.includes(props.previous.id)
      ? props.previous.ancestorIds
      : props.previous.ancestorIds.concat(props.previous.id).filter(Boolean)
  }

  const path = `${props.basePath || 'steps'}/${stepId}/index`

  const headers = {
    ...props.http.headers,
    cookie: `${props.http.session.config.key}=${props.http.session.encode(
      JSON.stringify(props.session || {})
    )}`,
  }

  if (process.env.FaasMode === 'mono') {
    const localPath = resolve(process.env.FaasRoot, path)
    let file: Func
    try {
      const filePath = require.resolve(`${localPath}.func`)
      if (require.cache[filePath]) delete require.cache[filePath]
      file = require(filePath).default
    } catch (error) {
      const filePath = require.resolve(`${localPath}.func.ts`)
      if (require.cache[filePath]) delete require.cache[filePath]
      file = require(`${localPath}.func.ts`).default
    }

    return await file
      .export()
      .handler(
        {
          headers,
          body,
        },
        { request_id: props.http.headers?.['x-faasjs-request-id'] }
      )
      .then((res: any) => {
        if (res.originBody) {
          const body = JSON.parse(res.originBody)
          return body.error
            ? Promise.reject(Error(body.error.message))
            : body.data
        }
        return res
      })
  }

  return await props.cf
    .invokeSync(path, {
      headers,
      body,
    })
    .then(res => {
      if (res.originBody) {
        const body = JSON.parse(res.originBody)
        return body.error
          ? Promise.reject(Error(body.error.message))
          : body.data
      }
      return Promise.reject(res.body || res.statusCode)
    })
}
