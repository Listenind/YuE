# dsh-deepseek-balance-panel

在 DSH 右侧栏常驻一个「余额明细」标签页：上面是当前登录 DeepSeek 账号的**充值钱包 / 赠送钱包余额**，下面依次是**今日用量**（总消耗、命中 / 未命中 / 输出、消费金额、API 请求次数）、**近 7 天趋势**、**来源用量**（谁在烧 token）、**会话用量**（每个会话各烧多少），外加一条**插件自更新**入口。

- 面板可见时每 30 秒自动刷新；窗口重新获得焦点时也会刷新。
- 点「刷新」有明确回执：按钮变「刷新中…」并禁用、状态点呼吸；请求结束在页脚留一句「已更新 / 更新失败」，1.8 秒后消失。手动点击带 `force=1` 绕过缓存，时间戳一定走动。
- 面板被折叠 / 切到别的标签 / 切到后台会话时不轮询。
- 未登录、账号服务缺失、查询失败各有独立空状态，绝不把失败显示成 0 元；**余额读不到时今日用量照常显示**。
- 「今日消耗」卡片把三段 token 都摆出来：**命中 / 未命中 / 输出**；上面那根占比条只讲输入侧的命中率。
- 趋势图下面还有一张**来源用量**图：把今天的 token 按「谁用的」排开——本机按会话的 agent preset 分组（机器人会以它自己的 preset id 出现，比如 `qq-fish`），平台按 API Key 分组（小号 / 脚本用自己的 Key 就单独一条）。
- 再往下是**会话用量**：今天每个会话各自烧了多少 token，按从多到少**全部列出**（标题取会话的 `title`，没有就回落成「preset + sessionId 前 8 位」）。
- 有新版本时顶部出现一条**「新版本 x.y.z · 更新」**，点一下由宿主在 profile 里跑 `pnpm add`；装完变成「已安装 x.y.z，重启 DSH 生效」。
- 「按空闲/高峰时段单价估算」这行说明下面是一张**近 7 天趋势**柱状图，附「日均 / 最高 / 较昨日」三格统计。

## 它长什么样

