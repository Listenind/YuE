#!/usr/bin/env node
/**
 * 把本包装进一个 DSH profile。
 *
 * 做三件事，全部幂等：
 *   ① 把包复制到 `<profile>/plugins/dsh-deepseek-balance`（源）；
 *   ② 复制到 `<profile>/node_modules/dsh-deepseek-balance`（loader 实际解析的位置）；
 *   ③ 在 profile 的 `package.json` 里登记 `dsh.profile.bundles` 与 `dependencies`。
 *
 * profile 取 `--profile <dir>`，其次是 `$DSH_PROFILE_DIR`，最后是
 * `~/.dsh/profiles/desktop`。
 *
 * @module scripts/install
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包名即 profile 里的依赖名与 bundle 名。 */
const PKG = 'dsh-deepseek-balance'

/** 本包根目录。 */
const SRC = fileURLToPath(new URL('..', import.meta.url))

/**
 * 解析目标 profile 目录。
 * @param {string[]} argv 命令行参数。
 * @returns {string} profile 绝对路径。
 */
function resolveProfile(argv) {
  const index = argv.indexOf('--profile')
  if (index !== -1 && argv[index + 1] !== undefined) return path.resolve(argv[index + 1])
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR)
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
}

const profile = resolveProfile(process.argv.slice(2))
const plugins = path.join(profile, 'plugins', PKG)
const modules = path.join(profile, 'node_modules', PKG)
const manifestPath = path.join(profile, 'package.json')

if (!fs.existsSync(manifestPath)) throw new Error(`not a dsh profile (no package.json): ${profile}`)

// 任何写操作都必须落在目标 profile 之内。
for (const target of [plugins, modules, manifestPath]) {
  const resolved = path.resolve(target).toLowerCase()
  if (!resolved.startsWith(path.resolve(profile).toLowerCase() + path.sep)) {
    throw new Error(`refusing to write outside the profile: ${target}`)
  }
}

/**
 * 复制整个包到目标位置（覆盖）。
 * @param {string} destination 目标目录。
 */
function copyInto(destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true })
  fs.cpSync(SRC, destination, {
    recursive: true,
    filter: (from) => !from.includes(`${path.sep}node_modules${path.sep}`) && !from.includes(`${path.sep}.git${path.sep}`),
  })
  process.stdout.write(`copied -> ${destination}\n`)
}

copyInto(plugins)

// node_modules 里的那一份做成指向 plugins 的目录联接（junction）：
//   - Node 解析会 realpath 到 plugins/…，于是 loader 拿到的模块路径在
//     `**/node_modules` 之外 —— 而 DSH 的 HMR 默认忽略 node_modules，
//     只有路径在监听范围内，改完宿主半边才会热装载，不用重启应用。
//   - 万一建不了联接（权限/文件系统不支持），退回复制，并提示需要重启。
let linked = false
try {
  fs.mkdirSync(path.dirname(modules), { recursive: true })
  if (fs.existsSync(modules) || fs.lstatSync(modules, { throwIfNoEntry: false }) !== undefined) {
    fs.rmSync(modules, { recursive: true, force: true })
  }
  fs.symlinkSync(plugins, modules, process.platform === 'win32' ? 'junction' : 'dir')
  linked = true
  process.stdout.write(`linked -> ${modules} => ${plugins}\n`)
} catch (error) {
  process.stdout.write(`junction failed (${error.message}); falling back to a copy\n`)
  copyInto(modules)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
fs.writeFileSync(`${manifestPath}.bak-${PKG}`, `${JSON.stringify(manifest, null, 2)}\n`)

manifest.dependencies ??= {}
manifest.dependencies[PKG] = `file:plugins/${PKG}`
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
if (!manifest.dsh.profile.bundles.includes(PKG)) manifest.dsh.profile.bundles.push(PKG)

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`manifest updated -> ${manifestPath}\n`)
process.stdout.write(
  linked
    ? 'the hosting half reloads on its own; reload the DSH page to pick up the new client bundle\n'
    : 'restart DSH (the hosting half is copied, not linked) and reload the page\n',
)
