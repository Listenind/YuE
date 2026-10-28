/**
 * dsh-deepseek-balance-panel —— 宿主半边。
 *
 * 两件事：
 *   ① 从 `deepseekAccount` 读出当前登录账号的钱包余额（凭证仅限 Host，渲染层拿不到 token）；
 *   ② 从会话投影缓存聚合**今日**的 token 用量（命中 / 未命中 / 输出 / 请求次数）并折算金额。
 *
 * 设计取舍：
 *   - `inject` 是空数组，apply 里用 `ctx.inject(['webServer'], ...)` 迟到接入。webServer
 *     尚未就绪不会让插件卡在 waiting，也不会阻塞宿主启动。
 *   - `deepseekAccount` 在**每次请求时**用 `ctx.get()` 取，而不是声明成硬依赖：账号服务
 *     可能被关掉或换实现，那样余额退化成 `{ok:false}`，而不是让整个插件 FAILED。
 *   - 失败一律 200 + `{ok:false, reason}`：这是"当前读不到"，不是 HTTP 传输错误。
 *   - 用量聚合只读 `$DSH_HOME/storages/session_projcache/sessions/*.json`（DSH 自己维护的
 *     会话投影缓存），不解析压缩日志、不依赖任何内部服务，因此不会因为 DSH 升级而炸。
 *   - 金额是**估算**：投影只保存累计值，没有逐次请求的时间戳，所以按当前时段单价折算，
 *     并把"高峰/空闲"和"是否完整"一起交给界面说明，绝不假装精确。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** Cordis 诊断用的插件名。 */
export const name = 'deepseek-balance-panel'

/** 没有必需服务；`webServer` 用 `ctx.inject` 迟到接入。 */
export const inject = []

/** 与 package.json 的 version 保持一致。 */
export const VERSION = '1.8.7'

/** 所有路由共享的前缀。 */
export const ROUTE_PREFIX = '/dsh-deepseek-balance-panel'

/** 余额 + 今日用量。 */
export const BALANCE_ROUTE = `${ROUTE_PREFIX}/balance`

/** 自检：确认插件已装载、账号服务是否可见、用量目录是否可读。 */
export const STATE_ROUTE = `${ROUTE_PREFIX}/state`

/** 更新检查：当前版本、最新版本、能不能一键更新。 */
export const UPDATE_ROUTE = `${ROUTE_PREFIX}/update`

/** 执行更新：POST，宿主在 profile 里跑 `pnpm add`。 */
export const UPDATE_APPLY_ROUTE = `${ROUTE_PREFIX}/update/apply`

/** 包名（profile 依赖名 = npm 名 = bundle 名）。 */
export const PACKAGE_NAME = 'dsh-deepseek-balance-panel'

/** 更新检查的缓存窗口：别每 30 秒都去问一次 registry。 */
const UPDATE_CACHE_TTL_MS = 10 * 60 * 1000

/** 查版本时的外部超时。 */
const UPDATE_TIMEOUT_MS = 8_000

/** 余额缓存窗口。 */
const BALANCE_CACHE_TTL_MS = 15_000

/** 用量缓存窗口（聚合要走一遍投影缓存，别跟着 15 秒的余额一起抖）。 */
const USAGE_CACHE_TTL_MS = 30_000

/** 单次余额查询的外部超时。 */
const BALANCE_TIMEOUT_MS = 12_000

/** 单个投影缓存文件的读取上限，防止病态文件把面板拖死。 */
const MAX_PROJECTION_BYTES = 8 * 1024 * 1024

/** 一轮聚合最多处理的文件数。 */
const MAX_PROJECTION_FILES = 500

/**
 * 平台用量接口（platform.deepseek.com 用量页用的私有接口）。
 * 只认 DSH 自己的鉴权头 `x-dsh-auth-token`；`Authorization: Bearer` 会被 40003 拒。
 * 返回按 API Key × 模型 × 天分桶的 token / 成本，能覆盖所有客户端（含 CC Switch）。
 */
const PLATFORM_USAGE_AMOUNT = '/api/v0/usage/by_api_key/amount'
const PLATFORM_USAGE_COST = '/api/v0/usage/by_api_key/cost'

/** 平台用量查询的外部超时。 */
const PLATFORM_USAGE_TIMEOUT_MS = 12_000

/** 趋势窗口天数（与客户端一致）。 */
export const TREND_DAYS = 7

/**
 * DeepSeek 官方价目（人民币 / 百万 tokens）。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 每项是 `[空闲时段, 高峰时段]`；高峰 = 北京时间周一至周五 9:00-12:00 与 14:00-18:00
 * （不含法定节假日，这里不判断节假日，只按周内时段近似）。
 */
export const PRICE_TABLE = {
  'deepseek-flash': {
    hit: [0.02, 0.04],
    miss: [1, 2],
    out: [4, 8],
  },
  'deepseek-v4-pro': {
    hit: [0.15, 0.3],
    miss: [4.5, 9],
    out: [13.5, 27],
  },
}

/** 未知模型按 flash 计价。 */
const DEFAULT_PRICE_KEY = 'deepseek-flash'

/** DSH 主目录。 */
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

/** 会话投影缓存目录。 */
const PROJECTION_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

/** 跨天会话的每日基线，落在插件自己的目录里。 */
const LEDGER_FILE = path.join(DSH_HOME, 'dsh-deepseek-balance-panel', 'usage-baselines.json')

/**
 * 会话来源的分组维度：`agentPreset`。
 *
 * 面板不该知道"QQ 机器人"这种具体插件——同一个人可能同时用 GUI、机器人、自己的小号脚本，
 * 这些在 DSH 里都只是"某个 preset 下的一批会话"。所以本机按 preset 分组、平台按 API Key 分组，
 * 两边都是通用口径，谁在用就叫什么。
 */
const NO_SOURCE_LABEL = '(默认)'

/** 首次采样晚于零点多久就算"今天不完整"。 */
const EXACT_WINDOW_MS = 10 * 60 * 1000

/**
 * 取一个安全的错误描述。
 * @param {unknown} error 任意抛出的值。
 * @returns {string} 一行文本。
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把一个可能不是数字的值收敛成有限非负数。
 * @param {unknown} value 原值。
 * @returns {number} 可参与运算的数字。
 */
function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * 本地零点时间戳。
 * @param {number} now 当前毫秒时间戳。
 * @returns {number} 今天 00:00:00.000。
 */
function startOfDay(now) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime()
}

