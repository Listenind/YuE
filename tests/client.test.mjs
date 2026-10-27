// 客户端半边的冒烟测试：用最小 React / 浏览器替身跑一遍注册与各渲染分支。
//   node tests/client.test.mjs
import assert from 'node:assert/strict'

/* ---------------------------------------------------------------- 全局替身 -- */

const styles = []
globalThis.document = {
  querySelector: () => null,
  head: { appendChild: (tag) => styles.push(tag) },
  createElement: () => ({ dataset: {}, textContent: '' }),
}

let registration
globalThis.window = {
  __ModuleLoader__: { load: (reg) => (registration = reg) },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
}

/** 一个够用的 localStorage 替身：趋势图的历史存在这里。 */
const store = new Map()
globalThis.window.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
}

/* -------------------------------------------------------------- 假 React -- */

let seedStates = []
let effectList = []

function createElement(type, props, ...children) {
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || value === false) return
    if (Array.isArray(value)) value.forEach(push)
    else flat.push(value)
  }
  children.forEach(push)
  return { type, props: props ?? {}, children: flat }
}

/** 表示"这一格用 useState 的初值"，用来只覆盖靠后的 hook。 */
const INITIAL = Symbol('initial')

const React = {
  createElement,
  Fragment: 'Fragment',
  useState(initial) {
    const seeded = seedStates.length > 0 ? seedStates.shift() : INITIAL
    return [seeded === INITIAL ? initial : seeded, () => {}]
  },
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useEffect(fn) {
    effectList.push(fn)
  },
}

