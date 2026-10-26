# 发布 / 让别人一行装

目标：别人在 **设置 → 插件 → 添加插件** 里输入

```
github:Listenind/YuE#main
```

就能装上这个插件。

---

## 0. 为什么这个仓库推上去就能装（别破坏这三件事）

| 条件 | 本仓库状态 | 破坏了会怎样 |
| --- | --- | --- |
| **产物已提交**（`index.js` / `lib/` / `scripts/` / `cordis.patch.yml`） | ✅ 全在 git 里 | clone 下来没有能跑的东西 |
| **没有 `prepare` / `prepack` / `postinstall`** | ✅ 一个都没有 | pnpm 会拒绝 git 依赖的构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），`dsh plugin add` 直接失败 |
| **`dsh.bundle.patch` + 包名 + patch 里的 `name` 三者一致** | ✅ 都是 `dsh-deepseek-balance-panel` | 插件不会成为一层；或 loader 只 warn 然后跳过（表现是「装上了但没生效」） |

这三条有自动化守着：

```powershell
node scripts/verify.mjs
```

55 项检查：元数据、生命周期脚本、产物、bundle 契约、客户端注册、语法、两套测试、以及「别把自己的盘符路径 / API Key / 私人邮箱漏进产物」。

---

## 1. 建仓库

浏览器方式：<https://github.com/new> → 名字填 **`dsh-deepseek-balance-panel`** → **Public** →
**不要**勾 "Add a README / .gitignore / license"（本地已经有了）→ Create。

命令行方式（需 `gh`，本机目前没装）：

```powershell
winget install --id GitHub.cli
gh auth login
gh repo create Listenind/YuE --public --source . --push
```

## 2. 推上去

本地仓库已经初始化并提交好了，只差一个远端：

```powershell
cd "D:\Programs\DSH Desktop 插件开发\plugins\dsh-deepseek-balance-panel"
git remote add origin https://github.com/Listenind/YuE.git
git push -u origin main
git push origin --tags
```

## 3. 发布后自己验一遍（别相信"应该能装"）

在一个**干净的 profile** 里装一次，别用你正在开发的那个：

```powershell
$env:DSH_HOME = "C:\Users\JIANG\AppData\Local\Temp\dsh-clean-home"
dsh plugin --profile desktop add github:Listenind/YuE#main
```

或者更直接：把整个 `~/.dsh/profiles/desktop/plugins/dsh-deepseek-balance-panel` 目录临时改名，
在真机上装一次看看侧栏有没有出现「余额明细」。

装完**重启 DSH**（宿主半边不会被 HMR 接管），然后用自检接口确认：

```powershell
curl http://127.0.0.1:<port>/dsh-deepseek-balance-panel/state
# {"ok":true,...,"platformSession":"present","ownApiKey":"configured"}
```

## 3.5 发布到 npm（让「只填包名」也能装）

包名 `dsh-deepseek-balance-panel`（npm 上无人占用；`dsh-deepseek-balance` 已被别人的插件占着）。

本机默认 registry 是 npmmirror 镜像，**镜像不能发布**，所以必须显式指定官方源：

```powershell
npm login --registry=https://registry.npmjs.org     # 浏览器登录，或 npm login --auth-type=legacy
npm publish --access public --registry=https://registry.npmjs.org
```

发布前先跑 `node scripts/verify.mjs`（55 项）。`files` 白名单已经把产物列全，`README` / `LICENSE` 由 npm 自动带上。

发布后别人就能：

```bash
dsh plugin --profile desktop add dsh-deepseek-balance-panel
```

> 只想发 GitHub 的话可以跳过这一节，用 `github:Listenind/YuE#main` 一样能装。

## 4. 以后发新版本

```powershell
# 改完代码后
node scripts/verify.mjs          # 必须 55/55
git add -A
git commit -m "feat: ..."
git tag v1.5.1                   # 跟 package.json 的 version 对齐
git push && git push origin --tags
```

别人升级：

```
dsh plugin --profile desktop add github:Listenind/YuE#v1.5.1
```

> 只写 `#main` 会跟最新提交走；写 tag 更可控。

---

## 5. 发布前必须知道的两件事

- **平台用量接口是私有接口**（`/api/v0/usage/by_api_key/*`，鉴权头 `x-dsh-auth-token`）。
  它属于 DeepSeek 网页版用量页，不是官方公开 API，**随时可能变**。变了之后插件会退回
  「只统计本机 DSH 会话」并在卡片上注明，不会假装还有数据。
- **余额与用量都只发生在本地**：凭证从宿主 `deepseekAccount` 服务拿，不落盘、不外传、不收集任何遥测。
  仓库里没有任何密钥，`scripts/verify.mjs` 每次都会检查这一点。

## 6. 许可

MIT（见 [LICENSE](LICENSE)）。