/**
 * 本地日期键 `YYYY-MM-DD`。
 * @param {number} ms 毫秒时间戳。
 * @returns {string} 日期键。
 */
function dayKey(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 当前是否处于 DeepSeek 的高峰时段（北京时间周内 9-12、14-18）。
 * @param {number} ms 毫秒时间戳。
 * @returns {boolean} 高峰为 true。
 */
export function isPeakHour(ms) {
  const beijing = new Date(ms + 8 * 3600_000)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = beijing.getUTCHours() + beijing.getUTCMinutes() / 60
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * 取模型对应的价目行。
 * @param {string | undefined} model 模型名。
 * @returns {{ hit: number[], miss: number[], out: number[] }} 价目。
 */
function priceOf(model) {
  return PRICE_TABLE[model] ?? PRICE_TABLE[DEFAULT_PRICE_KEY]
}

/**
 * 把一组 token 折算成金额。
 * @param {{ cacheRead: number, uncached: number, output: number }} tokens 三类 token。
 * @param {{ hit: number[], miss: number[], out: number[] }} price 价目。
 * @param {number} band 0 = 空闲，1 = 高峰。
 * @returns {number} 人民币金额。
 */
function costOf(tokens, price, band) {
  return (
    (tokens.cacheRead / 1_000_000) * price.hit[band] +
    (tokens.uncached / 1_000_000) * price.miss[band] +
    (tokens.output / 1_000_000) * price.out[band]
  )
}

/**
 * 建一个「来源 → 累计」的收集器。
 * @returns {{ add: (source: string, delta: Record<string, number>, cost: number) => void, list: () => { source: string, sessions: number, totalTokens: number, requests: number, cost: number }[] }} 收集器。
 */
function createSourceTally() {
  const map = new Map()
  return {
    add(source, delta, cost) {
      const entry = map.get(source) ?? { source, sessions: 0, hit: 0, miss: 0, output: 0, requests: 0, cost: 0 }
      entry.sessions += 1
      entry.hit += delta.cacheRead
      entry.miss += delta.uncached
      entry.output += delta.output
      entry.requests += delta.requests
      entry.cost += cost
      map.set(source, entry)
    },
    list() {
      return [...map.values()]
        .map((entry) => ({
          source: entry.source,
          sessions: entry.sessions,
          totalTokens: entry.hit + entry.miss + entry.output,
          requests: entry.requests,
          cost: Math.round(entry.cost * 10000) / 10000,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens)
    },
  }
}

/**
 * 读当天的基线账本。
 * @param {string} day 日期键。
 * @returns {{ day: string, sessions: Record<string, Record<string, number>> }} 账本。
 */
function readLedger(day) {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'))
    if (raw?.day === day && raw.sessions !== undefined && typeof raw.sessions === 'object') return raw
  } catch {
    /* 没有账本 / 账本损坏都从空开始 */
  }
  return { day, sessions: {} }
}

/**
 * 写回基线账本；写不进去不算错误，只是跨天会话会退化成"不计入"。
 * @param {{ day: string, sessions: Record<string, unknown> }} ledger 账本。
 * @returns {boolean} 是否写成功。
 */
function writeLedger(ledger) {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true })
    fs.writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * 从一个投影缓存记录里取出需要的那几个叶子值。
 * @param {Record<string, any>} record 投影缓存的 `record`。
 * @returns {{ tokens: { cacheRead: number, uncached: number, output: number, requests: number }, createdAt: number | undefined, model: string | undefined, preset: string | undefined } | undefined}}
 */
function readRecord(record) {
  const totals = record?.rows?.tokenUsage?.val?.totals
  if (totals === undefined || typeof totals !== 'object') return undefined
  const steps = record?.rows?.sessionStats?.val?.steps
  const model = record?.rows?.modelSelection?.val?.lastUsed?.model
  const preset = record?.rows?.agentPreset?.val
  return {
    tokens: {
      cacheRead: count(totals.cacheReadTokens),
      uncached: count(totals.uncachedInputTokens),
      output: count(totals.outputTokens),
      requests: count(steps),
    },
    preset: typeof preset === 'string' ? preset : undefined,
    createdAt: typeof record?.identity?.createdAt === 'number' ? record.identity.createdAt : undefined,
    model: typeof model === 'string' ? model : undefined,
  }
}

/**
 * 聚合今天所有会话的用量。
 *
 * 口径（写进 README，也写在面板的提示里）：
 *   - 今天创建的会话：全部累计值都算今天，精确；
 *   - 跨天会话：用账本里"今天第一次看到它"的累计值做基线，取差值；
 *     如果那次采样晚于零点 10 分钟，就把这一天的结果标成"不完整"。
 *
 * @param {number} now 当前毫秒时间戳。
 * @returns {Record<string, unknown>} 面板要的纯 JSON 用量块。
 */
export function aggregateUsage(now = Date.now()) {
  const start = startOfDay(now)
  const day = dayKey(now)
  const peak = isPeakHour(now)
  const band = peak ? 1 : 0

  const ledger = readLedger(day)
  let ledgerDirty = false
  let ledgerWritable = true

  const sum = { cacheRead: 0, uncached: 0, output: 0, requests: 0 }
  const state = { sessions: 0, skipped: 0, partial: false, cost: 0 }

  // 按「来源」（agentPreset）分一份账，给面板做通用细分。
  const sources = createSourceTally()

  let names = []
  try {
    names = fs.readdirSync(PROJECTION_DIR)
  } catch (error) {
    return {
      day,
      available: false,
      reason: 'no-projection-dir',
      message: describe(error),
      totalTokens: 0,
      cacheReadTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      requests: 0,
      sessions: 0,
      cost: 0,
      currency: 'CNY',
      peak,
      partial: true,
      sources: [],
    }
  }

  const seen = new Set()
  for (const entry of names) {
    if (!entry.endsWith('.json')) continue
    if (state.sessions + state.skipped >= MAX_PROJECTION_FILES) break

    const file = path.join(PROJECTION_DIR, entry)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    // 今天没被写过的会话，今天就没有活动，直接跳过——这是最省事的一层过滤。
    if (stat.mtimeMs < start) continue
    if (stat.size > MAX_PROJECTION_BYTES) {
      state.skipped += 1
      continue
    }

    let record
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'))?.record
    } catch {
      state.skipped += 1
      continue
    }

    const parsed = readRecord(record)
    if (parsed === undefined) continue

    const id = entry.replace(/\.json$/, '')
    seen.add(id)
    const price = priceOf(parsed.model)
    const createdToday = parsed.createdAt !== undefined && parsed.createdAt >= start

    /** @type {{ cacheRead: number, uncached: number, output: number, requests: number }} */
    let delta = parsed.tokens

    if (!createdToday) {
      const known = ledger.sessions[id]
      if (known === undefined) {
        // 今天第一次看到这个跨天会话：就地立基线。基线取得越早，今天的结果越完整。
        const exact = now - start <= EXACT_WINDOW_MS
        ledger.sessions[id] = { ...parsed.tokens, exact }
        ledgerDirty = ledgerWritable
        if (!exact) state.partial = true
        state.sessions += 1
        continue
      }
      if (known.exact !== true) state.partial = true
      delta = {
        cacheRead: Math.max(0, parsed.tokens.cacheRead - count(known.cacheRead)),
        uncached: Math.max(0, parsed.tokens.uncached - count(known.uncached)),
        output: Math.max(0, parsed.tokens.output - count(known.output)),
        requests: Math.max(0, parsed.tokens.requests - count(known.requests)),
      }
    }

    sum.cacheRead += delta.cacheRead
    sum.uncached += delta.uncached
    sum.output += delta.output
    sum.requests += delta.requests
    const cost = costOf(delta, price, band)
    state.cost += cost
    state.sessions += 1

    sources.add(parsed.preset ?? NO_SOURCE_LABEL, delta, cost)
  }

  // 清理账本里已经消失的会话（被删档），避免文件无限增长。
  for (const id of Object.keys(ledger.sessions)) {
    if (seen.has(id)) continue
    delete ledger.sessions[id]
    ledgerDirty = ledgerWritable
  }

  if (ledgerDirty) ledgerWritable = writeLedger(ledger)

  return {
    day,
    available: true,
    totalTokens: sum.cacheRead + sum.uncached + sum.output,
    cacheReadTokens: sum.cacheRead,
    uncachedInputTokens: sum.uncached,
    outputTokens: sum.output,
    requests: sum.requests,
    sessions: state.sessions,
    skipped: state.skipped,
    cost: Math.round(state.cost * 10000) / 10000,
    currency: 'CNY',
    peak,
    partial: state.partial,
    ledger: ledgerWritable ? 'ok' : 'read-only',
    sources: sources.list(),
  }
}

