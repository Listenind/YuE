// Exercise the host route end-to-end with stub services: fake webServer,
// fake account, real filesystem aggregation. No DSH process needed.
import assert from 'node:assert/strict'

const routes = new Map()

/** Minimal Res-like collector. */
function makeRes() {
  const res = {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
  return res
}

const account = {
  async getState() {
    return {
      status: 'credential-stored',
      attempt: null,
      links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
    }
  },
  async getBalance() {
    return {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '9.3517273800000000' }],
      bonusWallets: [{ currency: 'CNY', balance: '12.6168671600000000' }],
    }
  },
}

const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const ctx = {
  logger: { warn: (message) => process.stdout.write(`[warn] ${message}\n`) },
  on() {},
  get(name) {
    return name === 'deepseekAccount' ? account : undefined
  },
  inject(names, callback) {
    if (!names.includes('webServer')) throw new Error(`unexpected inject: ${names.join()}`)
    callback({
      effect(fn) {
        fn()
      },
      webServer,
    })
  },
}

const { apply, BALANCE_ROUTE, STATE_ROUTE, VERSION } = await import('../index.js')
apply(ctx)

/** Invoke a route handler and wait until it writes a response. */
async function call(handler, req) {
  const res = makeRes()
  handler(req, res)
  for (let attempt = 0; attempt < 200 && res.status === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return res
}

assert.deepEqual([...routes.keys()].sort(), [BALANCE_ROUTE, STATE_ROUTE].sort(), 'both routes are registered')

const handler = routes.get(BALANCE_ROUTE).handler
const res = await call(handler, { method: 'GET', url: `${BALANCE_ROUTE}?locale=zh-CN&tz=-480&force=1` })

assert.equal(res.status, 200)
assert.match(res.headers['Content-Type'], /application\/json/)
const body = JSON.parse(res.body)

process.stdout.write(`\nresponse:\n${JSON.stringify(body, null, 2)}\n`)

assert.equal(body.ok, true, 'balance succeeds')
assert.equal(body.wallets[0].balance, '9.3517273800000000')
assert.ok(body.usage !== undefined, 'the usage block rides along with the balance')
assert.equal(body.usage.available, true)
assert.equal(typeof body.usage.totalTokens, 'number')
assert.equal(typeof body.usage.cost, 'number')
assert.equal(body.usage.currency, 'CNY')
assert.ok(body.usage.totalTokens > 0, 'real usage was aggregated from the projection cache')
assert.equal(typeof body.usage.partial, 'boolean')
assert.equal(typeof body.usage.peak, 'boolean')
assert.ok(VERSION !== '1.0.0', 'version bumped past the balance-only release')

// HEAD / 405 behaviour.
const wrong = await call(handler, { method: 'POST', url: BALANCE_ROUTE })
assert.equal(wrong.status, 405)

// 未登录时：余额失败但 usage 仍在。
const signedOut = { ...ctx, get: () => ({ ...account, getState: async () => ({ status: 'signed-out' }) }) }
routes.clear()
apply(signedOut)
const out = await call(routes.get(BALANCE_ROUTE).handler, { method: 'GET', url: `${BALANCE_ROUTE}?force=1` })
const outBody = JSON.parse(out.body)
assert.equal(outBody.ok, false)
assert.equal(outBody.reason, 'signed-out')
assert.ok(outBody.usage !== undefined && outBody.usage.available === true, 'usage survives a signed-out balance')

process.stdout.write('signed-out response keys: ' + Object.keys(outBody).join(',') + '\n')

/* ------------------------------------------------------------ 合并平台用量 -- */

// 今天是当地零点对齐的那一格；平台按秒返回桶时间。
const tzSeconds = 8 * 3600
const localMidnightMs = Math.floor((Date.now() + tzSeconds * 1000) / 86_400_000) * 86_400_000 - tzSeconds * 1000
const bucketTime = Math.floor(localMidnightMs / 1000)
const todayKey = new Date(localMidnightMs + tzSeconds * 1000).toISOString().slice(0, 10)

const platformAccount = {
  ...account,
  async getPlatformSession() {
    return { origin: 'https://platform.deepseek.com', token: 'stub-token', userId: null }
  },
}

/** 只喂平台接口，其它 fetch 一律失败。 */
const fetchCalls = []
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
  const isCost = String(url).includes('/cost')
  const payload = isCost
    ? {
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            data: [
              {
                currency: 'CNY',
                series: [
                  {
                    api_key: { tracking_id: 'k1', name: 'CC SWITCH', sensitive_id: 'sk-zzzz0000' },
                    model: 'deepseek-v4-pro',
                    buckets: [{ time: bucketTime, cost: 1.25 }],
                  },
                ],
              },
            ],
          },
        },
      }
    : {
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            series: [
              {
                api_key: { tracking_id: 'k1', name: 'CC SWITCH', sensitive_id: 'sk-zzzz0000' },
                model: 'deepseek-v4-pro',
                buckets: [
                  {
                    time: bucketTime,
                    usage: {
                      PROMPT_CACHE_HIT_TOKEN: 1000,
                      PROMPT_CACHE_MISS_TOKEN: 200,
                      RESPONSE_TOKEN: 50,
                      REQUEST: 3,
                    },
                  },
                ],
              },
            ],
          },
        },
      }
  return { status: 200, text: async () => JSON.stringify(payload) }
}

routes.clear()
apply({ ...ctx, get: (name) => (name === 'deepseekAccount' ? platformAccount : undefined) })
const merged = await call(routes.get(BALANCE_ROUTE).handler, {
  method: 'GET',
  url: `${BALANCE_ROUTE}?locale=zh-CN&tz=-480&force=1`,
})
const mergedBody = JSON.parse(merged.body)
const usage = mergedBody.usage

process.stdout.write(`\nmerged usage:\n${JSON.stringify(usage.platform, null, 2)}\n`)

assert.equal(fetchCalls.length, 2, 'amount and cost are both requested')
assert.ok(fetchCalls.every((url) => url.includes('/usage/by_api_key/')), 'only the platform usage endpoints are called')
assert.equal(usage.source, 'merged', 'the usage block reports the merged source')
assert.equal(usage.platform.available, true)
assert.equal(usage.platform.today.tokens, 1250, 'today tokens = hit + miss + output')
assert.equal(usage.platform.today.requests, 3)
assert.equal(usage.platform.today.cost, 1.25, 'cost comes from the platform, not the price table')
assert.equal(usage.platform.days.length, 1, 'only days with buckets are reported')
assert.equal(usage.platform.days[0].date, todayKey)
assert.equal(usage.platform.keys[0].name, 'CC SWITCH')
assert.equal(usage.platform.own.name, undefined, 'the stub key is not the local DEEPSEEK_API_KEY')

// 总计 = 本机 + 平台今天
assert.equal(
  usage.totalTokens,
  usage.local.totalTokens + usage.platform.today.tokens,
  'totals add the local sessions and the platform keys',
)
assert.equal(usage.requests, usage.local.requests + usage.platform.today.requests)
assert.equal(
  usage.cacheReadTokens,
  usage.local.cacheReadTokens + usage.platform.today.hit,
  'hit tokens are summed across both sources',
)

process.stdout.write('\nall host assertions passed\n')
