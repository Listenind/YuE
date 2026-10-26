# dsh-deepseek-balance-panel

在 DSH 右侧栏常驻一个「余额明细」标签页：上半是当前登录 DeepSeek 账号的**充值钱包 / 赠送钱包余额**，下半是**今日用量**——总消耗、缓存命中、缓存未命中、消费金额与 API 请求次数。

- 面板可见时每 30 秒自动刷新；窗口重新获得焦点时也会刷新。
- 点「刷新」有明确回执：按钮变「刷新中…」并禁用、状态点呼吸；请求结束在页脚留一句「已更新 / 更新失败」，1.8 秒后消失。手动点击带 `force=1` 绕过缓存，时间戳一定走动。
- 面板被折叠 / 切到别的标签 / 切到后台会话时不轮询。
- 未登录、账号服务缺失、查询失败各有独立空状态，绝不把失败显示成 0 元；**余额读不到时今日用量照常显示**。
- 「今日消耗」卡片把三段 token 都摆出来：**命中 / 未命中 / 输出**；上面那根占比条只讲输入侧的命中率。
- 「按空闲/高峰时段单价估算」这行说明下面是一张**近 7 天趋势**柱状图，附「日均 / 最高 / 较昨日」三格统计。

## 它长什么样

```
┌─ 右侧栏 ────────────────────┐
│ ▣ 余额明细 │ 文件 │         │  ← 标签条
├─────────────────────────────┤
│ ● 账户余额          刷新    │
│ ┌─────────────────────────┐ │
│ │ ¥9.35                   │ │
│ │ ─────────────────────── │ │
│ │ 赠送余额        ¥12.52  │ │
│ │ 充值  用量              │ │
│ └─────────────────────────┘ │
│ 今日消耗        命中率 99.4% │
│ ┌─────────────────────────┐ │
│ │ 25.96M tokens           │ │
│ │ ████████████████████░░  │ │  ← 输入侧命中率
│ │ ● 命中  ● 未命中  ● 输出 │ │
│ │ ─────────────────────── │ │
│ │ 今日消费         ≈¥1.18 │ │
│ │ API 请求          168 次 │ │
│ └─────────────────────────┘ │
│ 按空闲时段单价估算           │
│ ┌─────────────────────────┐ │
│ │ 近 7 天     合计 ≈¥15.56 · 6/7 │
│ │  ▁  ▃  ▂  ·  ▅  ▄  █    │
│ │ 10/11 10/12 …        今天 │
│ │ 日均 72.8M 最高 92.4M   │
│ │ 较昨日 +38%              │
│ │ 每次读到用量记一格；空格…│
│ └─────────────────────────┘ │
│ 更新于 12:03:45    已更新    │
└─────────────────────────────┘
```

刷新/重试按钮刻意放在标题行右端而不是面板右下角：那一片常被别的插件（例如视频皮肤的背景透明度控件）占用。

## 近 7 天趋势

每天一根柱子，高度按窗口内的峰值归一；**今天**那根是 100% 不透明的强调蓝，其余同色但压到 78% 不透明度。悬停任一柱子给出日期、精确 token 数与当天估算金额。

> 配色注意：这套设计系统里 `--dsw-alias-brand-primary` **不是蓝色**——它是墨色（浅色主题 #0f1115 / 深色主题 #f9fafb），早期版本拿它画柱子，深色下就是一根白条。
> 真正的强调蓝是 `--dsw-alias-brand-primary-new-colorprimary-new-color`（#4176e6 / #5686fe），面板里统一取成 `--dsb-accent`，并带 `--dsw-static-deepseek-500` 与字面量兜底。

柱子下面一行是统计：**日均**（只除有记录的天数）、**最高**（峰值那天的值，悬停看是哪天）、**较昨日**（今天相对昨天，涨用警示色、降用成功色；昨天没记录就显示 `—`）。

数据来自**本机历史**（`localStorage` 键 `dsh-deepseek-balance-panel/daily-v1`）：每次面板真的读到用量时，把当天这一格写成最新值（同一天覆盖，不累加），最多保留 40 天，取最近 7 天画。

这样做的取舍很明确：

- 没有打开过 DSH 的日子**没有柱子**，只留一个空位和日期 —— 不补 0，也不猜。少一天就多一句脚注解释，记满一周这行脚注自动消失。
- 第一次装上时只有今天这一根柱子，标题行的合计和统计条都不显示（一天的数据谈不上日均、也无可比）。
- 清空这份历史很简单：删掉那个 `localStorage` 键即可（等价于「忘掉以前的天数」）。