/** 余额缓存：`{ at, value }`。 */
let balanceCache

/** 正在进行的余额查询。 */
let balanceInflight

/** 用量缓存：`{ at, value }`。 */
let usageCache

/* ------------------------------------------------------------------ 平台用量 -- */
/*
 * 本地投影缓存只看得见「这台 DSH 自己跑的会话」，而且 DSH 主力走的是 OAuth，
 * 根本不出现在 API Key 的用量里。所以面板要算“全部 token”，必须再叠加平台侧：
 * `/api/v0/usage/by_api_key/*` 覆盖这个账号下所有 API Key（含 CC Switch 之类
 * 用同一账号的其它客户端），按 天 × Key × 模型 分桶。
 *
 * 两个口径互相独立：
 *   - 本机 DSH 会话（投影缓存，OAuth 流量）；
 *   - 平台 API Key（全部 Key）。
 * 唯一可能重复的是「DSH 自己也在用某个 API Key」的那部分，用凭据里的
 * DEEPSEEK_API_KEY 按掩码匹配出来单独减掉。
 */

/**
 * 平台数值可能是数字、字符串或 `{ value }`，统一收敛成非负数。
 * @param {unknown} value 原始值。
 * @returns {number} 数值。
 */
function platformNumber(value) {
  const raw = value !== null && typeof value === 'object' ? value.value : value
  const number = Number(raw)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * 以「东为正的秒偏移」把时间戳换算成当地日期键。
 * @param {number} ms 毫秒时间戳。
 * @param {number} tzSeconds 东为正的秒偏移。
 * @returns {string} `YYYY-MM-DD`。
 */
function localDayKey(ms, tzSeconds) {
  return new Date(ms + tzSeconds * 1000).toISOString().slice(0, 10)
}

/**
 * 近 N 天窗口（按当地零点对齐），返回秒级 start/end。
 * @param {number} now 当前毫秒时间戳。
 * @param {number} tzSeconds 东为正的秒偏移。
 * @param {number} days 天数。
 * @returns {{ start: number, end: number }} 秒级窗口。
 */
function usageWindow(now, tzSeconds, days = TREND_DAYS) {
  const offsetMs = tzSeconds * 1000
  const localMidnight = Math.floor((now + offsetMs) / 86_400_000) * 86_400_000 - offsetMs
  return {
    start: Math.floor((localMidnight - (days - 1) * 86_400_000) / 1000),
    end: Math.floor((localMidnight + 86_400_000) / 1000),
  }
}

/**
 * 读 DSH 自己配置的 API Key（只用来把它从「其它客户端」里剔除，绝不外传）。
 * @returns {string | undefined} 明文 Key。
 */
function readOwnApiKey() {
  try {
    const text = fs.readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8')
    const match = /^\s*DEEPSEEK_API_KEY:\s*(.+)$/m.exec(text)
    if (match === null) return undefined
    return match[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

/**
 * 平台的 `api_key` 字段里 Key 是打码的（`sk-2b18b…22f6`），按首尾比对就能认出自己那把。
 * @param {unknown} apiKey 平台返回的 api_key（对象或字符串）。
 * @param {string | undefined} ownKey 本地存的明文 Key。
 * @returns {boolean} 是否是 DSH 自己用的那把。
 */
function isOwnKey(apiKey, ownKey) {
  if (ownKey === undefined || ownKey.length < 12) return false
  const masked = typeof apiKey === 'string' ? apiKey : apiKey?.sensitive_id
  if (typeof masked !== 'string' || masked.length < 12) return false
  return masked.startsWith(ownKey.slice(0, 8)) && masked.endsWith(ownKey.slice(-4))
}

/**
 * 请求平台接口并返回 `biz_data`。
 * @param {string} url 完整地址。
 * @param {Record<string, string>} headers 请求头。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<any>} `data.biz_data`。
 */
async function platformJson(url, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers, redirect: 'error', signal: controller.signal })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`平台返回非 JSON（HTTP ${response.status}）`)
    }
    const code = Number(payload?.code ?? 0)
    if (code === 40002 || code === 40003) {
      const error = new Error('平台登录态无效')
      error.code = 'signed-out'
      throw error
    }
    if (code !== 0) throw new Error(`平台接口 code=${code}`)
    const bizCode = Number(payload?.data?.biz_code ?? 0)
    if (bizCode !== 0) throw new Error(`平台接口 biz_code=${bizCode}`)
    return payload?.data?.biz_data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把平台的两份响应折成「按天 + 按 Key」的用量。
 * @param {any} amount amount 接口的 `biz_data`（`{ series }`）。
 * @param {any} cost cost 接口的 `biz_data`（`{ data: [{ currency, series }] }`）。
 * @param {{ now: number, tzSeconds: number, ownKey: string | undefined }} options 口径参数。
 * @returns {Record<string, unknown>} 平台用量块。
 */
function summarizePlatform(amount, cost, options) {
  const { tzSeconds, ownKey } = options
  const days = new Map()
  const keys = new Map()

  /** 取（或建）某一天的累计。 */
  const dayOf = (date) => {
    let entry = days.get(date)
    if (entry === undefined) {
      entry = {
        date,
        tokens: 0,
        cost: 0,
        requests: 0,
        hit: 0,
        miss: 0,
        output: 0,
        ownTokens: 0,
        ownRequests: 0,
        ownCost: 0,
        ownHit: 0,
        ownMiss: 0,
        ownOutput: 0,
      }
      days.set(date, entry)
    }
    return entry
  }

  /** 取（或建）某个 Key 的累计。 */
  const keyOf = (series) => {
    const apiKey = series?.api_key
    const name = typeof apiKey === 'string' ? apiKey : apiKey?.name ?? 'unknown'
    const id = apiKey !== null && typeof apiKey === 'object' ? apiKey.tracking_id ?? apiKey.sensitive_id ?? name : name
    const own = isOwnKey(apiKey, ownKey)
    let entry = keys.get(id)
    if (entry === undefined) {
      entry = { name, own, tokens: 0, cost: 0, requests: 0, todayTokens: 0, todayRequests: 0, todayCost: 0 }
      keys.set(id, entry)
    }
    return { entry, own }
  }

  const todayDate = localDayKey(options.now, tzSeconds)

  for (const series of amount?.series ?? []) {
    const { entry: key, own } = keyOf(series)
    for (const bucket of series?.buckets ?? []) {
      const time = Number(bucket?.time)
      if (!Number.isFinite(time)) continue
      const date = localDayKey(time * 1000, tzSeconds)
      const day = dayOf(date)
      const isToday = date === todayDate
      for (const [type, value] of Object.entries(bucket?.usage ?? {})) {
        const count = platformNumber(value)
        if (count === 0) continue
        if (type === 'REQUEST') {
          day.requests += count
          key.requests += count
          if (isToday) key.todayRequests += count
          if (own) day.ownRequests += count
          continue
        }
        if (type !== 'PROMPT_CACHE_HIT_TOKEN' && type !== 'PROMPT_CACHE_MISS_TOKEN' && type !== 'RESPONSE_TOKEN') continue
        day.tokens += count
        key.tokens += count
        if (isToday) key.todayTokens += count
        if (type === 'PROMPT_CACHE_HIT_TOKEN') {
          day.hit += count
          if (own) day.ownHit += count
        } else if (type === 'PROMPT_CACHE_MISS_TOKEN') {
          day.miss += count
          if (own) day.ownMiss += count
        } else {
          day.output += count
          if (own) day.ownOutput += count
        }
        if (own) day.ownTokens += count
      }
    }
  }

  const blocks = Array.isArray(cost?.data) ? cost.data : []
  const block = blocks.find((item) => item?.currency === 'CNY') ?? blocks.find((item) => item?.currency === 'USD') ?? blocks[0]
  for (const series of block?.series ?? []) {
    const { entry: key, own } = keyOf(series)
    for (const bucket of series?.buckets ?? []) {
      const time = Number(bucket?.time)
      if (!Number.isFinite(time)) continue
      const date = localDayKey(time * 1000, tzSeconds)
      const day = dayOf(date)
      const spend = platformNumber(bucket?.cost)
      day.cost += spend
      key.cost += spend
      // 每把 Key 今天的金额：来源图要按「今天」展示，不能混进 7 天窗口。
      if (date === todayDate) key.todayCost += spend
      if (own) day.ownCost += spend
    }
  }

  const totals = { tokens: 0, hit: 0, miss: 0, output: 0, requests: 0, cost: 0 }
  const own = { tokens: 0, hit: 0, miss: 0, output: 0, requests: 0, cost: 0 }
  for (const day of days.values()) {
    totals.tokens += day.tokens
    totals.hit += day.hit
    totals.miss += day.miss
    totals.output += day.output
    totals.requests += day.requests
    totals.cost += day.cost
    own.tokens += day.ownTokens
    own.hit += day.ownHit
    own.miss += day.ownMiss
    own.output += day.ownOutput
    own.requests += day.ownRequests
    own.cost += day.ownCost
  }

  // 面板的“今日”要的是今天那一格，不是 7 天合计。
  const todayKey = localDayKey(options.now, tzSeconds)
  const todayDay = days.get(todayKey)
  const today = todayDay === undefined
    ? { tokens: 0, hit: 0, miss: 0, output: 0, requests: 0, cost: 0 }
    : {
        tokens: todayDay.tokens,
        hit: todayDay.hit,
        miss: todayDay.miss,
        output: todayDay.output,
        requests: todayDay.requests,
        cost: Math.round(todayDay.cost * 10000) / 10000,
      }

  const ownKeyToday = [...keys.values()].find((key) => key.own)

  return {
    available: true,
    currency: typeof block?.currency === 'string' ? block.currency : 'CNY',
    fetchedAt: Date.now(),
    day: todayKey,
    today,
    ownTodayTokens: ownKeyToday?.todayTokens ?? 0,
    window: { ...totals, cost: Math.round(totals.cost * 10000) / 10000 },
    // `own` 只作展示用（告诉用户 DSH 手里握的是哪把 Key），不参与加减：
    // 实测 DSH 的推理走 OAuth，这把 Key 的流量来自别的客户端。
    own: { ...own, name: [...keys.values()].find((key) => key.own)?.name },
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    keys: [...keys.values()].sort((a, b) => b.tokens - a.tokens),
  }
}

/**
 * 读平台侧（全部 API Key）的用量；任何失败都只是「不可用」，不影响本机统计。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ tzMinutes?: number, now?: number }} options 口径参数。
 * @returns {Promise<Record<string, unknown>>} 平台用量块或失败原因。
 */
export async function readPlatformUsage(ctx, options = {}) {
  const now = options.now ?? Date.now()
  const tzMinutes = options.tzMinutes ?? -new Date().getTimezoneOffset()
  const account = ctx.get('deepseekAccount')
  if (account === undefined) return { available: false, reason: 'unavailable' }

  let session
  try {
    session = await account.getPlatformSession()
  } catch (error) {
    return { available: false, reason: 'failed', message: describe(error) }
  }
  if (session === null || session === undefined || typeof session.token !== 'string') {
    return { available: false, reason: 'signed-out' }
  }

  const origin = typeof session.origin === 'string' ? session.origin.replace(/\/+$/, '') : 'https://platform.deepseek.com'
  const tzSeconds = -tzMinutes * 60
  const window = usageWindow(now, tzSeconds, TREND_DAYS)
  const query = `start=${window.start}&end=${window.end}&tz=${tzSeconds}`
  const headers = { 'x-dsh-auth-token': session.token, accept: 'application/json' }

  const [amountResult, costResult] = await Promise.allSettled([
    platformJson(`${origin}${PLATFORM_USAGE_AMOUNT}?${query}`, headers, PLATFORM_USAGE_TIMEOUT_MS),
    platformJson(`${origin}${PLATFORM_USAGE_COST}?${query}`, headers, PLATFORM_USAGE_TIMEOUT_MS),
  ])

  if (amountResult.status === 'rejected') {
    const error = amountResult.reason
    return {
      available: false,
      reason: error?.code === 'signed-out' ? 'signed-out' : 'failed',
      message: describe(error),
    }
  }

  const summary = summarizePlatform(
    amountResult.value,
    costResult.status === 'fulfilled' ? costResult.value : undefined,
    { now, tzSeconds, ownKey: readOwnApiKey() },
  )
  if (costResult.status === 'rejected') summary.costNote = describe(costResult.reason)
  return summary
}

/**
 * 页面语言归约为 Platform 认识的 `zh_CN` / `en_US`。
 * @param {string | null} raw 页面传来的语言。
 * @returns {string} 平台语言。
 */
function wireLocale(raw) {
  return String(raw ?? '').toLowerCase().split(/[-_]/)[0] === 'en' ? 'en_US' : 'zh_CN'
}

/**
 * 解析页面传来的时区偏移（分钟，与 `Date.getTimezoneOffset()` 同号）。
 * @param {string | null} raw 页面传来的值。
 * @returns {number} 东为正的整秒偏移。
 */
function wireTimezone(raw) {
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || Math.abs(minutes) > 24 * 60) return -new Date().getTimezoneOffset() * 60
  return -Math.round(minutes) * 60
}

