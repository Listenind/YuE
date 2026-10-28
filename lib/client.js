/**
 * dsh-deepseek-balance-panel —— 客户端半边（浏览器 bundle，hand-written）。
 *
 * 形态说明：这不是 ESM 模块，而是 DSH 客户端模块加载器认识的 classic script ——
 * 执行时只向 `window.__ModuleLoader__` 登记一个 factory，模块体的副作用（这里就是
 * 注入一段样式表）在 factory **物化时**运行，导出表层交给 cordis Loader 当作
 * 一个普通 Client Plugin（`apply` + `inject`）去激活。
 *
 * 它做三件事：
 *   ① 向右侧栏的 tab 类型注册表登记一个页类型 `deepseek-balance`；
 *   ② 在 `sidebar.right.pane.tab` 的该类型格位里画出余额面板；
 *   ③ 首次激活时把该 tab 打开一次，让余额真的出现在右侧。
 *
 * 余额来自同源的 `/dsh-deepseek-balance-panel/balance`（由本包的 Host 半边提供），
 * 渲染层从不接触 Platform 凭证。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-balance-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const H = react.createElement

    /** 本实现在 tab 系统里的身份，也是正文与标题注册用的 key。 */
    const TAB_ID = 'dsh-deepseek-balance-panel'
    /** 页类型的 kind：`openTab(kind)` 用它定位实现。 */
    const TAB_KIND = 'deepseek-balance-panel'
    /** 本插件的语言命名空间。 */
    const NS = 'deepseekBalancePanel'
    /** 余额接口。 */
    const ENDPOINT = '/dsh-deepseek-balance-panel/balance'
    /** 更新检查接口（宿主去问 registry / GitHub，浏览器不直连）。 */
    const UPDATE_ENDPOINT = '/dsh-deepseek-balance-panel/update'
    /** 更新检查间隔：半天一次足够，别把 registry 当轮询用。 */
    const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000
    /** 面板可见时的自动刷新间隔。 */
    const REFRESH_MS = 30_000
    /** 手动刷新后「已更新」提示停留的时长。 */
    const FLASH_MS = 1800
    /**
     * 首次激活时是否自动把余额页开进右侧栏。
     * 设为 false 后只能从右侧栏「开始」页的入口手动打开。
     */
    const AUTO_OPEN = true
    /** 自动打开的尝试窗口：等会话的停靠面建好。 */
    const AUTO_OPEN_DELAY_MS = 900
    const AUTO_OPEN_RETRY_MS = 500
    const AUTO_OPEN_ATTEMPTS = 10

    /** 简体中文字典，也是 key 集合的唯一来源。 */
    const zh = {
      title: '余额明细',
      'guide.title': '余额明细',
      'guide.description': '余额与今日用量，实时刷新',
      refresh: '刷新',
      refreshing: '刷新中…',
      'flash.ok': '已更新',
      'flash.error': '更新失败',
      'flash.updateOk': '插件已更新，重启 DSH 生效',
      'flash.updateError': '插件更新失败',
      'update.available': '新版本 {v}',
      'update.action': '更新',
      'update.applying': '更新中…',
      retry: '重试',
      loading: '读取中…',
      updated: '更新于',
      bonus: '赠送余额',
      total: '账户余额',
      signedOut: '未登录 DeepSeek 账号',
      'signedOut.hint': '在「设置 → 账户」里登录后即可查看余额。',
      unavailable: '账号服务当前不可用',
      failed: '余额暂时读取失败',
      topUp: '充值',
      usage: '用量',
      'usage.today': '今日消耗',
      'usage.unit': 'tokens',
      'usage.hit': '命中',
      'usage.miss': '未命中',
      'usage.rate': '命中率',
      'usage.output': '输出',
      'usage.local': '本机 DSH',
      'usage.localOverlap': '其中本机 DSH',
      'usage.sources': '来源',
      'usage.keys': 'Key',
      'sources.title': '来源用量',
      'sources.hint': '今日 token',
      'sources.local': '本机',
      'sources.platform': '平台',
      'usage.platform': '平台 API Key',
      'usage.mergedNote': '总计 = 本机 DSH（估算）+ 平台全部 API Key（实扣）',
      'usage.dedupNote': '本机与平台是同一批 API Key 请求，总计按平台口径只算一次',
      'usage.platformOff': '平台用量暂不可用，只统计本机 DSH 会话',
      'trend.title': '近 7 天',
      'trend.today': '今天',
      'trend.total': '合计',
      'trend.avg': '日均',
      'trend.peakDay': '最高',
      'trend.vsYesterday': '较昨日',
      'trend.noBaseline': '—',
      'trend.missing': '没有记录',
      'trend.hint': '本机与平台重合时只算一次；没记录到用量的日子留空',
      'usage.cost': '今日消费',
      'usage.requests': 'API 请求',
      'usage.requestsUnit': '次',
      'usage.peak': '按高峰时段单价估算',
      'usage.offPeak': '按空闲时段单价估算',
      'usage.partial': '跨天会话有部分用量未计入',
      'usage.unavailable': '今日用量暂不可用',
    }

    /** English dictionary, same key set as `zh`. */
    const en = {
      title: 'Balance details',
      'guide.title': 'Balance details',
      'guide.description': 'Balance and today’s usage, live',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      'flash.ok': 'Updated',
      'flash.error': 'Update failed',
      'flash.updateOk': 'Plugin updated — restart DSH to apply',
      'flash.updateError': 'Plugin update failed',
      'update.available': 'New version {v}',
      'update.action': 'Update',
      'update.applying': 'Updating…',
      retry: 'Retry',
      loading: 'Loading…',
      updated: 'Updated',
      bonus: 'Bonus',
      total: 'Balance',
      signedOut: 'Not signed in to DeepSeek',
      'signedOut.hint': 'Sign in under Settings → Account to see the balance.',
      unavailable: 'Account service unavailable',
      failed: 'Could not read the balance',
      topUp: 'Top up',
      usage: 'Usage',
      'usage.today': 'Used today',
      'usage.unit': 'tokens',
      'usage.hit': 'Cache hit',
      'usage.miss': 'Cache miss',
      'usage.rate': 'Hit rate',
      'usage.output': 'Output',
      'usage.local': 'This machine',
      'usage.localOverlap': 'of which this machine',
      'usage.sources': 'Sources',
      'usage.keys': 'Keys',
      'sources.title': 'Usage by source',
      'sources.hint': 'today',
      'sources.local': 'Local',
      'sources.platform': 'Platform',
      'usage.platform': 'Platform keys',
      'usage.mergedNote': 'Total = this machine + all platform API keys (billed)',
      'usage.dedupNote': 'Local sessions are the same API-key traffic; the platform total counts them once',
      'usage.platformOff': 'Platform usage unavailable — local sessions only',
      'trend.title': 'Last 7 days',
      'trend.today': 'Today',
      'trend.total': 'Total',
      'trend.avg': 'Avg',
      'trend.peakDay': 'Peak',
      'trend.vsYesterday': 'vs yesterday',
      'trend.noBaseline': '—',
      'trend.missing': 'No record',
      'trend.hint': 'Overlapping local and platform usage counts once; empty days had no record',
      'usage.cost': 'Spent today',
      'usage.requests': 'API requests',
      'usage.requestsUnit': '',
      'usage.peak': 'Estimated at peak-hour rates',
      'usage.offPeak': 'Estimated at off-peak rates',
      'usage.partial': 'Part of a cross-day session is not counted',
      'usage.unavailable': 'Today’s usage is unavailable',
    }

    const css = `
.dsb-pane{--dsb-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,var(--dsw-static-deepseek-500,#4176e6));display:flex;flex-direction:column;gap:12px;box-sizing:border-box;height:100%;padding:16px;overflow:auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsb-head{display:flex;align-items:center;gap:8px;justify-content:space-between;flex:none;flex-wrap:nowrap}
.dsb-head>.dsb-actions{flex:none}
.dsb-heading{display:inline-flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;letter-spacing:.02em}
.dsb-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dsb-dot[data-state=ready]{background:var(--dsw-alias-state-success-primary)}
.dsb-dot[data-state=warn]{background:var(--dsw-alias-state-warn-primary)}
.dsb-dot[data-state=idle]{background:var(--dsw-alias-state-idle-primary)}
.dsb-dot[data-state=busy]{background:var(--dsb-accent);animation:dsb-pulse .9s ease-in-out infinite}
.dsb-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);flex:none}
.dsb-amount{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px;font-size:24px;font-weight:600;line-height:32px;font-variant-numeric:tabular-nums}
.dsb-amount>span+span::before{content:" + ";white-space:pre;color:var(--dsw-alias-label-secondary);font-size:16px;font-weight:400}
.dsb-row{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary)}
.dsb-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsb-bonus .dsb-value{color:var(--dsw-alias-state-success-primary)}
.dsb-divider{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsb-note{color:var(--dsw-alias-label-secondary)}
.dsb-note-title{color:var(--dsw-alias-label-primary);font-weight:500}
.dsb-hint{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsb-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsb-skeleton{color:var(--dsw-alias-label-secondary);animation:dsb-pulse 1.2s ease-in-out infinite}
@keyframes dsb-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.dsb-foot{display:flex;align-items:center;justify-content:flex-start;gap:8px;margin-top:auto;padding-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex:none}
.dsb-flash{font-size:12px;line-height:18px;animation:dsb-flash-in .12s ease-out}
.dsb-update{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;border:.5px solid var(--dsb-accent);background:color-mix(in srgb,var(--dsb-accent) 12%,transparent)}
.dsb-update-text{flex:1 1 auto;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsb-update-button{flex:0 0 auto;appearance:none;border:0;border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;line-height:18px;color:#fff;background:var(--dsb-accent);cursor:pointer}
.dsb-update-button:disabled{opacity:.6;cursor:default}
.dsb-flash[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.dsb-flash[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
@keyframes dsb-flash-in{0%{opacity:0}100%{opacity:1}}
.dsb-actions{display:inline-flex;align-items:center;gap:8px}
.dsb-button{appearance:none;box-sizing:border-box;padding:2px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsb-button:hover{background:var(--dsw-alias-bg-layer-2)}
.dsb-button:disabled{cursor:default;opacity:.65}
.dsb-button:focus-visible{outline:2px solid var(--dsb-accent);outline-offset:2px}
.dsb-link{color:var(--dsb-accent);text-decoration:none;font-size:12px;line-height:18px}
.dsb-link:hover{text-decoration:underline}
.dsb-link:focus-visible{outline:2px solid var(--dsb-accent);outline-offset:2px;border-radius:4px}
.dsb-usage{display:flex;flex-direction:column;gap:8px;flex:0 0 auto;min-height:0}
.dsb-notes{display:flex;flex-direction:column;gap:8px;flex:none}
.dsb-usage-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;letter-spacing:.02em}
.dsb-usage-rate{color:var(--dsw-alias-label-secondary);font-weight:400;font-variant-numeric:tabular-nums}
.dsb-usage-card{gap:10px}
.dsb-big{display:flex;align-items:baseline;gap:6px;min-width:0}
.dsb-big-value{font-size:24px;font-weight:600;line-height:32px;font-variant-numeric:tabular-nums}
.dsb-big-unit{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsb-bar{display:flex;gap:2px;height:6px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-bg-layer-2);flex:none}
.dsb-bar-hit{background:var(--dsw-alias-state-success-primary,#12a150);border-radius:999px}
.dsb-bar-miss{background:var(--dsw-alias-state-warn-primary,#d97706);border-radius:999px}
.dsb-split{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsb-split-item{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dsb-swatch{display:inline-block;width:6px;height:6px;border-radius:2px;flex:none}
.dsb-swatch[data-kind=hit]{background:var(--dsw-alias-state-success-primary,#12a150)}
.dsb-swatch[data-kind=miss]{background:var(--dsw-alias-state-warn-primary,#d97706)}
.dsb-split-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsb-kv{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary)}
.dsb-kv-value{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.dsb-note-line{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsb-chart{gap:8px;padding:12px 16px}
.dsb-chart-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;letter-spacing:.02em}
.dsb-chart-hint{font-weight:400;font-variant-numeric:tabular-nums}
.dsb-swatch[data-kind=output]{background:var(--dsb-accent)}
.dsb-trend{gap:10px;flex:0 0 auto;min-height:0}
.dsb-bars{display:flex;align-items:flex-end;gap:6px;min-width:0;flex:0 0 auto;height:clamp(96px,20vh,168px);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsb-col{display:flex;flex:1 1 0;align-items:flex-end;justify-content:center;min-width:0;height:100%}
.dsb-fill{display:block;width:100%;max-width:26px;border-radius:4px 4px 0 0;background:var(--dsb-accent);opacity:.78;transition:height .5s cubic-bezier(.2,.7,.3,1),opacity .15s ease}
.dsb-fill[data-today=true]{opacity:1}
.dsb-col:hover .dsb-fill{opacity:.92}
.dsb-col:hover .dsb-fill[data-today=true]{opacity:1}
.dsb-axis{display:flex;gap:6px;min-width:0;margin-top:5px}
.dsb-axis>*{flex:1 1 0;min-width:0}
.dsb-col-label{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px;text-align:center;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsb-col-label[data-today=true]{color:var(--dsw-alias-label-primary);font-weight:500}
.dsb-trend-stats{display:flex;flex-wrap:wrap;gap:2px 12px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.dsb-stat{display:inline-flex;align-items:baseline;gap:4px}
.dsb-stat-value{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.dsb-stat-value[data-trend=up]{color:var(--dsw-alias-state-warn-primary)}
.dsb-stat-value[data-trend=down]{color:var(--dsw-alias-state-success-primary)}
.dsb-trend-note{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px}
.dsb-sources{gap:8px}
.dsb-source{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px}
.dsb-source-name{flex:0 1 64px;min-width:34px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dsb-source-track{flex:1 1 auto;min-width:0;height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dsb-source-fill{display:block;height:100%;border-radius:999px;background:var(--dsb-accent);transition:width .5s cubic-bezier(.2,.7,.3,1)}
.dsb-source-value{flex:0 0 auto;display:flex;align-items:baseline;gap:5px;white-space:nowrap;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-size:11px}
.dsb-source-cost{color:var(--dsw-alias-label-secondary);font-size:10px}
@media (prefers-reduced-motion:reduce){.dsb-fill{transition:none}}
`

    const CSS_TAG = 'dsh-deepseek-balance-panel/BalancePane.css'
    if (typeof document !== 'undefined') {
      const selector = 'style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']'
      let tag = document.querySelector(selector)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-deepseek-balance-panel'
        tag.dataset.pluginCss = CSS_TAG
        document.head.appendChild(tag)
      }
      // 每次物化都要覆盖内容：HMR 重新执行本模块时，页面上还留着上一版样式表，
      // 只建一次的话改颜色/间距根本不会生效（结构变了、样式还是旧的）。
      tag.textContent = css
    }

    /**
     * 把十进制金额字符串按 Platform Web 的两位小数规则格式化。
     * @param {string} raw 服务返回的十进制字符串。
     * @param {string} symbol 货币符号。
     * @returns {string} 带千分位的金额文本。
     */
    function formatAmount(raw, symbol) {
      const value = Number(raw)
      if (!Number.isFinite(value)) return `${symbol}${raw}`
      if (value === 0) return `${symbol}0.00`
      if (value < 0) return `-${symbol}${group(Math.floor(Math.abs(value) * 100) / 100)}`
      if (value < 0.01) return `<${symbol}0.01`
      return `${symbol}${group(Math.floor(value * 100) / 100)}`
    }

    /**
     * 两位小数 + 千分位。
     * @param {number} value 非负金额。
     * @returns {string} 展示文本。
     */
    function group(value) {
      return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    /**
     * 货币符号。
     * @param {string} currency 币种。
     * @returns {string} 符号。
     */
    function symbolOf(currency) {
      return currency === 'USD' ? '$' : '¥'
    }

    /**
     * 时间戳 → 本地时:分:秒。
     * @param {number} at 毫秒时间戳。
     * @returns {string} 展示文本。
     */
    function clockOf(at) {
      try {
        return new Date(at).toLocaleTimeString(undefined, { hour12: false })
      } catch {
        return ''
      }
    }

    /**
     * 紧凑数字：`988` / `167.7K` / `25.96M`（约 4 位有效数字）。
     * @param {number} value 数值。
     * @returns {string} 展示文本。
     */
    function compact(value) {
      const abs = Math.abs(value)
      const digits = abs < 100 ? 2 : 1
      return value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
    }

    /**
     * token 数的紧凑写法。
     * @param {unknown} value 原始数值。
     * @returns {string} 展示文本。
     */
    function formatTokens(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0) return '—'
      if (number < 1000) return String(Math.round(number))
      if (number < 1_000_000) return `${compact(number / 1000)}K`
      if (number < 1_000_000_000) return `${compact(number / 1_000_000)}M`
      return `${compact(number / 1_000_000_000)}B`
    }

    /**
     * 命中占比（0-100），输入侧算。
     * @param {{ cacheReadTokens?: number, uncachedInputTokens?: number }} usage 用量块。
     * @returns {number | undefined} 百分比；没有输入 token 时为 undefined。
     */
    function hitRateOf(usage) {
      const hit = Number(usage?.cacheReadTokens)
      const miss = Number(usage?.uncachedInputTokens)
      if (!Number.isFinite(hit) || !Number.isFinite(miss)) return undefined
      const total = hit + miss
      if (total <= 0) return undefined
      return (hit / total) * 100
    }

    /** 本机每日历史在 `localStorage` 里的键。 */
    const HISTORY_KEY = 'dsh-deepseek-balance-panel/daily-v1'
    /** 趋势图显示多少天。 */
    const HISTORY_DAYS = 7
    /** 历史最多留多少天，防止一年以后变成一个巨大的 JSON。 */
    const HISTORY_KEEP = 40

    /**
     * 本地日期键 `YYYY-MM-DD`（按机器所在时区，跨天按本机零点算）。
     * @param {number} ms 毫秒时间戳。
     * @returns {string} 日期键。
     */
    function dayKeyOf(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /**
     * 读本机保存的每日历史。
     *
     * 只记「面板真的读到过」的那些天：没有打开 DSH 的日子不会凭空补一条，
     * 所以趋势图上的空格是诚实的空缺，不是 0。
     *
     * @returns {Record<string, { t: number, c: number }>} 日期 → 当天累计。
     */
    function readHistory() {
      try {
        const raw = window.localStorage.getItem(HISTORY_KEY)
        const parsed = raw === null ? undefined : JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') return parsed
      } catch {
        /* 无痕模式 / 存储被禁：当作没有历史 */
      }
      return {}
    }

    /**
     * 把今天本机 DSH 的最新累计写进本机历史；同一天以最后一次为准，并裁掉过旧的日期。
     *
     * 只记「本机」那半边：平台那半边每天都能从服务端重新取，混进来会重复计数。
     *
     * @param {Record<string, unknown> | undefined} usage Host 聚合出来的用量块。
     * @returns {void}
     */
    function rememberUsage(usage) {
      if (usage === undefined || usage === null || usage.available !== true) return
      const local = usage.local !== undefined && usage.local !== null ? usage.local : usage
      const total = Number(local.totalTokens) || 0
      if (total <= 0) return
      try {
        const history = readHistory()
        const key = dayKeyOf(Date.now())
        const entry = { t: total, c: Number(local.cost) || 0 }
        const previous = history[key]
        // 30 秒一次的轮询里，数字没变就不必回写。
        if (previous !== undefined && previous.t === entry.t && previous.c === entry.c) return
        history[key] = entry
        const keys = Object.keys(history).sort()
        for (const stale of keys.slice(0, Math.max(0, keys.length - HISTORY_KEEP))) delete history[stale]
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
      } catch {
        /* 写不进去就算了：趋势图退化成只有今天一根柱子 */
      }
    }

    /**
     * 近 N 天的每日消耗柱状图。
     *
     * 数据来自两处，同一格里相加：
     *   - 平台按天的 API Key 用量（覆盖 CC Switch 等其它客户端）；
     *   - 本机历史（每次面板成功读到用量时记一笔，代表 DSH 自己的会话）。
     *
     * @param {(key: string) => string} t 绑定本命名空间的翻译。
     * @param {Record<string, any> | undefined} usage Host 返回的用量块。
     * @param {number} now 当前毫秒时间戳。
     * @returns {import('react').ReactElement | null} 卡片；没有任何记录时返回 null。
     */
    function renderTrendChart(t, usage, now = Date.now()) {
      const history = readHistory()
      const platformDays =
        usage?.platform?.available === true && Array.isArray(usage.platform.days) ? usage.platform.days : undefined
      const platformByDay = new Map()
      for (const day of platformDays ?? []) {
        if (typeof day?.date === 'string') platformByDay.set(day.date, day)
      }

      // 本机与平台是不是同一批请求（DSH 自己用 API Key）。是的话同一天只能算一次，取两者较大值，
      // 否则「本机历史 + 平台当天」会把同一批 token 加两遍（实测正好翻倍）。
      const localToday = Number(usage?.local?.totalTokens) || 0
      const platformToday = Number(usage?.platform?.today?.tokens) || 0
      const overlap =
        usage?.overlap === true ||
        (platformToday > 0 && localToday > 0 && localToday / platformToday >= 0.4 && localToday / platformToday <= 1.6)

      /** @type {{ key: string, label: string, total: number, cost: number, today: boolean }[]} */
      const columns = []
      for (let back = HISTORY_DAYS - 1; back >= 0; back -= 1) {
        const at = new Date(now)
        at.setHours(0, 0, 0, 0)
        at.setDate(at.getDate() - back)
        const key = dayKeyOf(at.getTime())
        const entry = history[key]
        const remote = platformByDay.get(key)
        const localTokens = entry === undefined ? 0 : Math.max(0, Number(entry.t) || 0)
        const localCost = entry === undefined ? 0 : Math.max(0, Number(entry.c) || 0)
        const remoteTokens = remote === undefined ? 0 : Math.max(0, Number(remote.tokens) || 0)
        const remoteCost = remote === undefined ? 0 : Math.max(0, Number(remote.cost) || 0)
        columns.push({
          key,
          label: `${at.getMonth() + 1}/${at.getDate()}`,
          total: overlap ? Math.max(localTokens, remoteTokens) : localTokens + remoteTokens,
          cost: overlap ? Math.max(localCost, remoteCost) : localCost + remoteCost,
          today: key === dayKeyOf(now),
        })
      }

      let peak = 0
      let spent = 0
      let recorded = 0
      for (const column of columns) {
        if (column.total > peak) peak = column.total
        if (column.total > 0) recorded += 1
        spent += column.cost
      }
      if (peak <= 0) return null

      const bars = columns.map((column) =>
        H(
          'div',
          {
            key: column.key,
            className: 'dsb-col',
            title:
              column.total > 0
                ? `${column.label}${column.today ? ` ${t('trend.today')}` : ''} · ${formatTokens(column.total)} ${t('usage.unit')} · ≈${formatAmount(column.cost, '¥')}`
                : `${column.label} · ${t('trend.missing')}`,
          },
          column.total > 0
            ? H('span', {
                key: 'fill',
                className: 'dsb-fill',
                'data-today': column.today ? 'true' : 'false',
                style: { height: `${Math.max(8, Math.round((column.total / peak) * 100))}%` },
              })
            : null,
        ),
      )

      const labels = columns.map((column) =>
        H(
          'span',
          { key: column.key, className: 'dsb-col-label', 'data-today': column.today ? 'true' : 'false' },
          column.today ? t('trend.today') : column.label,
        ),
      )

      // 统计条：只在记满两天以上时出现——一天的「日均」就是这个数，没有信息量。
      /** @type {import('react').ReactNode[]} */
      const stats = []
      if (recorded > 1) {
        let sum = 0
        /** @type {{ label: string, total: number } | undefined} */
        let top
        for (const column of columns) {
          if (column.total <= 0) continue
          sum += column.total
          if (top === undefined || column.total > top.total) top = { label: column.label, total: column.total }
        }
        stats.push(
          H('span', { key: 'avg', className: 'dsb-stat' }, [
            H('span', { key: 'label' }, t('trend.avg')),
            H('span', { key: 'value', className: 'dsb-stat-value' }, formatTokens(sum / recorded)),
          ]),
        )
        if (top !== undefined) {
          stats.push(
            H(
              'span',
              {
                key: 'peak',
                className: 'dsb-stat',
                title: `${top.label} · ${top.total.toLocaleString()} ${t('usage.unit')}`,
              },
              [
                H('span', { key: 'label' }, t('trend.peakDay')),
                H('span', { key: 'value', className: 'dsb-stat-value' }, formatTokens(top.total)),
              ],
            ),
          )
        }

        const todayColumn = columns[columns.length - 1]
        const yesterday = columns[columns.length - 2]
        const delta =
          yesterday !== undefined && yesterday.total > 0 && todayColumn !== undefined
            ? ((todayColumn.total - yesterday.total) / yesterday.total) * 100
            : undefined
        stats.push(
          H('span', { key: 'delta', className: 'dsb-stat' }, [
            H('span', { key: 'label' }, t('trend.vsYesterday')),
            H(
              'span',
              {
                key: 'value',
                className: 'dsb-stat-value',
                'data-trend': delta === undefined ? 'flat' : delta >= 0 ? 'up' : 'down',
              },
              delta === undefined
                ? t('trend.noBaseline')
                : `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`,
            ),
          ]),
        )
      }

      return H('div', { key: 'trend', className: 'dsb-card dsb-trend' }, [
        H('div', { key: 'head', className: 'dsb-chart-head' }, [
          H('span', { key: 'title' }, t('trend.title')),
          H(
            'span',
            { key: 'total', className: 'dsb-chart-hint' },
            recorded > 1 ? `${t('trend.total')} ≈${formatAmount(spent, '¥')} · ${recorded}/${HISTORY_DAYS}` : '',
          ),
        ]),
        H('div', { key: 'bars', className: 'dsb-bars' }, bars),
        H('div', { key: 'axis', className: 'dsb-axis' }, labels),
        stats.length === 0 ? null : H('div', { key: 'stats', className: 'dsb-trend-stats' }, stats),
        // 只有还缺天的时候才解释空格，记满一周就不占这行了。
        recorded < HISTORY_DAYS ? H('div', { key: 'note', className: 'dsb-trend-note' }, t('trend.hint')) : null,
      ])
    }

    /**
     * 今日「按来源」的 token 排行（横向条）。
     *
     * 来源是通用维度：本机按会话的 agentPreset 分组（机器人会以它自己的 preset id 出现，
     * 例如 `qq-fish`），平台按 API Key 分组（小号 / 脚本用自己的 Key 就单独一行）。
     * 这里不猜任何具体插件，只把宿主给的 `local.sources` 和 `platform.keys` 画出来。
     *
     * @param {(key: string) => string} t 绑定本命名空间的翻译。
     * @param {Record<string, any> | undefined} usage Host 返回的用量块。
     * @returns {import('react').ReactElement | null} 卡片；今天没有任何来源时返回 null。
     */
    function renderSourceChart(t, usage) {
      const localSources = Array.isArray(usage?.local?.sources) ? usage.local.sources : []
      const platformKeys = usage?.platform?.available === true && Array.isArray(usage.platform.keys) ? usage.platform.keys : []
      const symbol = symbolOf(typeof usage?.platform?.currency === 'string' ? usage.platform.currency : usage?.currency)

      /** @type {{ name: string, tokens: number, cost: number | null, kind: 'local' | 'platform' }[]} */
      const entries = []
      for (const entry of localSources) {
        const tokens = Number(entry?.totalTokens) || 0
        if (tokens > 0) entries.push({ name: String(entry?.source ?? ''), tokens, cost: Number(entry?.cost) || 0, kind: 'local' })
      }
      for (const key of platformKeys) {
        const tokens = Number(key?.todayTokens) || 0
        // 旧宿主还没有 todayCost：宁可不显示金额，也别显示一个假的 0.00。
        const todayCost = key?.todayCost === undefined || key?.todayCost === null ? null : Number(key.todayCost) || 0
        if (tokens > 0) entries.push({ name: String(key?.name ?? ''), tokens, cost: todayCost, kind: 'platform' })
      }
      if (entries.length === 0) return null

      entries.sort((a, b) => b.tokens - a.tokens)
      const top = entries[0].tokens

      return H('div', { key: 'sources', className: 'dsb-card dsb-sources' }, [
        H('div', { key: 'head', className: 'dsb-chart-head' }, [
          H('span', { key: 'title' }, t('sources.title')),
          H('span', { key: 'hint', className: 'dsb-chart-hint' }, t('sources.hint')),
        ]),
        ...entries.slice(0, 6).map((entry) =>
          H(
            'div',
            {
              key: `${entry.kind}:${entry.name}`,
              className: 'dsb-source',
              title: `${entry.kind === 'platform' ? t('sources.platform') : t('sources.local')} · ${entry.name} · ${entry.tokens.toLocaleString()} ${t('usage.unit')}${entry.cost === null ? '' : ` · ${symbol}${entry.cost.toFixed(2)}`}`,
            },
            [
              H('span', { key: 'name', className: 'dsb-source-name' }, entry.name),
              H('span', { key: 'track', className: 'dsb-source-track' }, [
                H('span', {
                  key: 'fill',
                  className: 'dsb-source-fill',
                  'data-kind': entry.kind,
                  style: { width: `${Math.max(2, Math.round((entry.tokens / top) * 100))}%` },
                }),
              ]),
              H('span', { key: 'value', className: 'dsb-source-value' }, [
                H('span', { key: 'tokens' }, formatTokens(entry.tokens)),
                entry.cost === null ? null : H('span', { key: 'cost', className: 'dsb-source-cost' }, `${symbol}${entry.cost.toFixed(2)}`),
              ]),
            ],
          ),
        ),
      ])
    }

    /**
     * 今日用量卡片：总消耗、命中/未命中占比条、金额与请求次数。
     * @param {Record<string, unknown> | undefined} usage Host 聚合出来的用量块。
     * @param {(key: string) => string} t 绑定本命名空间的翻译。
     * @returns {import('react').ReactElement | null} 卡片；没有用量数据时返回 null。
     */
    function renderUsageBlock(usage, t) {
      if (usage === undefined || usage === null || typeof usage !== 'object') return null

      const available = usage.available === true
      const peak = usage.peak === true

      // 两个来源：本机 DSH 会话与平台全部 API Key（含 CC Switch 等）。
      const platform = usage.platform !== undefined && usage.platform !== null && usage.platform.available === true
        ? usage.platform
        : undefined
      const localBlock = usage.local !== undefined && usage.local !== null ? usage.local : undefined
      const localTokensRaw = localBlock === undefined ? Number(usage.totalTokens) || 0 : Number(localBlock.totalTokens) || 0
      const platformTodayRaw = Number(platform?.today?.tokens) || 0

      // DSH 自己用 API Key 推理时，本机与平台是同一批请求，不能相加。
      // 宿主会给出 overlap；旧宿主没有这个字段时，用「两数量级相当」做一次兜底判断。
      const overlap =
        usage.overlap === true ||
        (platform !== undefined && localTokensRaw > 0 && platformTodayRaw > 0 && localTokensRaw / platformTodayRaw >= 0.4 && localTokensRaw / platformTodayRaw <= 1.6)

      const hit = overlap ? Number(platform?.today?.hit) || 0 : Number(usage.cacheReadTokens) || 0
      const miss = overlap ? Number(platform?.today?.miss) || 0 : Number(usage.uncachedInputTokens) || 0
      const output = overlap ? Number(platform?.today?.output) || 0 : Number(usage.outputTokens) || 0
      const total = overlap ? platformTodayRaw : Number(usage.totalTokens) || 0
      const requests = overlap ? Number(platform?.today?.requests) || 0 : Number(usage.requests) || 0
      const cost = overlap ? Number(platform?.today?.cost) || 0 : Number(usage.cost) || 0
      const currency = typeof usage.currency === 'string' ? usage.currency : 'CNY'
      const rate = hitRateOf(overlap ? { cacheReadTokens: hit, uncachedInputTokens: miss } : usage)

      const localTokens = localTokensRaw
      const localRequests = localBlock === undefined ? requests : Number(localBlock.requests) || 0
      const localCost = localBlock === undefined ? cost : Number(localBlock.cost) || 0
      // 本机按会话来源（agentPreset）分，平台按 API Key 分 —— 都是通用维度，
      // 不假设对面是机器人、小号还是别的什么工具。
      const localSources = Array.isArray(localBlock?.sources)
        ? localBlock.sources
            .map((entry) => ({ name: String(entry?.source ?? ''), tokens: Number(entry?.totalTokens) || 0 }))
            .filter((entry) => entry.name !== '' && entry.tokens > 0)
        : []
      const platformToday = platform?.today
      const platformCurrency = typeof platform?.currency === 'string' ? platform.currency : currency
      const platformTokens = Number(platformToday?.tokens) || 0
      const platformRequests = Number(platformToday?.requests) || 0
      const platformCost = Number(platformToday?.cost) || 0
      const platformKeys = Array.isArray(platform?.keys)
        ? platform.keys
            .map((entry) => ({ name: String(entry?.name ?? ''), tokens: Number(entry?.todayTokens) || 0 }))
            .filter((entry) => entry.name !== '' && entry.tokens > 0)
        : []
      const merged = platform !== undefined

      /** 一行"标签 + 前三个来源"，超过三个就用 +N 收尾。 */
      const detailLine = (key, label, entries) => {
        const shown = entries.slice(0, 3).map((entry) => `${entry.name} ${formatTokens(entry.tokens)}`)
        const rest = entries.length > 3 ? ` +${entries.length - 3}` : ''
        return H('div', { key, className: 'dsb-note-line' }, `${label} ${shown.join(' · ')}${rest}`)
      }

      /** @type {import('react').ReactNode[]} */
      const body = []
      if (!available) {
        body.push(H('div', { key: 'na', className: 'dsb-note-line' }, t('usage.unavailable')))
      } else {
        body.push(
          H('div', { key: 'big', className: 'dsb-big' }, [
            H('span', { key: 'value', className: 'dsb-big-value' }, formatTokens(total)),
            H('span', { key: 'unit', className: 'dsb-big-unit' }, t('usage.unit')),
          ]),
          H(
            'div',
            { key: 'bar', className: 'dsb-bar' },
            rate === undefined
              ? []
              : [
                  H('span', { key: 'hit', className: 'dsb-bar-hit', style: { width: `${Math.max(rate, 0)}%` } }),
                  H('span', {
                    key: 'miss',
                    className: 'dsb-bar-miss',
                    style: { width: `${Math.max(100 - Math.max(rate, 0), 0)}%` },
                  }),
                ],
          ),
          H('div', { key: 'split', className: 'dsb-split' }, [
            H('span', { key: 'hit', className: 'dsb-split-item' }, [
              H('i', { key: 'swatch', className: 'dsb-swatch', 'data-kind': 'hit' }),
              H('span', { key: 'label' }, t('usage.hit')),
              H('span', { key: 'value', className: 'dsb-split-value' }, formatTokens(hit)),
            ]),
            H('span', { key: 'miss', className: 'dsb-split-item' }, [
              H('i', { key: 'swatch', className: 'dsb-swatch', 'data-kind': 'miss' }),
              H('span', { key: 'label' }, t('usage.miss')),
              H('span', { key: 'value', className: 'dsb-split-value' }, formatTokens(miss)),
            ]),
            // 输出不在上面那根输入侧占比条里，但总量包含它，所以这里单独列出来。
            H('span', { key: 'output', className: 'dsb-split-item' }, [
              H('i', { key: 'swatch', className: 'dsb-swatch', 'data-kind': 'output' }),
              H('span', { key: 'label' }, t('usage.output')),
              H('span', { key: 'value', className: 'dsb-split-value' }, formatTokens(output)),
            ]),
          ]),
          H('div', { key: 'divider', className: 'dsb-divider' }),
          // 合并口径时把两路分开列；重叠时本机只是“其中”的一部分，不再相加。
          merged
            ? H('div', { key: 'local', className: 'dsb-kv' }, [
                H('span', { key: 'label' }, t(overlap ? 'usage.localOverlap' : 'usage.local')),
                H(
                  'span',
                  { key: 'value', className: 'dsb-kv-value' },
                  `${formatTokens(localTokens)} · ${localRequests.toLocaleString()} ${t('usage.requestsUnit')}`.trim(),
                ),
              ])
            : null,
          // 本机按会话来源细分（preset id 原样展示：qq-fish、cordis、standard……）。
          merged && localSources.length > 1 ? detailLine('local-sources', t('usage.sources'), localSources) : null,
          merged
            ? H('div', { key: 'platform', className: 'dsb-kv' }, [
                H('span', { key: 'label' }, t('usage.platform')),
                H(
                  'span',
                  { key: 'value', className: 'dsb-kv-value' },
                  `${formatTokens(platformTokens)} · ${platformRequests.toLocaleString()} ${t('usage.requestsUnit')}`.trim(),
                ),
              ])
            : null,
          // 平台按 API Key 细分：谁（哪个 Key）今天用了多少，一眼看出是哪把在小号上跑。
          merged && platformKeys.length > 1 ? detailLine('platform-keys', t('usage.keys'), platformKeys) : null,
          H('div', { key: 'cost', className: 'dsb-kv' }, [
            H('span', { key: 'label' }, t('usage.cost')),
            H(
              'span',
              { key: 'value', className: 'dsb-kv-value' },
              merged
                ? overlap
                  ? `≈${formatAmount(platformCost, symbolOf(platformCurrency))}`
                  : `≈${formatAmount(localCost + platformCost, symbolOf(platformCurrency))}`
                : `≈${formatAmount(localCost, symbolOf(currency))}`,
            ),
          ]),
          H('div', { key: 'requests', className: 'dsb-kv' }, [
            H('span', { key: 'label' }, t('usage.requests')),
            H(
              'span',
              { key: 'value', className: 'dsb-kv-value' },
              `${requests.toLocaleString()} ${t('usage.requestsUnit')}`.trim(),
            ),
          ]),
        )
      }

      /** @type {import('react').ReactNode[]} */
      const notes = []
      if (available) {
        // 重叠时总价是平台实扣，那行“按 X 段单价估算”对本机已无意义，换成去重说明。
        if (overlap) {
          notes.push(H('div', { key: 'scope', className: 'dsb-note-line' }, t('usage.dedupNote')))
        } else {
          notes.push(H('div', { key: 'band', className: 'dsb-note-line' }, t(peak ? 'usage.peak' : 'usage.offPeak')))
          notes.push(
            H('div', { key: 'scope', className: 'dsb-note-line' }, t(merged ? 'usage.mergedNote' : 'usage.platformOff')),
          )
        }
      }
      if (usage.partial === true) {
        notes.push(H('div', { key: 'partial', className: 'dsb-note-line' }, t('usage.partial')))
      }

      // 趋势图排在用量卡片和口径说明之后：它讲的是「这几天」，和上面「今天」的块分开。
      const trend = renderTrendChart(t, usage)
      // 第三张图：今天各来源的 token 排行（机器人 = 它那个 preset 的一行）。
      const sources = renderSourceChart(t, usage)

      return H('div', { key: 'usage', className: 'dsb-usage' }, [
        H('div', { key: 'head', className: 'dsb-usage-head' }, [
          H('span', { key: 'title' }, t('usage.today')),
          H(
            'span',
            { key: 'rate', className: 'dsb-usage-rate' },
            rate === undefined ? '' : `${t('usage.rate')} ${rate.toFixed(1)}%`,
          ),
        ]),
        H('div', { key: 'card', className: 'dsb-card dsb-usage-card' }, body),
        notes.length === 0 ? null : H('div', { key: 'notes', className: 'dsb-notes' }, notes),
        trend,
        sources,
      ])
    }

    /**
     * 造一个绑定本次激活的余额面板组件。
     * @param {{ locale: { getSnapshot: () => { active: string } } }} ctx 客户端上下文，用来读当前语言。
     * @returns {import('react').FunctionComponent} 面板组件。
     */
    function createBody(ctx) {
      /**
       * 右侧栏里的余额面板。
       * @param {{ useTabInfo?: () => { tab?: { visible?: boolean } }, t: (key: string) => string }} props 槽位注入的 props。
       * @returns {import('react').ReactElement} 面板。
       */
      return function BalanceBody({ useTabInfo, t }) {
        // 只有真正看得见时才轮询：折叠、切走、被别的 tab 盖住都停。
        let visible = true
        try {
          const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
          visible = info?.tab?.visible === true
        } catch {
          visible = true
        }

        const [snapshot, setSnapshot] = react.useState({ status: 'loading', data: undefined, error: undefined })
        // 每次点击「刷新/重试」都换一个新请求：`force` 会绕过 Host 的 15 秒缓存，
        // 保证时间戳真的走动，而不是命中缓存后"看起来没反应"。
        const [request, setRequest] = react.useState({ id: 0, force: false })
        const [pending, setPending] = react.useState(false)
        const [flash, setFlash] = react.useState(null)
        const reload = react.useCallback(() => setRequest((current) => ({ id: current.id + 1, force: true })), [])

        // ---- 插件自身的新版本 ----
        const [update, setUpdate] = react.useState(undefined)
        const [applying, setApplying] = react.useState(false)

        /**
         * 问宿主有没有新版本；失败就静默（更新提示不该打扰看余额）。
         * @returns {void}
         */
        const checkForUpdate = react.useCallback(() => {
          window
            .fetch(UPDATE_ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((value) => {
              if (value?.ok === true) setUpdate(value)
            })
            .catch(() => {})
        }, [])

        react.useEffect(() => {
          checkForUpdate()
          const timer = window.setInterval(checkForUpdate, UPDATE_CHECK_MS)
          return () => window.clearInterval(timer)
        }, [checkForUpdate])

        /**
         * 一键更新：调 DSH 的 pluginManager.installBundle（与「添加插件」同一管线）。
         * 装完不自动重启——宿主半边要重启才生效，交给用户决定。
         * @returns {Promise<void>}
         */
        const applyUpdate = react.useCallback(async () => {
          if (applying || update?.updateSpec === undefined) return
          setApplying(true)
          try {
            const manager = ctx.remote !== undefined ? ctx.remote.pluginManager : undefined
            if (manager === undefined) throw new Error('pluginManager unavailable')
            const result = await manager.installBundle(update.updateSpec, { enabled: true })
            if (result === undefined || result.ok !== true) {
              throw new Error(String(result?.error?.message ?? 'install failed'))
            }
            setUpdate({ ...update, available: false, applied: true })
            setFlash('updateOk')
          } catch (error) {
            setUpdate({ ...update, applyingError: error instanceof Error ? error.message : String(error) })
            setFlash('updateError')
          } finally {
            setApplying(false)
            window.setTimeout(() => setFlash(null), FLASH_MS * 2)
          }
        }, [applying, update])

        react.useEffect(() => {
          let cancelled = false
          let timer
          let flashTimer
          // 只有用户点出来的那一次请求需要"点击反馈"；同一轮里的轮询不再闪。
          let first = true

          const run = () => {
            const manual = request.force === true && first
            first = false
            let query = ''
            try {
              const active = ctx.locale.getSnapshot().active
              query = `?locale=${encodeURIComponent(active)}&tz=${encodeURIComponent(String(new Date().getTimezoneOffset()))}`
            } catch {
              query = ''
            }
            if (manual) query += `${query === '' ? '?' : '&'}force=1`
            setPending(true)
            /** @param {'ok' | 'error'} outcome 本次请求的结果，只用于用户点击的提示。 */
            const settle = (outcome) => {
              if (cancelled) return
              setPending(false)
              if (!manual) return
              setFlash(outcome)
              flashTimer = window.setTimeout(() => {
                if (!cancelled) setFlash(null)
              }, FLASH_MS)
            }
            window
              .fetch(ENDPOINT + query, { cache: 'no-store', headers: { accept: 'application/json' } })
              .then((response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return response.json()
              })
              .then((data) => {
                if (cancelled) return
                setSnapshot({ status: 'ready', data, error: undefined })
                // 顺手把今天这一格写进本机历史：趋势图靠它一天天攒出来。
                rememberUsage(data?.usage)
                settle('ok')
              })
              .catch((error) => {
                if (cancelled) return
                setSnapshot({
                  status: 'error',
                  data: undefined,
                  error: error instanceof Error ? error.message : String(error),
                })
                settle('error')
              })
          }

          run()
          if (visible) {
            timer = window.setInterval(run, REFRESH_MS)
            const onFocus = () => run()
            window.addEventListener('focus', onFocus)
            return () => {
              cancelled = true
              window.clearInterval(timer)
              if (flashTimer !== undefined) window.clearTimeout(flashTimer)
              window.removeEventListener('focus', onFocus)
            }
          }
          return () => {
            cancelled = true
            if (flashTimer !== undefined) window.clearTimeout(flashTimer)
          }
        }, [visible, request])

        const { data } = snapshot
        const ready = snapshot.status === 'ready' && data !== undefined && data.ok === true
        const reason = data !== undefined && data.ok !== true ? data.reason : undefined
        const state = ready ? 'ready' : reason === 'signed-out' ? 'idle' : 'warn'

        const wallets = ready && Array.isArray(data.wallets) ? data.wallets : []
        const bonus = ready && Array.isArray(data.bonusWallets) ? data.bonusWallets : []
        const bonusTotal = bonus.filter((wallet) => Number(wallet.balance) > 0)
        const links = data !== undefined && data.links !== undefined ? data.links : undefined

        /** @type {import('react').ReactNode[]} */
        const rows = []

        if (snapshot.status === 'loading') {
          rows.push(H('div', { key: 'loading', className: 'dsb-skeleton' }, t('loading')))
        } else if (ready && wallets.length > 0) {
          rows.push(
            H(
              'div',
              { key: 'amount', className: 'dsb-amount' },
              wallets.map((wallet) =>
                H('span', { key: wallet.currency }, formatAmount(wallet.balance, symbolOf(wallet.currency))),
              ),
            ),
          )
        } else if (ready) {
          // 读到了结果但钱包列表是空的：真实情况不该发生，画一个中性占位而不是 0 元。
          rows.push(H('div', { key: 'empty', className: 'dsb-amount' }, '—'))
        } else if (reason === 'signed-out') {
          rows.push(
            H('div', { key: 'out', className: 'dsb-note' }, [
              H('div', { key: 'title', className: 'dsb-note-title' }, t('signedOut')),
              H('div', { key: 'hint', className: 'dsb-hint' }, t('signedOut.hint')),
            ]),
          )
        } else if (reason === 'unavailable') {
          rows.push(H('div', { key: 'unavailable', className: 'dsb-error' }, t('unavailable')))
        } else {
          const message = data !== undefined && typeof data.message === 'string' ? data.message : ''
          rows.push(
            H('div', { key: 'failed', className: 'dsb-error' }, [
              H('div', { key: 'title' }, t('failed')),
              message === '' ? null : H('div', { key: 'message', className: 'dsb-hint' }, message),
            ]),
          )
        }

        if (bonusTotal.length > 0) {
          rows.push(
            H('div', { key: 'bonus', className: 'dsb-divider' }),
            H('div', { key: 'bonus-row', className: 'dsb-row dsb-bonus' }, [
              H('span', { key: 'label' }, t('bonus')),
              H(
                'span',
                { key: 'value', className: 'dsb-value' },
                bonusTotal
                  .map((wallet) => formatAmount(wallet.balance, symbolOf(wallet.currency)))
                  .join(' + '),
              ),
            ]),
          )
        }

        const updatedAt = ready && typeof data.fetchedAt === 'number' ? data.fetchedAt : undefined
        const links_ = []
        if (links !== undefined && typeof links.topUpUrl === 'string') {
          links_.push(
            H(
              'a',
              { key: 'topup', className: 'dsb-link', href: links.topUpUrl, target: '_blank', rel: 'noreferrer' },
              t('topUp'),
            ),
          )
        }
        if (links !== undefined && typeof links.usageUrl === 'string') {
          links_.push(
            H(
              'a',
              { key: 'usage', className: 'dsb-link', href: links.usageUrl, target: '_blank', rel: 'noreferrer' },
              t('usage'),
            ),
          )
        }
        if (links_.length > 0) rows.push(H('div', { key: 'links', className: 'dsb-actions' }, links_))

        const failed =
          snapshot.status === 'error' ||
          (snapshot.status === 'ready' && !ready && reason !== 'signed-out' && reason !== 'unavailable')

        const usageBlock = renderUsageBlock(data?.usage, t)

        // 有新版本时在顶部放一条窄条：版本号 + 「更新」按钮。
        // 更新动作交给 DSH 自己的 pluginManager.installBundle —— 和「添加插件」同一条安装管线。
        const updateBar =
          update !== undefined && update.available === true && update.canUpdate === true
            ? H('div', { key: 'update', className: 'dsb-update' }, [
                H('span', { key: 'text', className: 'dsb-update-text' }, t('update.available').replace('{v}', String(update.latest))),
                H(
                  'button',
                  {
                    key: 'action',
                    type: 'button',
                    className: 'dsb-update-button',
                    onClick: applyUpdate,
                    disabled: applying,
                    'aria-busy': applying ? 'true' : 'false',
                  },
                  applying ? t('update.applying') : t('update.action'),
                ),
              ])
            : null

        return H('div', { className: 'dsb-pane' }, [
          updateBar,
          // 刷新/重试固定在「账户余额」这一行的右端：面板右下角被别的插件
          // （例如视频皮肤的背景透明度控件）占着，控制项放那里会重叠。
          H('div', { key: 'head', className: 'dsb-head' }, [
            H('span', { key: 'heading', className: 'dsb-heading' }, [
              // 请求进行中时状态点改成品牌色呼吸，点击"有没有反应"一眼可见。
              H('span', { key: 'dot', className: 'dsb-dot', 'data-state': pending ? 'busy' : state }),
              H('span', { key: 'label' }, t('total')),
            ]),
            H('span', { key: 'actions', className: 'dsb-actions' }, [
              failed && !pending
                ? H(
                    'button',
                    { key: 'retry', type: 'button', className: 'dsb-button', onClick: reload },
                    t('retry'),
                  )
                : null,
              H(
                'button',
                {
                  key: 'refresh',
                  type: 'button',
                  className: 'dsb-button',
                  onClick: reload,
                  disabled: pending,
                  'aria-busy': pending ? 'true' : 'false',
                },
                pending ? t('refreshing') : t('refresh'),
              ),
            ]),
          ]),
          H('div', { key: 'card', className: 'dsb-card' }, rows),
          usageBlock,
          H('div', { key: 'foot', className: 'dsb-foot' }, [
            H(
              'span',
              { key: 'stamp' },
              updatedAt === undefined ? '' : `${t('updated')} ${clockOf(updatedAt)}`,
            ),
            // 点击后的结果回执：停留 FLASH_MS 后自动消失。
            flash === null || flash === undefined
              ? null
              : H(
                  'span',
                  {
                    key: 'flash',
                    className: 'dsb-flash',
                    'data-kind': flash === 'ok' || flash === 'updateOk' ? 'ok' : 'error',
                    role: 'status',
                    'aria-live': 'polite',
                  },
                  t(
                    flash === 'ok'
                      ? 'flash.ok'
                      : flash === 'updateOk'
                        ? 'flash.updateOk'
                        : flash === 'updateError'
                          ? 'flash.updateError'
                          : 'flash.error',
                  ),
                ),
          ]),
        ])
      }
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

    /**
     * 客户端插件主体：登记字典、tab 类型、正文与标题，然后尝试打开一次。
     * @param {import('@deepseek-ai/cordis').Context} ctx 客户端上下文。
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-balance: dictionaries')

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => t('title'),
            keepMounted: true,
            guide: [
              {
                id: 'wallet',
                order: 30,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
              },
            ],
          }),
        'deepseek-balance: tab type',
      )

      const Body = createBody(ctx)
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, Body),
          ),
        'deepseek-balance: tab body',
      )

      // chip 上的标题：闭包里持有本命名空间的 `t`，语言切换后跟着变。
      const Title = () => H('span', null, t('title'))
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS }, Title),
          ),
        'deepseek-balance: tab title',
      )

      if (AUTO_OPEN) {
        // 会话的停靠面要等 React 提交后才存在，所以这里是有界重试：
        // 成功一次就停，不再打扰用户已经排好的布局。
        ctx.effect(() => {
          let attempts = 0
          let timer
          const attempt = () => {
            timer = undefined
            try {
              ctx.sidebarRight.openTab(TAB_KIND)
              return
            } catch {
              /* 还没有可用的会话停靠面 */
            }
            attempts += 1
            if (attempts < AUTO_OPEN_ATTEMPTS) timer = window.setTimeout(attempt, AUTO_OPEN_RETRY_MS)
          }
          timer = window.setTimeout(attempt, AUTO_OPEN_DELAY_MS)
          return () => {
            if (timer !== undefined) window.clearTimeout(timer)
          }
        }, 'deepseek-balance: auto open')
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