卡片会**吃掉面板的剩余高度**（上限 480px 高），所以窗口越高柱子越高，而不是在底部留一条空白带；窗口矮的时候柱区保底 52px。环形图被删掉之后，它是面板里唯一一张图，也因此可以长得更高。

## 数据从哪来

用量是**两路相加**，因为两边看到的东西不一样：

| 口径 | 来源 | 覆盖谁 |
| --- | --- | --- |
| 本机 DSH | DSH 会话投影缓存 `~/.dsh/storages/session_projcache/sessions/*.json` 的 `tokenUsage.totals` / `sessionStats.steps` | 这台机器上 DSH 自己跑的会话（走账号 OAuth，平台按 Key 的统计里看不到） |
| 平台 API Key | `platform.deepseek.com/api/v0/usage/by_api_key/amount` 与 `.../cost`（账号级，按 天 × Key × 模型 分桶） | 这个账号下**所有** API Key：CC Switch、Claude Code、脚本…… |

面板把两路**相加**：只统计本机会漏掉 CC Switch 的消耗，只统计平台会漏掉 DSH 的 OAuth 消耗。
两个数在卡片里分开列出，相加后的总计才是「全部 token」。

- 平台接口是网页版用量页用的**私有接口**，鉴权头是 `x-dsh-auth-token`（`Authorization: Bearer` 会被 `40003` 拒），凭据从 `deepseekAccount.getPlatformSession()` 拿，不落盘、不外传。
- 平台部分给出的是**实际扣费**（不是估算）；本机部分是**按价目估算**（见下），所以「今日消费」是两个口径相加，卡片下面写明了。
- 两边理论上可能重叠：如果 DSH 自身也被配置成用某个 API Key，那部分会同时出现在两处。实测本机 DSH 走 OAuth，平台里那把 `DEEPSEEK_API_KEY` 的流量来自别的客户端，因此没有做扣减；卡片里能看到两行分别是多少。
- 平台接口失败（未登录 / 登录态失效 / 网络）时自动退回「仅本机」口径，并在卡片下方注明。
- 余额仍然走 Host `deepseekAccount.getBalance()`（Platform `get_user_summary`）。

### 两条口径各自的口径与误差


- **今日** = 本地时区当天 00:00 起。
- 今天创建的会话：累计值就是这个会话今天的全部用量，精确。
- 跨天会话：以账本里「今天第一次看到它」的累计值做基线取差值；如果那天第一次采样晚于零点 10 分钟，面板会标注「跨天会话有部分用量未计入」。账本落在 `~/.dsh/dsh-deepseek-balance-panel/usage-baselines.json`，每天自动换页。
- **金额是估算**：投影只保存累计值，没有逐次请求的时间戳，所以按**当前时段**单价折算。DeepSeek 高峰（北京时间周内 9:00–12:00、14:00–18:00）单价是空闲时段的两倍，面板会明写这次用的是哪一档。价目表在 [index.js](index.js) 的 `PRICE_TABLE`，含 `deepseek-flash` 与 `deepseek-v4-pro`，未知模型按 flash 计。
- 请求次数取 `sessionStats.steps`，即模型请求步数；一轮里多次工具调用会算多次。
- 投影缓存在回合边界写入，所以数字可能比真实用量晚一个步骤。

## 安装

这是一个标准 DSH bundle（带 `dsh.bundle.patch`）。

**从 npm 装（推荐）：**

```bash
dsh plugin --profile desktop add dsh-deepseek-balance-panel
```

**从 GitHub 装（不经 npm，跟最新提交走）：**

```bash
dsh plugin --profile desktop add github:Listenind/YuE#main
```

装完**重启 DSH**（宿主半边不走 HMR），右侧栏就会出现「余额明细」。

**从本地目录装：** 包里带了幂等的安装脚本：

```bash
node scripts/install.mjs                      # 默认 ~/.dsh/profiles/desktop
node scripts/install.mjs --profile <dir>      # 或指定 profile
```

脚本做三件事：

1. 把包复制到 `<profile>/plugins/dsh-deepseek-balance-panel`（源）；
2. 复制到 `<profile>/node_modules/dsh-deepseek-balance-panel`（loader 实际解析的位置）；
3. 在 profile 的 `package.json` 里登记 `dependencies` 与 `dsh.profile.bundles`（登记前会留一份 `package.json.bak-dsh-deepseek-balance-panel`）。

DSH 会监听 profile 的 `package.json`，第一次装上一个**新名字**的 bundle 时宿主半边会即时装载。但注意两条平台约束：

- **宿主半边**（`index.js`）改代码后必须重启 DSH。Node 的 ESM 模块缓存按 URL 记录，已加载的模块不会被重新求值，换目录、改 `package.json`、增删 bundle 都不会让它重新求值。
- **客户端半边**（`lib/client.js`）改完刷新页面即可，必要时由 HMR 直接推送。