/**
 * 只保留钱包的可显示叶子字段，不把服务对象带出去。
 * @param {{ currency?: unknown, balance?: unknown }} wallet 服务返回的钱包。
 * @returns {{ currency: string, balance: string }} 纯 JSON 钱包。
 */
function pickWallet(wallet) {
  return {
    currency: String(wallet?.currency ?? 'CNY'),
    balance: String(wallet?.balance ?? '0'),
  }
}

/**
 * 读一次余额，带超时。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ locale: string, tz: string | null }} query 请求参数。
 * @returns {Promise<Record<string, unknown>>} 纯 JSON 响应体。
 */
async function readBalance(ctx, query) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined) {
    return { ok: false, reason: 'unavailable', message: 'deepseekAccount 服务未挂载' }
  }

  const client = {
    version: VERSION,
    locale: wireLocale(query.locale),
    timezoneOffsetSeconds: wireTimezone(query.tz),
  }

  /** @type {Record<string, unknown> | undefined} */
  let links
  try {
    const state = await account.getState()
    links = state?.links
    if (state?.status !== 'credential-stored') {
      return { ok: false, reason: 'signed-out', ...(links === undefined ? {} : { links }) }
    }
  } catch (error) {
    return { ok: false, reason: 'failed', message: describe(error) }
  }

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', message: '余额查询超时' }), BALANCE_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([account.getBalance(client), timeout])
    if (result === undefined || result === null) {
      return { ok: false, reason: 'signed-out', ...(links === undefined ? {} : { links }) }
    }
    if (result.ok === false) return result
    if (result.status !== 'ready') {
      return { ok: false, reason: 'failed', message: 'Platform 未返回余额', ...(links === undefined ? {} : { links }) }
    }
    return {
      ok: true,
      wallets: (Array.isArray(result.value) ? result.value : []).map(pickWallet),
      bonusWallets: (Array.isArray(result.bonusWallets) ? result.bonusWallets : []).map(pickWallet),
      fetchedAt: Date.now(),
      ...(links === undefined ? {} : { links }),
    }
  } catch (error) {
    return { ok: false, reason: 'failed', message: describe(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带缓存与并发合并的余额读取。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ locale: string, tz: string | null, force: boolean }} query 请求参数。
 * @returns {Promise<Record<string, unknown>>} 纯 JSON 响应体。
 */
async function cachedBalance(ctx, query) {
  const now = Date.now()
  if (query.force !== true && balanceCache !== undefined && now - balanceCache.at < BALANCE_CACHE_TTL_MS) {
    return { ...balanceCache.value, cached: true }
  }
  if (balanceInflight !== undefined) return balanceInflight

  balanceInflight = readBalance(ctx, query)
    .then((value) => {
      // 只缓存成功结果：失败多半是瞬时问题，下次点击应该真的再试一次。
      if (value.ok === true) balanceCache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      balanceInflight = undefined
    })
  return balanceInflight
}

/**
 * 本机 DSH 会话的用量；失败也要给一个能看的结构。
 * @param {number} now 当前毫秒时间戳。
 * @returns {Record<string, unknown>} 本地用量块。
 */
function localUsage(now) {
  try {
    return aggregateUsage(now)
  } catch (error) {
    return {
      day: dayKey(now),
      available: false,
      reason: 'aggregate-failed',
      message: describe(error),
      totalTokens: 0,
      cacheReadTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      requests: 0,
      cost: 0,
      currency: 'CNY',
      partial: true,
    }
  }
}

/**
 * 合并「本机 DSH 会话」与「平台所有 API Key」两边的用量。
 *
 * 总计 = 本机 + 平台：DSH 的推理走账号（OAuth），平台按 Key 统计里看不到它；
 * 反过来平台那部分包含 CC Switch 等其它客户端。两边都算进去才是“全部 token”。
 * 唯一的重复风险是「DSH 自身也被配置成用某个 API Key」，所以界面上把两部分分开列。
 *
 * @param {Record<string, any>} local 本机用量块。
 * @param {Record<string, any>} platform 平台用量块。
 * @param {number} now 当前毫秒时间戳。
 * @returns {Record<string, unknown>} 面板用的合并用量块。
 */
function mergeUsage(local, platform, now) {
  const localHit = Number(local.cacheReadTokens) || 0
  const localMiss = Number(local.uncachedInputTokens) || 0
  const localOut = Number(local.outputTokens) || 0
  const localRequests = Number(local.requests) || 0
  const localCost = Number(local.cost) || 0
  const merged = platform.available === true

  // 本机那半边按「来源」（agentPreset）拆细；它整份都已经在 local 里，所以这里只做展示。
  const sources = Array.isArray(local.sources) ? local.sources : []

  /**
   * 本机与平台是不是同一批请求？
   *
   * DSH 自己如果用 API Key 推理（provider deepseek-official → llm-deepseek），那它的 token
   * 既进本机投影缓存、也进平台的按 Key 统计——相加就会翻倍（实测 81M + 62M 对不上官网的 70M）。
   * 判断依据：本机量落在“平台里那把属于 DSH 的 Key”的 0.4x–1.6x 区间内，就认为两者重叠，
   * 总计改用平台数（和官网同源）。DSH 走账号（OAuth）时本机会明显更大，仍然相加。
   */
  const ownTodayTokens = Number(platform.ownTodayTokens) || 0
  const localTokens = localHit + localMiss + localOut
  const overlap =
    merged && ownTodayTokens > 0 && localTokens > 0 && localTokens >= ownTodayTokens * 0.4 && localTokens <= ownTodayTokens * 1.6

  const remote = merged
    ? {
        tokens: platform.today?.tokens ?? 0,
        hit: platform.today?.hit ?? 0,
        miss: platform.today?.miss ?? 0,
        output: platform.today?.output ?? 0,
        requests: platform.today?.requests ?? 0,
        cost: platform.today?.cost ?? 0,
      }
    : { tokens: 0, hit: 0, miss: 0, output: 0, requests: 0, cost: 0 }

  return {
    day: local.day ?? dayKey(now),
    available: true,
    source: merged ? 'merged' : 'local',
    // 重叠时以平台为准（它和官网同源）；否则两边相加。
    overlap,
    totalTokens: overlap ? remote.tokens : localTokens + remote.tokens,
    cacheReadTokens: overlap ? remote.hit : localHit + remote.hit,
    uncachedInputTokens: overlap ? remote.miss : localMiss + remote.miss,
    outputTokens: overlap ? remote.output : localOut + remote.output,
    requests: overlap ? remote.requests : localRequests + remote.requests,
    cost: overlap ? remote.cost : localCost + remote.cost,
    currency: typeof local.currency === 'string' ? local.currency : 'CNY',
    peak: local.peak === true,
    partial: local.partial === true,
    local: {
      totalTokens: localHit + localMiss + localOut,
      cacheReadTokens: localHit,
      uncachedInputTokens: localMiss,
      outputTokens: localOut,
      requests: localRequests,
      cost: Math.round(localCost * 10000) / 10000,
      available: local.available === true,
      // 按 agentPreset 的来源细分（机器人 / GUI / 小号脚本……都只是不同的 preset）。
      sources,
    },
    platform: merged
      ? {
          available: true,
          currency: platform.currency,
          day: platform.day,
          today: platform.today,
          window: platform.window,
          own: platform.own,
          days: platform.days,
          keys: platform.keys,
          ...(platform.costNote === undefined ? {} : { costNote: platform.costNote }),
        }
      : {
          available: false,
          reason: platform.reason ?? 'failed',
          ...(platform.message === undefined ? {} : { message: platform.message }),
        },
  }
}

/**
 * 一次性汇总（不走缓存）：本机 DSH 会话 + 平台所有 API Key。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ tz?: string | null }} query 请求参数（只用到时区）。
 * @param {number} now 当前毫秒时间戳。
 * @returns {Promise<Record<string, unknown>>} 合并后的用量块。
 */
export async function collectUsage(ctx, query = {}, now = Date.now()) {
  const minutes = Number(query.tz)
  const tzMinutes = Number.isFinite(minutes) && Math.abs(minutes) <= 24 * 60 ? minutes : -new Date().getTimezoneOffset()
  const [local, platform] = await Promise.all([
    Promise.resolve(localUsage(now)),
    readPlatformUsage(ctx, { now, tzMinutes }).catch((error) => ({
      available: false,
      reason: 'failed',
      message: describe(error),
    })),
  ])
  return mergeUsage(local, platform, now)
}

/**
 * 带缓存的两路用量汇总。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {{ force: boolean, tz: string | null }} query 请求参数。
 * @returns {Promise<Record<string, unknown>>} 纯 JSON 用量块。
 */
async function cachedUsage(ctx, query) {
  const now = Date.now()
  if (query.force !== true && usageCache !== undefined && now - usageCache.at < USAGE_CACHE_TTL_MS) {
    return { ...usageCache.value, cached: true }
  }

  const value = await collectUsage(ctx, query, now)
  usageCache = { at: Date.now(), value }
  return value
}

/* -------------------------------------------------------------------- 更新 -- */
/*
 * 目标：作者发一个新版本 → 装了本插件的用户能在面板里看到「有新版本」，点一下就更新。
 *
 * 分成两半：
 *   ① 宿主负责「查」：读 profile 里本包的依赖声明，判断用户是怎么装的（npm / git / 本地链接），
 *      再去对应的地方问最新版本 —— npm registry 或 GitHub 上的 package.json。
 *   ② 客户端负责「装」：调 DSH 自己的 `pluginManager.installBundle()`，也就是「添加插件」
 *      那条安装管线（pnpm、锁、构建脚本审批都由它处理），不自己 spawn 命令。
 *
 * 本地链接安装（file:plugins/…）不提供更新：那是开发者自己的工作区副本，更新它没有意义。
 */

/** profile 目录。 */
function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR)
  return path.join(DSH_HOME, 'profiles', 'desktop')
}

