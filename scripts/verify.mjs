#!/usr/bin/env node
/**
 * 发布前自检：确认这个仓库「别人 clone 下来就能装」。
 *
 * 检查的都是会真的把安装搞坏的东西：
 *   - 生命周期脚本（pnpm 会拒绝带 prepare 的 git 依赖，`dsh plugin add` 直接失败）；
 *   - `dsh.bundle.patch` 指向的 patch 层与包名不一致（装上了但不生效）；
 *   - 产物没进仓库（clone 下来没有能跑的东西）；
 *   - 把自己的绝对路径 / 密钥漏进产物。
 *
 *     node scripts/verify.mjs
 *
 * 退出码 0 表示可以发布。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let failures = 0
let checks = 0

/**
 * 记一条检查结果。
 * @param {boolean} ok 是否通过。
 * @param {string} label 检查内容。
 * @param {string} [detail] 失败时的说明。
 * @returns {void}
 */
function check(ok, label, detail) {
  checks += 1
  if (ok) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

process.stdout.write(`verifying ${pkg.name}@${pkg.version}\n\n`)

/* ------------------------------------------------------------------ 元数据 -- */

process.stdout.write('metadata\n')
check(pkg.name === 'dsh-deepseek-balance-panel', 'package name is the canonical bundle name', pkg.name)
check(/^\d+\.\d+\.\d+/.test(pkg.version), 'version is semver', pkg.version)
check(pkg.type === 'module', 'package is ESM')
check(pkg.license === 'MIT', 'license is MIT')
check(existsSync(join(ROOT, 'LICENSE')), 'LICENSE file present')
check(existsSync(join(ROOT, 'README.md')), 'README present')
check(typeof pkg.description === 'string' && pkg.description.length > 20, 'description explains the plugin')

/* -------------------------------------------------------------- 生命周期脚本 -- */

process.stdout.write('\nlifecycle scripts (must stay empty for git installs)\n')
const forbidden = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']
for (const name of forbidden) {
  check(pkg.scripts?.[name] === undefined, `no "${name}" script`)
}

/* ------------------------------------------------------------------- 产物 -- */

process.stdout.write('\nshipped files\n')
const required = ['index.js', 'lib/client.js', 'cordis.patch.yml', 'scripts/install.mjs']
for (const file of required) {
  check(existsSync(join(ROOT, file)), `${file} exists`)
}
const listed = Array.isArray(pkg.files) ? pkg.files : []
for (const entry of ['index.js', 'lib', 'cordis.patch.yml']) {
  check(listed.includes(entry), `"files" lists ${entry}`)
}

/* --------------------------------------------------------------- bundle 契约 -- */

process.stdout.write('\nbundle contract\n')
const patchRel = pkg.dsh?.bundle?.patch
check(typeof patchRel === 'string', 'dsh.bundle.patch is declared')
const patchPath = typeof patchRel === 'string' ? join(ROOT, patchRel) : undefined
check(patchPath !== undefined && existsSync(patchPath), 'the patch file exists', patchRel)
if (patchPath !== undefined && existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  const nameMatch = /name:\s*([A-Za-z0-9@/._-]+)/.exec(patch)
  check(nameMatch?.[1] === pkg.name, 'patch inserts an entry named like the package', nameMatch?.[1])
  check(/\binsert:/.test(patch), 'patch uses an insert block')
}

process.stdout.write('\nclient half\n')
check(pkg.dsh?.client?.platform === 'web', 'client platform is web')
const inject = pkg.dsh?.client?.inject ?? []
for (const service of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-slots']) {
  check(inject.includes(service), `client injects ${service}`)
}
const clientSource = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
check(clientSource.includes('__ModuleLoader__.load'), 'client bundle registers with the module loader')
check(clientSource.includes(`id: '${pkg.name}'`), 'client bundle registers under the package name')

/* ----------------------------------------------------------------- 语法/测试 -- */

process.stdout.write('\nsyntax and tests\n')
for (const file of ['index.js', 'lib/client.js', 'scripts/install.mjs']) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' })
    check(true, `${file} parses`)
  } catch (error) {
    check(false, `${file} parses`, String(error.stderr ?? error.message).slice(0, 200))
  }
}
for (const suite of ['tests/client.test.mjs', 'tests/host.test.mjs']) {
  if (!existsSync(join(ROOT, suite))) {
    check(false, `${suite} runs`, 'missing')
    continue
  }
  try {
    execFileSync(process.execPath, [join(ROOT, suite)], { stdio: 'pipe' })
    check(true, `${suite} passes`)
  } catch (error) {
    check(false, `${suite} passes`, String(error.stderr ?? error.message).slice(0, 300))
  }
}

/* --------------------------------------------------------------- 泄露/残留 -- */

process.stdout.write('\nhygiene\n')
const shipped = ['index.js', 'lib/client.js', 'README.md', 'package.json', 'cordis.patch.yml', 'scripts/install.mjs']
for (const file of shipped) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  check(!/C:\\\\Users\\\\[^\\s"']+/i.test(text) && !/C:\\Users\\/.test(text), `${file} has no absolute user path`)
  check(!/\bsk-[A-Za-z0-9]{16,}\b/.test(text), `${file} has no API key literal`)
  check(!/\b\d{6,}@qq\.com\b/.test(text), `${file} has no personal contact`)
}
check(!existsSync(join(ROOT, 'node_modules')), 'no node_modules directory committed')
check(!existsSync(join(ROOT, '.tmp')), 'no .tmp directory committed')

/* ------------------------------------------------------------------- 汇总 -- */

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`)
if (failures > 0) {
  process.stdout.write('NOT READY to publish\n')
  process.exit(1)
}
process.stdout.write('READY to publish\n')