const requireStub = (specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require("${specifier}")`)
}

/* ------------------------------------------------------------------ 载入 -- */

await import('../lib/client.js')
assert.ok(registration, 'the bundle must register itself with the module loader')
assert.equal(registration.id, 'dsh-deepseek-balance-panel')

const mod = registration.factory(requireStub)
assert.equal(typeof mod.apply, 'function', 'client half must export apply')
assert.deepEqual(mod.inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])
assert.equal(styles.length, 1, 'the factory must inject exactly one style tag')
assert.ok(styles[0].textContent.includes('.dsb-pane'), 'style tag carries the panel css')

// HMR 会重新执行这个模块：页面上已经有一份旧样式表时，必须把手上的内容覆盖进去，
// 否则改颜色/间距不会生效（只能靠整页刷新）。这条曾经真的坏过——柱子一直是旧配色。
const stale = { dataset: {}, textContent: '.dsb-fill{opacity:.3}' }
globalThis.document.querySelector = () => stale
registration.factory(requireStub)
assert.ok(stale.textContent.includes('.dsb-pane'), 'a re-materialized module refreshes the stylesheet')
assert.doesNotMatch(stale.textContent, /opacity:\.3\b/, 'stale rules do not survive a reload')
assert.equal(styles.length, 1, 'an existing tag is reused, not duplicated')
globalThis.document.querySelector = () => null

/* ----------------------------------------------------------------- apply -- */

const tabDefinitions = []
const slotRegistrations = new Map()
const dictionary = { active: 'zh-CN' }

const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
  locale: {
    getSnapshot: () => dictionary,
    bind: () => (key) => `t:${key}`,
    register: (ns, dicts) => {
      assert.equal(ns, 'deepseekBalancePanel')
      assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), 'zh/en key sets must match')
      dictionary.dicts = dicts
      return () => {}
    },
  },
  slots: {
    inject: (name, callback) => callback(),
    register: (options, component) => {
      slotRegistrations.set(`${options.name}|${options.key}`, { options, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register: (definition) => {
      tabDefinitions.push(definition)
      return () => {}
    },
  },
  sidebarRight: {
    openTab: () => {
      throw new Error('no session surface is mounted')
    },
  },
}

mod.apply(ctx)

assert.equal(tabDefinitions.length, 1, 'exactly one tab type is registered')
const type = tabDefinitions[0]
assert.equal(type.id, 'dsh-deepseek-balance-panel')
assert.equal(type.kind, 'deepseek-balance-panel')
assert.equal(type.title(), 't:title')
assert.equal(type.guide.length, 1)
assert.equal(type.guide[0].title(), 't:guide.title')
assert.equal(type.guide[0].description(), 't:guide.description')

const body = slotRegistrations.get('sidebar.right.pane.tab|dsh-deepseek-balance-panel')
const title = slotRegistrations.get('sidebar.right.pane.tab.title|dsh-deepseek-balance-panel')
assert.ok(body, 'the pane body must register under the type id')
assert.ok(title, 'the chip title must register under the type id')
assert.equal(body.options.locale, 'deepseekBalancePanel')

/* ----------------------------------------------------------------- 渲染 -- */

/** 收集渲染树里的所有文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }))
  return node.children.map(textOf).join(' ')
}

/** 用给定首个状态渲染出整棵树。`extra` 用来覆盖靠后的 hook 初值。 */
function renderTree(state, extra = []) {
  seedStates = [state, ...extra]
  effectList = []
  const tree = body.component({ useTabInfo: () => ({ tab: { visible: true } }), t: (key) => `t:${key}` })
  for (const effect of effectList) effect()
  return tree
}

/** 用给定首个状态渲染一次面板文本。 */
function renderPanel(state, extra = []) {
  return textOf(renderTree(state, extra))
}

/** 取某个 class 的直接子节点。 */
function byClass(tree, className) {
  const found = tree.children.find((node) => node?.props?.className === className)
  assert.ok(found, `expected a .${className} block`)
  return found
}

const readyTree = renderTree({
  status: 'ready',
  data: {
    ok: true,
    wallets: [{ currency: 'CNY', balance: '9.35172738' }],
    bonusWallets: [{ currency: 'CNY', balance: '12.9752568' }],
    fetchedAt: 1792205932580,
    links: { topUpUrl: 'https://platform.deepseek.com/top_up', usageUrl: 'https://platform.deepseek.com/usage' },
  },
})
const ready = textOf(readyTree)
process.stdout.write(`ready      : ${ready}\n`)
assert.match(ready, /¥9\.35/, 'wallet amount is formatted to two decimals, rounded down')
assert.match(ready, /¥12\.97/, 'bonus amount is shown')
assert.match(ready, /t:bonus/, 'bonus label comes from the dictionary')
assert.match(ready, /t:updated/, 'the footer carries the refresh stamp')
assert.match(ready, /t:topUp/, 'top-up link is offered')
assert.doesNotMatch(ready, /t:retry/, 'a successful read offers no retry')

// 控制项必须待在「账户余额」那一行的右端：面板右下角被别的插件占着。
const head = byClass(readyTree, 'dsb-head')
const foot = byClass(readyTree, 'dsb-foot')
assert.match(textOf(head), /t:refresh/, 'the refresh button lives in the heading row')
assert.match(textOf(head), /t:total/, 'the heading row also carries the title')
assert.doesNotMatch(textOf(foot), /t:refresh/, 'the footer no longer holds the refresh button')
assert.doesNotMatch(textOf(foot), /t:retry/, 'the footer no longer holds the retry button')
assert.match(textOf(byClass(readyTree, 'dsb-card')), /¥9\.35/, 'the amount sits in the card below the heading')

const multi = renderPanel({
  status: 'ready',
  data: {
    ok: true,
    wallets: [
      { currency: 'CNY', balance: '1' },
      { currency: 'USD', balance: '0.001' },
    ],
    bonusWallets: [],
    fetchedAt: 1792205932580,
  },
})
process.stdout.write(`multi      : ${multi}\n`)
assert.match(multi, /¥1\.00/, 'an integer wallet still shows cents')
assert.match(multi, /<\$0\.01/, 'sub-cent amounts use the less-than form')
assert.doesNotMatch(multi, /t:bonus/, 'an empty bonus list renders no bonus row')

const signedOut = renderPanel({ status: 'ready', data: { ok: false, reason: 'signed-out' } })
process.stdout.write(`signedOut  : ${signedOut}\n`)
assert.match(signedOut, /t:signedOut\.hint/)
assert.doesNotMatch(signedOut, /t:retry/)

const unavailable = renderPanel({ status: 'ready', data: { ok: false, reason: 'unavailable' } })
process.stdout.write(`unavailable: ${unavailable}\n`)
assert.match(unavailable, /t:unavailable/)

const failed = renderPanel({ status: 'ready', data: { ok: false, reason: 'failed', message: 'boom' } })
process.stdout.write(`failed     : ${failed}\n`)
assert.match(failed, /t:failed/)
assert.match(failed, /boom/)
assert.match(failed, /t:retry/)

const transport = renderPanel({ status: 'error', error: 'HTTP 500' })
process.stdout.write(`transport  : ${transport}\n`)
assert.match(transport, /t:retry/)

const loading = renderPanel({ status: 'loading' })
process.stdout.write(`loading    : ${loading}\n`)
assert.match(loading, /t:loading/)
assert.doesNotMatch(loading, /t:retry/, 'the first load is not a failure')

/* --------------------------------------------------------- 点击刷新反馈 -- */

// 请求进行中：按钮变成「刷新中…」并禁用，状态点进入 busy。
const busyTree = renderTree(
  { status: 'ready', data: { ok: true, wallets: [{ currency: 'CNY', balance: '9.35' }], fetchedAt: 1 } },
  [INITIAL, true],
)
const busyText = textOf(busyTree)
process.stdout.write(`busy       : ${busyText}\n`)
assert.match(busyText, /t:refreshing/, 'the button says it is refreshing')
assert.doesNotMatch(busyText, /t:refresh\b/, 'the idle label is replaced while pending')
const busyButton = byClass(busyTree, 'dsb-head').children
  .find((node) => node?.props?.className === 'dsb-actions')
  .children.find((node) => node?.props?.key === 'refresh')
assert.equal(busyButton.props.disabled, true, 'the refresh button is disabled while pending')
assert.equal(busyButton.props['aria-busy'], 'true')
const busyDot = byClass(busyTree, 'dsb-head').children.find((node) => node?.props?.className === 'dsb-heading')
assert.match(textOf(busyDot), /t:total/)
assert.equal(busyDot.children[0].props['data-state'], 'busy', 'the status dot pulses while pending')

// 成功回执：页脚出现「已更新」，且和更新时间一起留在左侧。
const okTree = renderTree(
  { status: 'ready', data: { ok: true, wallets: [{ currency: 'CNY', balance: '9.35' }], fetchedAt: 1 } },
  [INITIAL, INITIAL, 'ok'],
)
const okFoot = textOf(byClass(okTree, 'dsb-foot'))
process.stdout.write(`flash ok   : ${okFoot}\n`)
assert.match(okFoot, /t:flash\.ok/, 'a successful click leaves a receipt')
assert.match(okFoot, /t:updated/, 'the receipt sits beside the timestamp')

// 失败回执：同一位置换成「更新失败」。
const errTree = renderTree(
  { status: 'ready', data: { ok: true, wallets: [{ currency: 'CNY', balance: '9.35' }], fetchedAt: 1 } },
  [INITIAL, INITIAL, 'error'],
)
const errFoot = textOf(byClass(errTree, 'dsb-foot'))
process.stdout.write(`flash err  : ${errFoot}\n`)
assert.match(errFoot, /t:flash\.error/)

// 没有回执时页脚不预留空壳。
assert.doesNotMatch(textOf(byClass(readyTree, 'dsb-foot')), /t:flash\./)

/* ------------------------------------------------------------- 今日用量 -- */

const USAGE = {
  day: '2026-10-17',
  available: true,
  totalTokens: 25957649,
  cacheReadTokens: 25664512,
  uncachedInputTokens: 167716,
  outputTokens: 125421,
  requests: 168,
  cost: 1.1827,
  currency: 'CNY',
  peak: false,
  partial: false,
}

const wallet = { ok: true, wallets: [{ currency: 'CNY', balance: '9.35' }], fetchedAt: 1 }
const usageTree = renderTree({ status: 'ready', data: { ...wallet, usage: USAGE } })
const usageText = textOf(usageTree)
process.stdout.write(`usage      : ${usageText}\n`)
assert.match(usageText, /t:usage\.today/, 'the block is titled 今日消耗')
assert.match(usageText, /25\.96M/, 'the total is compacted to M')
assert.match(usageText, /25\.66M/, 'cache-hit tokens are shown')
assert.match(usageText, /167.7K/, 'cache-miss tokens are compacted to K')
assert.match(usageText, /t:usage\.rate 99\.4%/, 'the hit rate is derived from hit / (hit + miss)')
assert.match(usageText, /≈¥1\.18/, 'the cost is shown as an estimate')
assert.match(usageText, /168 t:usage\.requestsUnit/, 'the API request count is shown')
assert.match(usageText, /t:usage\.offPeak/, 'the price band is disclosed')
assert.doesNotMatch(usageText, /t:usage\.partial/, 'a complete day carries no completeness warning')

// 用量块必须排在余额卡片下面。
const balanceIndex = usageTree.children.findIndex((node) => node?.props?.className === 'dsb-card')
const usageIndex = usageTree.children.findIndex((node) => node?.props?.className === 'dsb-usage')
assert.ok(usageIndex > balanceIndex, 'the usage block sits below the balance card')

// 命中/未命中占比条的宽度。
const bar = usageTree.children[usageIndex].children[1].children.find((node) => node?.props?.className === 'dsb-bar')
assert.equal(bar.children.length, 2, 'the bar has a hit segment and a miss segment')
const widths = bar.children.map((node) => Number.parseFloat(node.props.style.width))
assert.ok(Math.abs(widths[0] - 99.351) < 0.01, `hit segment is the hit rate (${widths[0]})`)
assert.ok(Math.abs(widths[0] + widths[1] - 100) < 1e-9, 'the two segments fill the bar')

// 用量卡片自己说清三段 token：输出不在输入侧占比条里，但单独占一格。
const usageChildren = usageTree.children[usageIndex].children
const split = usageChildren[1].children.find((node) => node?.props?.className === 'dsb-split')
assert.equal(split.children.length, 3, 'hit / miss / output are all listed')
assert.match(textOf(split), /t:usage\.output 125\.4K/, 'output tokens are shown next to hit and miss')

// 图表只留一张：重复的「今日构成」环形图已经删掉。
assert.equal(
  usageChildren.filter((node) => node?.props?.className === 'dsb-card dsb-chart').length,
  0,
  'the redundant composition chart is gone',
)

// 两路合并：本机 DSH 与平台 API Key 各占一行，成本相加。
const MERGED = {
  ...USAGE,
  source: 'merged',
  totalTokens: 30_000_000,
  cacheReadTokens: 28_000_000,
  uncachedInputTokens: 1_500_000,
  outputTokens: 500_000,
  requests: 300,
  local: {
    totalTokens: 25_960_000,
    cacheReadTokens: 25_664_512,
    uncachedInputTokens: 167_716,
    outputTokens: 125_421,
    requests: 168,
    cost: 1.18,
    available: true,
    // 通用来源细分：名字就是 agentPreset id，不假设是哪款插件。
    sources: [
      { source: 'cordis', totalTokens: 20_000_000, requests: 120, cost: 0.9 },
      { source: 'qq-fish', totalTokens: 5_960_000, requests: 48, cost: 0.28 },
    ],
  },
  platform: {
    available: true,
    currency: 'CNY',
    today: { tokens: 4_040_000, hit: 2_335_488, miss: 1_332_284, output: 374_579, requests: 132, cost: 1.89 },
    days: [],
    keys: [
      { name: 'CC SWITCH', tokens: 9_000_000, todayTokens: 3_000_000, todayCost: 1.2, cost: 1.2, requests: 90, own: false },
      { name: 'Deep Seek Hansen', tokens: 4_000_000, todayTokens: 1_040_000, todayCost: 0.69, cost: 0.69, requests: 42, own: true },
    ],
  },
}
const mergedText = textOf(renderTree({ status: 'ready', data: { ...wallet, usage: MERGED } }))
process.stdout.write(`merged     : ${mergedText}\n`)
assert.match(mergedText, /t:usage\.local 25\.96M · 168 t:usage\.requestsUnit/, 'the local half is broken out')
assert.match(mergedText, /t:usage\.sources cordis 20M · qq-fish 5\.96M/, 'local usage is split by agent preset')
assert.match(mergedText, /t:usage\.platform 4\.04M · 132 t:usage\.requestsUnit/, 'the platform half is broken out')
assert.match(mergedText, /t:usage\.keys CC SWITCH 3M · Deep Seek Hansen 1\.04M/, 'platform usage is split by API key')
assert.match(mergedText, /t:usage\.cost ≈¥3\.07/, 'cost adds the local estimate and the platform spend')
assert.match(mergedText, /300 t:usage\.requestsUnit/, 'the request total covers every source')
assert.match(mergedText, /t:usage\.mergedNote/, 'the merge is explained')
assert.doesNotMatch(mergedText, /t:usage\.platformOff/, 'no "platform unavailable" note when it is available')
assert.doesNotMatch(mergedText, /t:usage\.qq/, 'no plugin-specific row: the split is generic')

// 第三张图：按来源的今日排行（本机 preset + 平台 Key，同一个列表按用量排序）。
const mergedTree = renderTree({ status: 'ready', data: { ...wallet, usage: MERGED } })
const sourceCard = mergedTree.children[usageIndex].children.find((node) => node?.props?.className === 'dsb-card dsb-sources')
assert.ok(sourceCard, 'the source chart card is rendered')
const sourceText = textOf(sourceCard)
process.stdout.write(`sources    : ${sourceText}\n`)
assert.match(sourceText, /t:sources\.title/)
assert.match(sourceText, /cordis\s+20M\s+¥0\.9/i, 'local presets are ranked by tokens and priced')
assert.match(sourceText, /qq-fish\s+5\.96M\s+¥0\.28/, 'the bot shows up under its own preset id, with its cost')
assert.match(sourceText, /CC SWITCH\s+3M\s+¥1\.2/i, 'platform keys are ranked by today tokens and cost')
const rows = sourceCard.children.slice(1).map((row) => textOf(row))
assert.equal(rows[0].includes('cordis'), true, 'the biggest source comes first')
assert.equal(rows.length, 4, 'every non-zero source gets a row')

// 重叠口径：DSH 自己就用这把 Key 时，本机只是平台的一个子集，总计按平台算一次。
const overlapText = textOf(
  renderTree({
    status: 'ready',
    data: {
      ...wallet,
      usage: {
        ...MERGED,
        overlap: true,
        totalTokens: 4_040_000,
        cacheReadTokens: 2_335_488,
        uncachedInputTokens: 1_332_284,
        outputTokens: 374_579,
        requests: 132,
        cost: 1.89,
      },
    },
  }),
)
process.stdout.write(`overlap    : ${overlapText}\n`)
assert.match(overlapText, /t:usage\.localOverlap 25\.96M/, 'the local row says it is a subset')
assert.match(overlapText, /t:usage\.cost ≈¥1\.89/, 'cost is the platform spend only')
assert.match(overlapText, /t:usage\.dedupNote/, 'the de-duplication is explained')
assert.doesNotMatch(overlapText, /t:usage\.mergedNote/, 'no addition note when the totals overlap')

// 旧宿主（没有 overlap 字段）时客户端要能自己看出来：本机 4M vs 平台 4.04M → 同一批请求。
const inferredText = textOf(
  renderTree({
    status: 'ready',
    data: {
      ...wallet,
      usage: {
        ...MERGED,
        local: {
          ...MERGED.local,
          totalTokens: 4_000_000,
          cacheReadTokens: 2_300_000,
          uncachedInputTokens: 1_330_000,
          outputTokens: 370_000,
          requests: 130,
          cost: 1.8,
        },
      },
    },
  }),
)
process.stdout.write(`inferred   : ${inferredText}\n`)
assert.match(inferredText, /t:usage\.localOverlap/, 'a comparable local total is treated as the same traffic')
assert.match(inferredText, /t:usage\.cost ≈¥1\.89/, 'cost follows the platform, not local + platform')
assert.match(inferredText, /4\.04M t:usage\.unit/, 'the headline uses the platform total')

const offline = textOf(
  renderTree({
    status: 'ready',
    data: { ...wallet, usage: { ...USAGE, source: 'local', local: MERGED.local, platform: { available: false, reason: 'signed-out' } } },
  }),
)
assert.match(offline, /t:usage\.platformOff/, 'the fallback is disclosed')
assert.doesNotMatch(offline, /t:usage\.local /, 'no per-source rows without a platform half')

/* ------------------------------------------------------------- 近 7 天趋势 -- */

const HISTORY_KEY = 'dsh-deepseek-balance-panel/daily-v1'
/** 本机日期键，与客户端同一套算法。 */
function dayKeyFor(back) {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - back)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const seedHistory = (entries) => {
  store.set(HISTORY_KEY, JSON.stringify(entries))
}

// 有历史：7 根柱子，今天这根满高，没记录的日子留空位。
seedHistory({
  [dayKeyFor(0)]: { t: USAGE.totalTokens, c: 1.18 },
  [dayKeyFor(1)]: { t: USAGE.totalTokens / 2, c: 0.59 },
  [dayKeyFor(3)]: { t: 5_000_000, c: 0.23 },
})
const trendTree = renderTree({ status: 'ready', data: { ...wallet, usage: USAGE } })
const trendCard = trendTree.children[usageIndex].children.find(
  (node) => node?.props?.className === 'dsb-card dsb-trend',
)
assert.ok(trendCard, 'a 7-day trend card sits at the bottom of the panel')
const trendChildren = trendCard.children
const trendText = textOf(trendCard)
process.stdout.write(`trend      : ${trendText}\n`)
assert.match(trendText, /t:trend\.title/)
assert.match(trendText, /t:trend\.total ≈¥2\.00 · 3\/7/, 'the header sums the recorded days')
assert.match(trendText, /t:trend\.hint/, 'the note explains what an empty slot means')
// 统计条：日均按「有记录的天数」算，最高是峰值那天，较昨日拿昨天那根比。
assert.match(trendText, /t:trend\.avg 14\.65M/, 'the average only divides by recorded days')
assert.match(trendText, /t:trend\.peakDay 25\.96M/, 'the peak day value is shown')
assert.match(trendText, /t:trend\.vsYesterday \+100%/, 'today is compared against yesterday')

const columns = trendChildren[1].children
assert.equal(columns.length, 7, 'the window is always seven days wide')
const heights = columns.map((column) => column.children[0]?.props?.style?.height)
assert.equal(heights[6], '100%', "today's bar is the tallest recorded day")
assert.equal(heights[5], '50%', 'yesterday is scaled against the peak')
assert.equal(heights[4], undefined, 'a day with no record draws nothing')
assert.ok(heights[3] !== undefined, 'a record three days back still shows')
const axis = trendChildren[2].children
assert.equal(axis.length, 7, 'every bar gets a label')
assert.match(textOf(axis[6]), /t:trend\.today/, "today's column is labelled 今天")
assert.doesNotMatch(textOf(axis[5]), /t:trend\.today/)

// 记满一周：不再解释空格，统计条照旧。
seedHistory({
  [dayKeyFor(0)]: { t: 10_000_000, c: 1 },
  [dayKeyFor(1)]: { t: 9_000_000, c: 1 },
  [dayKeyFor(2)]: { t: 8_000_000, c: 1 },
  [dayKeyFor(3)]: { t: 7_000_000, c: 1 },
  [dayKeyFor(4)]: { t: 6_000_000, c: 1 },
  [dayKeyFor(5)]: { t: 5_000_000, c: 1 },
  [dayKeyFor(6)]: { t: 4_000_000, c: 1 },
})
const fullWeek = textOf(
  renderTree({
    status: 'ready',
    data: {
      ...wallet,
      usage: {
        ...USAGE,
        totalTokens: 10_000_000,
        cacheReadTokens: 9_000_000,
        uncachedInputTokens: 500_000,
        outputTokens: 500_000,
        cost: 1,
      },
    },
  }),
)
process.stdout.write(`full week  : ${fullWeek}\n`)
assert.doesNotMatch(fullWeek, /t:trend\.hint/, 'a full week needs no explanation of empty slots')
assert.match(fullWeek, /t:trend\.total ≈¥7\.00 · 7\/7/)
assert.match(fullWeek, /t:trend\.vsYesterday \+11%/, '10.0M against 9.0M is +11%')

// 没有历史：整张趋势卡片不出现，而不是画 7 个空槽。
store.clear()
const bareTrend = textOf(renderTree({ status: 'ready', data: { ...wallet, usage: USAGE } }))
assert.doesNotMatch(bareTrend, /t:trend\.title/, 'no recorded day means no trend card')

// 读到用量时会替今天记一笔（同一天覆盖成最新值）。
globalThis.window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, wallets: [], usage: USAGE }) })
renderTree({ status: 'ready', data: { ...wallet, usage: USAGE } })
await new Promise((resolve) => setImmediate(resolve))
const written = JSON.parse(store.get(HISTORY_KEY) ?? '{}')
assert.equal(written[dayKeyFor(0)]?.t, USAGE.totalTokens, 'a successful read records today')
assert.equal(typeof written[dayKeyFor(0)]?.c, 'number', 'the day also keeps its estimated cost')

// 没有输入 token 时不编造命中率，也不画条。
const emptyRate = textOf(renderTree({
  status: 'ready',
  data: { ...wallet, usage: { ...USAGE, cacheReadTokens: 0, uncachedInputTokens: 0, totalTokens: 125421 } },
}))
process.stdout.write(`no-input   : ${emptyRate}\n`)
assert.doesNotMatch(emptyRate, /t:usage\.rate \d/, 'no input tokens means no hit rate')

// 跨天会话的完整性提示。
const partial = textOf(renderTree({ status: 'ready', data: { ...wallet, usage: { ...USAGE, partial: true } } }))
process.stdout.write(`partial    : ${partial}\n`)
assert.match(partial, /t:usage\.partial/)

// 用量不可用时给一句说明，而不是 0。
const noUsage = textOf(renderTree({
  status: 'ready',
  data: { ...wallet, usage: { available: false, totalTokens: 0, requests: 0, cost: 0, currency: 'CNY' } },
}))
process.stdout.write(`no-usage   : ${noUsage}\n`)
assert.match(noUsage, /t:usage\.unavailable/)
assert.doesNotMatch(noUsage, /≈/, 'an unavailable block shows no amount')

// 高峰时段要换成另一句口径说明。
const peak = textOf(renderTree({ status: 'ready', data: { ...wallet, usage: { ...USAGE, peak: true } } }))
assert.match(peak, /t:usage\.peak/)

// 余额读取失败时，今日用量仍然照常显示。
const usageWithoutBalance = textOf(renderTree({
  status: 'ready',
  data: { ok: false, reason: 'signed-out', usage: USAGE },
}))
process.stdout.write(`usage-only : ${usageWithoutBalance}\n`)
assert.match(usageWithoutBalance, /t:usage\.today/, 'usage renders even when the balance is unavailable')
assert.match(usageWithoutBalance, /25\.96M/)

process.stdout.write(`title      : ${textOf(title.component({}))}\n`)
assert.equal(textOf(title.component({})), 't:title')

process.stdout.write('\nall client-half assertions passed\n')