/**
 * 读 profile 里本包的依赖声明，判断安装方式。
 * @param {(file: string) => string} [read] 读文件（测试可注入）。
 * @returns {{ spec: string | undefined, mode: 'npm' | 'git' | 'link' | 'unknown' }} 安装方式。
 */
export function installedSpec(read = (file) => fs.readFileSync(file, 'utf8')) {
  let manifest
  try {
    manifest = JSON.parse(read(path.join(profileDir(), 'package.json')))
  } catch {
    return { spec: undefined, mode: 'unknown' }
  }
  const spec = manifest?.dependencies?.[PACKAGE_NAME] ?? manifest?.devDependencies?.[PACKAGE_NAME]
  if (typeof spec !== 'string' || spec === '') return { spec: undefined, mode: 'unknown' }

  // 本地目录（develop 时就地改）：file: / link: / 绝对路径 / 相对路径。
  if (/^(file|link):/.test(spec) || /^[./\\]/.test(spec) || /^[a-zA-Z]:[\\/]/.test(spec)) {
    return { spec, mode: 'link' }
  }
  // git / GitHub 直装。
  if (/^(github:|git\+|git:|https?:\/\/.+\.git|git@)/.test(spec)) return { spec, mode: 'git' }
  return { spec, mode: 'npm' }
}