```
┌────────────────────────────────────────────┐
│ ▣ 余额明细 │ 文件 │                        │
├────────────────────────────────────────────┤
│ 新版本 1.8.14                     〔更新〕 │
│ ● 账户余额                            刷新 │
│ ┌────────────────────────────────────────┐ │
│ │ ¥13.75                                 │ │
│ │ ────────────────────────────────────── │ │
│ │ 赠送余额                         ¥6.40 │ │
│ │ 充值  用量                             │ │
│ └────────────────────────────────────────┘ │
│ 今日消耗                      命中率 99.6% │
│ ┌────────────────────────────────────────┐ │
│ │ 148M tokens                            │ │
│ │ ██████████████████████████▏            │ │
│ │ ● 命中  ● 未命中  ● 输出               │ │
│ │ ────────────────────────────────────── │ │
│ │ 其中本机 DSH           147.7M · 483 次 │ │
│ │ 平台 API Key           148.0M · 485 次 │ │
│ │ Key Deep Seek Hansen · CC Switch       │ │
│ │ 今日消费                       ≈¥11.30 │ │
│ │ API 请求                        485 次 │ │
│ └────────────────────────────────────────┘ │
│ 本机与平台是同一批请求，总计只算一次       │
│ ┌────────────────────────────────────────┐ │
│ │ 近 7 天                合计 ≈¥61 · 6/7 │ │
│ │  ▃   ▂   ▃   ▂   ·   █   ▅             │ │
│ │ 11/4 11/5 11/6 11/7 11/8 11/9 今天     │ │
│ │ 日均 180M  最高 590M  较昨日 -73%      │ │
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ 来源用量                    今日 token │ │
│ │ Deep See…  ████████████    148M ¥11.30 │ │
│ │ cordis     ███████████     147M ¥11.23 │ │
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ 会话用量                    今日 token │ │
│ │ 儒道至圣…剧本大纲 ████    116.9M ¥5.53 │ │
│ │ 移动余额明细插件… █        25.4M ¥1.22 │ │
│ │ 你要为《文气通天》…        5.54M ¥0.96 │ │
│ │ …（全部列出，不折叠）                  │ │
│ └────────────────────────────────────────┘ │
│ 更新于 11:39:59 · v1.8.14                  │
└────────────────────────────────────────────┘
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

柱区高度用 `clamp(96px, 20vh, 168px)` 定死，卡片本身不再抢面板剩余高度：窗口很高时不会留一大片空白，窗口很矮时也不会挤压下面的卡片。（早期版本用 `flex:1` 抢高度，窄窗口里柱子会溢出、压在下一张卡上——这是个真踩过的坑。）

## 数据从哪来

用量是**两路相加**，因为两边看到的东西不一样：

| 口径 | 来源 | 覆盖谁 |
| --- | --- | --- |
| 本机 DSH | DSH 会话投影缓存 `~/.dsh/storages/session_projcache/sessions/*.json` 的 `tokenUsage.totals` / `sessionStats.steps` | 这台机器上 DSH 自己跑的会话（走账号 OAuth，平台按 Key 的统计里看不到） |
| 平台 API Key | `platform.deepseek.com/api/v0/usage/by_api_key/amount` 与 `.../cost`（账号级，按 天 × Key × 模型 分桶） | 这个账号下**所有** API Key：CC Switch、Claude Code、脚本…… |
| 来源细分 | 同一份投影缓存 + 平台接口，按会话的 `agentPreset` 与 API Key 名称分组 | 「谁在用」：机器人、小号、脚本各自一行（本机那部分不重复计入总计） |

面板默认把两路**相加**：只统计本机会漏掉别的客户端的消耗，只统计平台会漏掉走账号（OAuth）的 DSH 会话。
但当 DSH 自己也在用某把 API Key 推理时（`provider: deepseek-official` → `llm-deepseek`），同一批请求会同时出现在两边 ——
这时宿主会把「本机量落在平台里那把 Key 的 0.4x–1.6x 区间内」判定为重叠，总计改用平台口径（与官网用量页同源），本机只作为「其中」的核对行，不再相加。
两个数在卡片里分开列出，相加后的总计才是「全部 token」。

- 平台接口是网页版用量页用的**私有接口**，鉴权头是 `x-dsh-auth-token`（`Authorization: Bearer` 会被 `40003` 拒），凭据从 `deepseekAccount.getPlatformSession()` 拿，不落盘、不外传。
- 平台部分给出的是**实际扣费**（不是估算）；本机部分是**按价目估算**（见下），所以「今日消费」是两个口径相加，卡片下面写明了。
- 两边可能**重叠**：DSH 自己就被配置成用某把 API Key 时（`provider: deepseek-official` → `llm-deepseek`），同一批请求会同时出现在本机投影和平台按 Key 的统计里。宿主用「本机量落在平台里那把 Key 的 0.4x–1.6x 区间内」判定重叠：命中就以**平台口径**为准、本机只作「其中」核对行；没命中才相加。没有这一步时同一批 token 会被算两遍（实测正好翻倍，和官网用量页对不上）。
- 平台接口失败（未登录 / 登录态失效 / 网络）时自动退回「仅本机」口径，并在卡片下方注明。
- 余额仍然走 Host `deepseekAccount.getBalance()`（Platform `get_user_summary`）。

## 来源用量

趋势图下面那张横向条形图回答「今天的 token 是谁用的」：

- **本机**：按会话的 `agentPreset` 分组。机器人插件会以它自己的 preset id 出现（例如 `qq-fish`），你用 GUI 的会话是 `cordis` / `standard` 之类——面板不猜任何具体插件，preset 叫什么就显示什么。
- **平台**：按 API Key 名称分组。你用小号 / 脚本调 DeepSeek 时用的是哪把 Key，就显示哪个名字。

只画今天真正有消耗的来源，最多 6 条，按 token 从多到少排；每条右侧带今天的金额（本机是估算，平台是按 Key 的实扣）。鼠标悬停一条会给出「本机/平台 · 名字 · 精确 token 数 · 金额」。来源加起来等于卡片顶部那个总数，不会重复计算。会话级别的完整清单在下一张「会话用量」里。

> 这里也会**去重**：判定本机与平台重叠时，平台侧跳过「本机正在用的那把 Key」（`keys[].own`），只保留其它 Key，卡片底部注明「平台那把 Key 就是本机 DSH 的流量，已合并为一行」。否则同一批请求会在 `cordis` 与 `Deep Seek Hansen` 里各出现一次，看起来像翻倍。

> 名字来自 DSH 自己的标识：`agentPreset` id 与 Platform 的 Key 名称。想让机器人那行更好认，就把 `dsh-qq-bot` 的 `agentPreset` 起一个明白的名字；想让小号那行更好认，就在 Platform 里给那把 Key 改个名。

### 两条口径各自的口径与误差


- **今日** = 本地时区当天 00:00 起。
- 今天创建的会话：累计值就是这个会话今天的全部用量，精确。
- 跨天会话：以账本里「今天第一次看到它」的累计值做基线取差值；如果那天第一次采样晚于零点 10 分钟，面板会标注「跨天会话有部分用量未计入」。账本落在 `~/.dsh/dsh-deepseek-balance-panel/usage-baselines.json`，每天自动换页。
- **金额是估算**：投影只保存累计值，没有逐次请求的时间戳，所以按**当前时段**单价折算。DeepSeek 高峰（北京时间周内 9:00–12:00、14:00–18:00）单价是空闲时段的两倍，面板会明写这次用的是哪一档。价目表在 [index.js](index.js) 的 `PRICE_TABLE`，含 `deepseek-flash` 与 `deepseek-v4-pro`，未知模型按 flash 计。
- 请求次数取 `sessionStats.steps`，即模型请求步数；一轮里多次工具调用会算多次。
- 投影缓存在回合边界写入，所以数字可能比真实用量晚一个步骤。

## 会话用量

来源图下面还有一张**会话用量**：今天每个会话各自烧了多少 token，按从多到少排。

- 行首是会话标题（取投影缓存里的 `title`）；新会话还没起名时，回落到「preset + sessionId 前 8 位」。
- 右侧是 token 与**按价目表估算**的金额；悬停能看到完整标题、精确 token、请求次数与金额。
- **全部列出**，不折叠（面板本身可滚动）；宿主最多给 200 条，只作为 payload 的兜底上限。
- 数字和「今日消耗」同一套口径：今天新建的会话算全量，跨天会话用当日基线取差值——所以会话加起来可能略小于本机总量，差额就是那部分没记到的跨天增量。

## 更新

作者发了新版本之后，装了本插件的人不用重新输命令：

1. 打开面板时查一次（此后每 6 小时一次），宿主缓存 10 分钟；
2. 有新版本 → 顶部出现 **「新版本 x.y.z · 更新」**（悬停显示上次检查时间）；
3. 点「更新」→ 宿主在 profile 目录里执行 `pnpm add dsh-deepseek-balance-panel@<版本>`，装完**核对磁盘上的 `package.json` 版本**，只有真的等于目标版本才算成功；
4. 成功后条变成绿色 **「已安装 x.y.z，重启 DSH 生效」**，页脚同时显示 `· 已装 x.y.z，待重启`；
5. 重启 DSH（托盘右键 → 重启）完成。

几个实现细节：

- **怎么知道去哪查**：宿主读 `~/.dsh/profiles/desktop/package.json` 里本包的依赖声明。
  - 语义化版本（`^1.8.0` / `1.8.14`）→ 查 npm registry 的 `latest`；
  - `github:owner/repo#ref` → 查 GitHub 上该 ref 的 `package.json`；
  - `file:plugins/…`（开发时的本地链接）→ **不提示更新**，那是作者的工作区副本。
- **不用 DSH 的 `pluginManager.installBundle()`**：它对「已安装的同名包」直接返回 `{ok:true, value:{status:"refused", problem:"already-installed"}}`，而 `removeBundle` 又要求先停掉 profile —— 它设计上是「装新插件」，不是「升级已装」。所以更新走宿主自己的 pnpm，等价于手工 `dsh plugin add`。
- **pnpm 用哪份**：优先用 DSH 自带的（`resources/runtime/primary-runtime/dependencies/pnpm`，v11），它和 profile 里的 store 大版本一致；系统里如果是 pnpm 10 会因 store 不匹配直接失败。
- **幂等**：重复点击、或磁盘已经是目标版本时，pnpm 打印 `Already up to date`，这算成功（早期版本把它判成失败，白报错）。
- **失败怎么办**：检查失败只写日志；更新失败在页脚显示 `插件更新失败 · <pnpm 尾部输出>`，按钮保留可重试。

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
# {"ok":true,"plugin":"deepseek-balance-panel","version":"1.8.14","accountService":"mounted",...}
curl 'http://127.0.0.1:<port>/dsh-deepseek-balance-panel/balance'
curl 'http://127.0.0.1:<port>/dsh-deepseek-balance-panel/update?force=1'
# {"ok":true,"current":"1.8.14","installed":"1.8.14","latest":"1.8.14","mode":"npm","available":false}
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
| `index.js` | Host 半边：余额查询、今日用量聚合（本机 + 平台 + 来源 + 会话）、更新检查与执行、HTTP 路由 |
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
  "version": "1.8.14",
  "usage": {
    "day": "2026-11-10", "available": true, "overlap": true,
    "totalTokens": 148000000, "cacheReadTokens": 146900000,
    "uncachedInputTokens": 566600, "outputTokens": 536000,
    "requests": 485, "sessions": 10,
    "cost": 11.3, "currency": "CNY",
    "peak": false, "partial": false, "ledger": "ok",
    "local": {
      "totalTokens": 147700000, "requests": 483, "cost": 11.3,
      "sources": [{ "source": "cordis", "totalTokens": 147700000, "requests": 483, "cost": 11.3 }],
      "sessions": [{ "id": "session-…", "title": "…", "preset": "cordis", "tokens": 147700000, "requests": 483, "cost": 11.3 }]
    },
    "platform": { "available": true, "today": { "tokens": 148000000, "cost": 11.3 } }
  }
}
```

余额失败时 `ok` 为 `false` 且带 `reason`（`signed-out` / `unavailable` / `failed` / `timeout`），`usage` 照旧返回。
余额缓存 15 秒、用量缓存 30 秒，并合并同刻并发请求；`force=1` 同时绕过两者。

`GET /dsh-deepseek-balance-panel/state` 只做自检：插件是否装载、`deepseekAccount` 是否可见、投影缓存目录读到多少文件。

`GET /dsh-deepseek-balance-panel/update` 返回 `{ current, installed, latest, available, needsRestart, mode, spec, updateSpec, checkedAt }`；
`POST /dsh-deepseek-balance-panel/update/apply` 执行升级（只接受 POST），成功返回 `{ ok:true, before, installed, target }`，失败带 `reason` 与 pnpm 输出尾部。

## 可调项

都在代码顶部，改完刷新页面即可生效：

| 常量 | 位置 | 默认 | 含义 |
| --- | --- | --- | --- |
| `REFRESH_MS` | `lib/client.js` | `30000` | 面板可见时的轮询间隔 |
| `FLASH_MS` | `lib/client.js` | `1800` | 点击刷新后回执停留时长 |
| `AUTO_OPEN` | `lib/client.js` | `true` | 每次页面加载后是否自动把该页开进右侧栏一次 |
| `HISTORY_DAYS` / `HISTORY_KEEP` | `lib/client.js` | `7` / `40` | 趋势图显示几天，以及本机历史最多保留几天 |
| `UPDATE_CHECK_MS` | `lib/client.js` | `6h` | 客户端多久问一次有没有新版本（宿主另有 10 分钟缓存） |
| `PRICE_TABLE` | `index.js` | 官方价目 | 各模型每百万 token 的空闲/高峰单价 |
| `BALANCE_CACHE_TTL_MS` / `USAGE_CACHE_TTL_MS` | `index.js` | `15000` / `30000` | 两个缓存窗口 |

## 已知取舍

- 标签标题在打开时会被固定（右侧栏约定），但本包注册了标题槽位，所以 chip 上的「余额明细」会跟着语言变。
- 自动打开只尝试一次：用户手动关掉标签后，直到下次刷新页面都不会再被强行打开。
- 余额与「设置 → 账户」里显示的是同一份数据，两处最多有 15 秒缓存差异。
- 近 7 天只统计「面板真的读到过用量」的日子，所以换一台机器、清掉浏览器数据，历史就从头开始。
- 一键更新只覆盖 npm 安装；`github:` 与 `file:` 安装不提供「点一下就升级」（前者的 ref 可能是分支，后者是开发副本）。
- 更新完必须重启 DSH：宿主半边（ESM 模块）不会热替换，页面刷新只换客户端半边。
- 会话用量把当天所有会话都列出来，不折叠也不分页——一天几十个会话时这张卡会很长，面板本身可滚动。

## 许可

MIT
