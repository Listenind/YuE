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

const { apply, BALANCE_ROUTE, STATE_ROUTE, UPDATE_ROUTE, VERSION, checkUpdate, compareVersions, installedSpec } =
  await import('../index.js')
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

assert.deepEqual(
  [...routes.keys()].sort(),
  [BALANCE_ROUTE, STATE_ROUTE, UPDATE_ROUTE].sort(),
  'balance, state and update routes are registered',
)

const handler = routes.get(BALANCE_ROUTE).handler
const res = await call(handler, { method: 'GET', url: `${BALANCE_ROUTE}?locale=zh-CN&tz=-480&force=1` })

assert.equal(res.status, 200)
assert.match(res.headers['Content-Type'], /application\/json/)
const body = JSON.parse(res.body)

process.stdout.write(`\nresponse:\n${JSON.stringify(body, null, 2)}\n`)

assert.equal(body.ok, true, 'balance succeeds')
assert.equal(body.version, VERSION, 'the payload carries the running plugin version')
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

// 本机按来源（agentPreset）分组，平台按 API Key 分组 —— 都是通用维度。
assert.ok(Array.isArray(usage.local.sources), 'local usage carries per-source groups')
assert.equal(typeof usage.local.sources.length, 'number')
assert.ok(Array.isArray(usage.platform.keys), 'platform usage carries per-key groups')
assert.ok(
  usage.platform.keys.every((key) => typeof key.todayTokens === 'number'),
  'each platform key reports its own share of today',
)

// 总计 = 本机 + 平台今天（来源细分只是展示，不参与加减）
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

// 本机各来源加起来必须等于本机总量（不能凭空多出来或漏掉）。
const sourceTotal = usage.local.sources.reduce((sum, entry) => sum + entry.totalTokens, 0)
assert.equal(sourceTotal, usage.local.totalTokens, 'per-source groups add up to the local total')

/* ------------------------------------------------------------------ 更新 -- */

process.stdout.write('\n-- update --\n')

// 版本比较：主次修订、预发布。
assert.ok(compareVersions('1.8.0', '1.7.4') > 0, 'a newer minor wins')
assert.equal(compareVersions('1.7.4', '1.7.4'), 0, 'equal versions compare equal')
assert.ok(compareVersions('1.7.4-rc.1', '1.7.4') < 0, 'a prerelease is older than its release')
assert.ok(compareVersions('1.7.10', '1.7.9') > 0, 'numeric comparison, not string')

/** 造一个只含本包依赖的 profile package.json。 */
const manifestOf = (spec) => JSON.stringify({ dependencies: { 'dsh-deepseek-balance-panel': spec } })

assert.equal(installedSpec(() => manifestOf('^1.7.0')).mode, 'npm', 'a semver range means npm')
assert.equal(installedSpec(() => manifestOf('github:Listenind/YuE#main')).mode, 'git', 'a GitHub spec means git')
assert.equal(installedSpec(() => manifestOf('file:plugins/dsh-deepseek-balance-panel')).mode, 'link', 'a local path means link')
assert.equal(installedSpec(() => manifestOf('https://example.com/x.tgz')).mode, 'npm', 'a tarball URL falls back to npm')
assert.equal(installedSpec(() => '{}').mode, 'unknown', 'not installed')

/** 一个假的 registry 响应。 */
const registryFetch = (version) => async () => ({ ok: true, json: async () => ({ version }) })

// 造一个「一定比当前新」的版本号，避免每次发版都要改这里的字面量。
const NEWER = (() => {
  const [major = 0, minor = 0] = VERSION.split('.').map(Number)
  return `${major}.${minor + 1}.0`
})()

const npmCheck = await checkUpdate({
  read: () => manifestOf('^1.7.0'),
  fetchImpl: registryFetch(NEWER),
  force: true,
})
process.stdout.write(`${JSON.stringify(npmCheck)}\n`)
assert.equal(npmCheck.mode, 'npm')
assert.equal(npmCheck.current, VERSION)
assert.equal(npmCheck.latest, NEWER)
assert.equal(npmCheck.available, true, 'a newer npm version is reported')
assert.equal(npmCheck.updateSpec, `dsh-deepseek-balance-panel@${NEWER}`, 'the update spec pins the new version')

const sameCheck = await checkUpdate({
  read: () => manifestOf('^1.7.0'),
  fetchImpl: registryFetch(VERSION),
  force: true,
})
assert.equal(sameCheck.available, false, 'the current version is not an update')

// 本地链接安装（开发者工作区）不提供更新按钮。
const linkCheck = await checkUpdate({ read: () => manifestOf('file:plugins/x'), force: true })
assert.equal(linkCheck.mode, 'link')
assert.equal(linkCheck.canUpdate, false, 'a linked dev copy is not updatable')
assert.equal(linkCheck.note, 'local-link')

// git 安装：去 GitHub 上的 package.json 取版本，updateSpec 原样回传。
const gitCheck = await checkUpdate({
  read: () => manifestOf('github:Listenind/YuE#main'),
  fetchImpl: async (url) => {
    assert.match(url, /raw\.githubusercontent\.com\/Listenind\/YuE\/main\/package\.json$/)
    return { ok: true, json: async () => ({ version: `${NEWER}` }) }
  },
  force: true,
})
assert.equal(gitCheck.mode, 'git')
assert.equal(gitCheck.latest, NEWER)
assert.equal(gitCheck.updateSpec, 'github:Listenind/YuE#main', 'git installs re-install the same spec')

// registry 不可达时不能把面板搞崩，只报告检查失败。
const failedCheck = await checkUpdate({
  read: () => manifestOf('^1.7.0'),
  fetchImpl: async () => {
    throw new Error('offline')
  },
  force: true,
})
assert.equal(failedCheck.ok, false)
assert.equal(failedCheck.note, 'check-failed')

// 路由本身也要挂上（GET 才允许）。
const updateRoute = routes.get(UPDATE_ROUTE)
assert.ok(updateRoute, `${UPDATE_ROUTE} must be registered`)
const updateReply = await call(updateRoute.handler, { method: 'GET', url: UPDATE_ROUTE })
const updateBody = JSON.parse(updateReply.body)
assert.ok([true, false].includes(updateBody.ok), 'the update route answers with a status')
assert.equal(updateBody.current, VERSION, 'the update route reports the running version')

process.stdout.write('\nall host assertions passed\n')