/**
 * 比较两个 semver（只认 x.y.z，预发布后缀按字符串比）。
 * @param {string} left 版本。
 * @param {string} right 版本。
 * @returns {number} left 比 right 新则为正，相等为 0。
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?$/.exec(String(value).trim())
    if (match === null) return undefined
    return {
      parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
      pre: match[4] ?? '',
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === undefined || b === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] - b.parts[index]
  }
  // 同一版号时：正式版 > 预发布版。
  if (a.pre === b.pre) return 0
  if (a.pre === '') return 1
  if (b.pre === '') return -1
  return a.pre > b.pre ? 1 : -1
}

/**
 * 从 git spec 里挑出 GitHub 的 owner/repo 和 ref。
 * @param {string} spec 依赖声明。
 * @returns {{ repo: string, ref: string } | undefined} 仓库与分支。
 */
function githubTarget(spec) {
  const cleaned = spec.replace(/^(github:|git\+)/, '')
  const match = /^(?:github\.com[/:])?([^/#]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/.exec(cleaned)
  if (match === null) return undefined
  return { repo: `${match[1]}/${match[2]}`, ref: match[3] ?? 'HEAD' }
}

/**
 * 带超时的 JSON GET。
 * @param {typeof fetch} fetchImpl fetch 实现。
 * @param {string} url 地址。
 * @returns {Promise<any>} 解析后的 JSON。
 */
async function fetchJson(fetchImpl, url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': `${PACKAGE_NAME}/${VERSION}` },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 更新检查缓存。 */
let updateCache

/**
 * 检查有没有新版本。
 * @param {{ fetchImpl?: typeof fetch, read?: (file: string) => string, now?: number, force?: boolean }} [options] 选项。
 * @returns {Promise<Record<string, unknown>>} 检查结果。
 */
export async function checkUpdate(options = {}) {
  const now = options.now ?? Date.now()
  const { spec, mode } = installedSpec(options.read)
  const cacheKey = `${spec}:${mode}`
  if (options.force !== true && updateCache !== undefined && updateCache.key === cacheKey && now - updateCache.at < UPDATE_CACHE_TTL_MS) {
    return updateCache.value
  }

  /** @type {Record<string, unknown>} */
  const value = {
    ok: true,
    package: PACKAGE_NAME,
    current: VERSION,
    latest: VERSION,
    available: false,
    mode,
    spec,
    canUpdate: false,
    updateSpec: undefined,
    note: undefined,
    // 这次检查的时间：客户端拿去做提示，方便判断「是不是很久没查了」。
    checkedAt: now,
  }

  if (mode === 'link') {
    value.note = 'local-link'
  } else if (mode === 'unknown') {
    value.note = 'not-installed'
  } else {
    const fetchImpl = options.fetchImpl ?? fetch
    try {
      if (mode === 'git') {
        const target = githubTarget(spec ?? '')
        if (target === undefined) throw new Error('unsupported git spec')
        const manifest = await fetchJson(
          fetchImpl,
          `https://raw.githubusercontent.com/${target.repo}/${target.ref === 'HEAD' ? 'HEAD' : encodeURIComponent(target.ref)}/package.json`,
        )
        value.latest = typeof manifest?.version === 'string' ? manifest.version : VERSION
        value.updateSpec = spec
      } else {
        const manifest = await fetchJson(fetchImpl, `https://registry.npmjs.org/${PACKAGE_NAME}/latest`)
        value.latest = typeof manifest?.version === 'string' ? manifest.version : VERSION
        value.updateSpec = `${PACKAGE_NAME}@${value.latest}`
      }
      value.available = compareVersions(String(value.latest), VERSION) > 0
      value.canUpdate = true
    } catch (error) {
      value.ok = false
      value.note = 'check-failed'
      value.message = describe(error)
    }
  }

  updateCache = { key: cacheKey, at: now, value }
  return value
}

/** 同一时刻只允许一次升级在跑。 */
let updateApplying = false

/**
 * 读磁盘上实际装着的那一版。
 * @param {(file: string) => string} [read] 读文件（测试可注入）。
 * @returns {string | undefined} 版本号。
 */
export function installedVersionOnDisk(read = (file) => fs.readFileSync(file, 'utf8')) {
  try {
    const manifest = JSON.parse(read(path.join(profileDir(), 'node_modules', PACKAGE_NAME, 'package.json')))
    return typeof manifest?.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 找一份能用的 pnpm。
 *
 * 优先用 DSH 自带的那个（`resources/runtime/primary-runtime/dependencies/pnpm`）：
 * 它和 profile 里已有的 store 大版本一致（v11），用系统里的 pnpm 10 会因为 store 不匹配直接失败。
 * @returns {{ command: string, args: string[], env: Record<string, string> }} 命令。
 */
function pnpmCommand() {
  // 测试/排障用：显式指定 pnpm 的入口脚本。
  const explicit = process.env.DSH_PNPM
  if (typeof explicit === 'string' && explicit !== '' && fs.existsSync(explicit)) {
    return { command: process.execPath, args: [explicit], env: {} }
  }
  /** 候选目录：Electron 的 resourcesPath，或者 exe 旁边的 resources。 */
  const roots = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath !== '') roots.push(process.resourcesPath)
  roots.push(path.join(path.dirname(process.execPath), 'resources'))
  for (const root of roots) {
    const bundled = path.join(root, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    if (fs.existsSync(bundled)) {
      // pnpm.mjs 就是个 ESM 脚本：用当前 node（打包后是 Electron，需要 ELECTRON_RUN_AS_NODE）跑它。
      return { command: process.execPath, args: [bundled], env: { ELECTRON_RUN_AS_NODE: '1' } }
    }
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [], env: {} }
}

/**
 * 执行升级：在 profile 里 `pnpm add <包>@<版本>`。
 *
 * 为什么不用 DSH 的 `pluginManager.installBundle()`：它对「已安装的同名包」直接
 * 返回 `refused("already-installed")`（而且包在 `ok:true` 里），升级路径根本不走；
 * 卸载又要求停掉 profile。所以照 `dsh plugin add` 的做法自己跑 pnpm。
 *
 * @param {{ version?: string, registry?: string, timeoutMs?: number }} [options] 选项。
 * @returns {Promise<Record<string, unknown>>} 结果。
 */
export async function applyUpdate(options = {}) {
  if (updateApplying) return { ok: false, reason: 'busy', message: 'another update is running' }
  const { mode, spec } = installedSpec()
  if (mode !== 'npm') {
    return { ok: false, reason: 'not-npm', mode, spec, message: 'only npm installs can be updated from here' }
  }

  const target = options.version === undefined ? 'latest' : options.version
  const registry = options.registry ?? 'https://registry.npmjs.org'
  const before = installedVersionOnDisk()

  updateApplying = true
  try {
    const { command, args, env } = pnpmCommand()
    const child = spawn(
      command,
      [...args, 'add', `${PACKAGE_NAME}@${target}`, `--registry=${registry}`],
      {
        cwd: profileDir(),
        env: { ...process.env, ...env, CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // .cmd 在 Windows 上不能直接 spawn（EINVAL），只有退回系统 pnpm 时才需要 shell。
        shell: command.endsWith('.cmd'),
      },
    )

    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      output += String(chunk)
    })

    const timeoutMs = options.timeoutMs ?? 180_000
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve('timeout')
      }, timeoutMs)
      child.on('error', (error) => {
        clearTimeout(timer)
        output += `\n${describe(error)}`
        resolve(1)
      })
      child.on('exit', (exitCode) => {
        clearTimeout(timer)
        resolve(exitCode ?? 1)
      })
    })

    const after = installedVersionOnDisk()
    const tail = output.trim().split('\n').slice(-6).join('\n')
    const changed = before !== after
    // pnpm 说成功、版本却没变，同样算失败：不能让界面报「已更新」而磁盘没动。
    const ok = code === 0 && changed && after === target
    updateCache = undefined
    return {
      ok,
      before,
      installed: after,
      target,
      changed,
      ...(ok ? {} : { reason: code === 'timeout' ? 'timeout' : 'failed', message: tail }),
    }
  } catch (error) {
    return { ok: false, reason: 'failed', message: describe(error) }
  } finally {
    updateApplying = false
  }
}