所以 `node_modules/dsh-deepseek-balance-panel` 做成指向 `plugins/dsh-deepseek-balance-panel` 的目录联接（junction），客户端侧的改动才落在 HMR 的监听范围内（它默认忽略 `**/node_modules`）；宿主侧该重启时还是得重启。

自检：

```bash
curl http://127.0.0.1:<port>/dsh-deepseek-balance-panel/state
# {"ok":true,"plugin":"deepseek-balance-panel","version":"1.5.0","accountService":"mounted",...}
curl 'http://127.0.0.1:<port>/dsh-deepseek-balance-panel/balance'
```

运行测试（Node 22+，不需要安装依赖）：

```bash
node tests/client.test.mjs && node tests/host.test.mjs
# 或
npm test
```

卸载：从 `dsh.profile.bundles` 与 `dependencies` 里去掉该名字，删掉 `plugins/` 与 `node_modules/` 下的目录，刷新页面。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：余额查询、今日用量聚合（本机 + 平台）、HTTP 路由 |
| `lib/client.js` | Client 半边（浏览器 bundle）：tab 类型、正文、标题、引导入口 |
| `cordis.patch.yml` | bundle 的 patch 层，把本包的 Loader 条目插进组合树 |
| `scripts/install.mjs` | 幂等安装脚本 |
| `scripts/verify.mjs` | 发布前自检（55 项：契约、产物、语法、测试、泄密） |
| `PUBLISHING.md` | 发布 / 让别人一行装的步骤与三条硬约束 |
| `tests/client.test.mjs` | 客户端半边冒烟测试（假 React + 假浏览器） |
| `tests/host.test.mjs` | 宿主路由端到端测试（假 webServer + 假账号，真读投影缓存） |

### Host 接口

`GET /dsh-deepseek-balance-panel/balance?locale=zh-CN&tz=-480&force=1`

```jsonc
{
  // 余额部分
  "ok": true,
  "wallets": [{ "currency": "CNY", "balance": "9.35172738" }],
  "bonusWallets": [{ "currency": "CNY", "balance": "12.61686716" }],
  "fetchedAt": 1792206138981,
  "links": { "topUpUrl": "…", "usageUrl": "…" },
  // 今日用量部分（与余额互相独立）
  "usage": {
    "day": "2026-10-17", "available": true,
    "totalTokens": 25957649, "cacheReadTokens": 25664512,
    "uncachedInputTokens": 167716, "outputTokens": 125421,
    "requests": 168, "sessions": 2,
    "cost": 1.1827, "currency": "CNY",
    "peak": false, "partial": false, "ledger": "ok"
  }
}
```

余额失败时 `ok` 为 `false` 且带 `reason`（`signed-out` / `unavailable` / `failed` / `timeout`），`usage` 照旧返回。
余额缓存 15 秒、用量缓存 30 秒，并合并同刻并发请求；`force=1` 同时绕过两者。

`GET /dsh-deepseek-balance-panel/state` 只做自检：插件是否装载、`deepseekAccount` 是否可见、投影缓存目录读到多少文件。

## 可调项

都在代码顶部，改完刷新页面即可生效：

| 常量 | 位置 | 默认 | 含义 |
| --- | --- | --- | --- |
| `REFRESH_MS` | `lib/client.js` | `30000` | 面板可见时的轮询间隔 |
| `FLASH_MS` | `lib/client.js` | `1800` | 点击刷新后回执停留时长 |
| `AUTO_OPEN` | `lib/client.js` | `true` | 每次页面加载后是否自动把该页开进右侧栏一次 |
| `HISTORY_DAYS` / `HISTORY_KEEP` | `lib/client.js` | `7` / `40` | 趋势图显示几天，以及本机历史最多保留几天 |
| `PRICE_TABLE` | `index.js` | 官方价目 | 各模型每百万 token 的空闲/高峰单价 |
| `BALANCE_CACHE_TTL_MS` / `USAGE_CACHE_TTL_MS` | `index.js` | `15000` / `30000` | 两个缓存窗口 |

## 已知取舍

- 标签标题在打开时会被固定（右侧栏约定），但本包注册了标题槽位，所以 chip 上的「余额明细」会跟着语言变。
- 自动打开只尝试一次：用户手动关掉标签后，直到下次刷新页面都不会再被强行打开。
- 余额与「设置 → 账户」里显示的是同一份数据，两处最多有 15 秒缓存差异。
- 近 7 天只统计「面板真的读到过用量」的日子，所以换一台机器、清掉浏览器数据，历史就从头开始。

## 许可

MIT