/**
 * 发一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {unknown} body 响应体。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

/**
 * 解析查询串。
 * @param {import('node:http').IncomingMessage} req 入站请求。
 * @returns {{ locale: string, tz: string | null, force: boolean }} 归一化参数。
 */
function readQuery(req) {
  let params
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    params = new URLSearchParams()
  }
  return {
    locale: params.get('locale') ?? '',
    tz: params.get('tz'),
    force: params.get('force') === '1',
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 */
export function apply(ctx) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[${name}] ${message}`)
    } catch {
      /* 日志不该成为失败原因 */
    }
  }

  ctx.on('dispose', () => {
    balanceCache = undefined
    balanceInflight = undefined
    usageCache = undefined
  })

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposers = []

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: BALANCE_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, reason: 'method', message: 'use GET' })
              return
            }
            const query = readQuery(req)
            // 用量与余额并行：平台用量要走一次网络，不该让余额等它。
            const usageTask = cachedUsage(ctx, query)
            cachedBalance(ctx, query)
              .then(async (balance) => {
                // 用量与余额互不依赖：即使没登录，今日用量也照样能看。
                sendJson(res, 200, { ...balance, version: VERSION, usage: await usageTask })
              })
              .catch(async (error) => {
                warn(`余额查询失败：${describe(error)}`)
                sendJson(res, 200, {
                  ok: false,
                  reason: 'failed',
                  message: describe(error),
                  version: VERSION,
                  usage: await usageTask,
                })
              })
          },
        }),
      )

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: STATE_ROUTE,
          handler: (_req, res) => {
            const account = ctx.get('deepseekAccount')
            let projectionFiles = 0
            try {
              projectionFiles = fs.readdirSync(PROJECTION_DIR).length
            } catch {
              projectionFiles = -1
            }
            const reply = {
              ok: true,
              plugin: name,
              version: VERSION,
              accountService: account === undefined ? 'absent' : 'mounted',
              projectionDir: PROJECTION_DIR,
              projectionFiles,
              ledger: LEDGER_FILE,
              platformSession: 'unknown',
              ownApiKey: readOwnApiKey() === undefined ? 'absent' : 'configured',
            }
            // 只读本地凭据，不发网络请求：确认平台用量这条路有没有登录态可用。
            const session = account?.getPlatformSession?.()
            Promise.resolve(session)
              .then((value) => {
                reply.platformSession = value === null || value === undefined || typeof value.token !== 'string' ? 'absent' : 'present'
              })
              .catch(() => {
                reply.platformSession = 'error'
              })
              .finally(() => sendJson(res, 200, reply))
          },
        }),
      )

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: UPDATE_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'GET').toUpperCase()
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, reason: 'method', message: 'use GET' })
              return
            }
            const query = readQuery(req)
            checkUpdate({ force: query.force === true })
              .then((value) => sendJson(res, 200, value))
              .catch((error) => sendJson(res, 200, { ok: false, note: 'check-failed', message: describe(error) }))
          },
        }),
      )

      disposers.push(
        child.webServer.register({
          kind: 'exact',
          path: UPDATE_APPLY_ROUTE,
          handler: (req, res) => {
            const method = String(req.method ?? 'POST').toUpperCase()
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, reason: 'method', message: 'use POST' })
              return
            }
            const query = readQuery(req)
            checkUpdate({ force: true })
              .then((value) => {
                if (value.ok !== true || value.canUpdate !== true) {
                  sendJson(res, 409, { ok: false, reason: 'not-updatable', ...value })
                  return undefined
                }
                return applyUpdate({ version: String(value.latest) }).then((result) => {
                  sendJson(res, result.ok === true ? 200 : 500, result)
                })
              })
              .catch((error) => sendJson(res, 500, { ok: false, reason: 'failed', message: describe(error) }))
            void query
          },
        }),
      )

      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已经注销 */
          }
        }
      }
    })
  })
}
