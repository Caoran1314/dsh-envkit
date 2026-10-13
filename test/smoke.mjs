/**
 * 冒烟测试：按**真实宿主契约**用 mock ctx 加载插件。
 * 真实契约（从可用的 dsh-whale-market 实现读出）：
 *   const toolsService = ctx.get('tools')
 *   ctx.effect(() => toolsService.register(tool))
 *   ctx.on('internal/service', n => { if (n === 'tools') retry() })
 *
 * 覆盖两条路径：
 *   A. apply() 时 tools 服务已就绪 → 直接注册
 *   B. apply() 时 tools 服务**尚未**就绪 → 等服务事件到达后补注册
 *      （本插件第一版就是漏了 B，导致 last-load.json 里 tools: 0）
 * 运行：node test/smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ── mock 宿主 ─────────────────────────────────────────────────────── */
function makeHost({ toolsReady = true } = {}) {
  const tools = new Map()
  const commands = new Map()
  const serviceListeners = new Map()
  let routeCount = 0
  let toolsService = null

  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => {
      if (k === 'tools') return toolsService
      if (k === 'webServer') return { register: () => { routeCount += 1; return () => {} } }
      if (k === 'connection') return { requestRejection: () => false }
      return undefined
    },
    effect: (fn) => { fn(); return () => {} },
    on: (evt, fn) => { const l = serviceListeners.get(evt) ?? []; l.push(fn); serviceListeners.set(evt, l) },
    commands: { register: (d) => { if (!d?.name) return false; commands.set(d.name, d); return true } }
  }

  const service = { register: (t) => { if (!t?.name) return false; tools.set(t.name, t); return true } }
  if (toolsReady) toolsService = service

  const emitService = (name) => {
    if (name === 'tools') toolsService = service
    for (const fn of serviceListeners.get('internal/service') ?? []) fn(name)
  }

  return { ctx, tools, commands, emitService, routes: () => routeCount }
}

const plugin = await import('../lib/index.js')
let failures = 0
const check = (cond, msg) => { if (cond) console.log('✓ ' + msg); else { console.error('✗ ' + msg); failures += 1 } }

/* ── 路径 A：tools 已就绪 ──────────────────────────────────────────── */
console.log('— 路径 A：apply 时 tools 服务已就绪 —')
const A = makeHost({ toolsReady: true })
const ra = plugin.apply(A.ctx, {})
check(ra.registered === 3, `注册 3 个工具（实际 ${ra.registered}）`)
for (const n of ['env_probe', 'safe_json_edit', 'git_repair']) check(A.tools.has(n), `工具已注册: ${n}`)
check(A.routes() === 2, `注册 2 条路由（实际 ${A.routes()}）`)
check(A.commands.size === 3, `注册 3 个命令（实际 ${A.commands.size}）`)

/* ★ 回归守卫：每个工具必须声明 output { schema, render }
   缺了会被注册中心拒绝（'must declare output ...'），且该异常默认被静默吞掉。
   本插件曾因此出现"插件加载成功但 tools: 0"。 */
console.log('\n— 回归守卫：output 契约 —')
for (const def of plugin.buildTools()) {
  check(!!def.output, `${def.name} 声明了 output`)
  check(!!def.output?.schema && typeof def.output.schema === 'object', `${def.name} 的 output.schema 是对象`)
  check(typeof def.output?.render === 'function', `${def.name} 的 output.render 是函数`)
  const blocks = def.output?.render?.({}, { ok: true, demo: 1 })
  check(Array.isArray(blocks) && blocks[0]?.type === 'text', `${def.name} 的 render 返回内容块`)
}

/* ── 路径 B：tools 晚到 ────────────────────────────────────────────── */
console.log('\n— 路径 B：apply 时 tools 服务尚未就绪，等服务事件 —')
const B = makeHost({ toolsReady: false })
const rb = plugin.apply(B.ctx, {})
check(rb.registered === 0, '首次 apply 无工具可注册（符合预期）')
check(B.tools.size === 0, '此时工具表为空')
B.emitService('tools')
check(B.tools.size === 3, `服务就绪后补注册 3 个工具（实际 ${B.tools.size}）`)

/* ── 工具真的能跑 ──────────────────────────────────────────────────── */
console.log('\n— 工具功能 —')
const call = (n, a) => A.tools.get(n).execute(a)

const probe = await call('env_probe', { timeoutMs: 8000 })
check(probe.ok === true, `env_probe 可用：${probe.summary}；管道=${probe.spawnedWithPipes}`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envkit-'))
const target = path.join(dir, 'package.json')
fs.writeFileSync(target, '\uFEFF' + JSON.stringify({ name: 'demo', dsh: { profile: { bundles: ['a'] } }, dependencies: { x: '1', y: '2' } }, null, 2), 'utf8')

const before = await call('safe_json_edit', { file: target, inspectOnly: true })
check(before.hasBom === true, '检测出 BOM')

const edited = await call('safe_json_edit', { file: target, set: { 'dsh.profile.bundles': ['a', 'b', 'c'] }, del: ['dependencies.y'] })
check(edited.ok === true && edited.bomRemoved === true, 'safe_json_edit 去掉 BOM 并成功改写')
const after = JSON.parse(fs.readFileSync(target, 'utf8'))
check(after.dsh.profile.bundles.length === 3, 'set 点路径生效')
check(!('y' in after.dependencies), 'del 点路径生效')
check(fs.readFileSync(target)[0] !== 0xEF, '写回文件无 BOM')

const gi = await call('git_repair', { repoDir: path.resolve(import.meta.dirname, '..') })
check(gi.ok === true && !!gi.inspect, `git_repair 检测仓库：state=${gi.inspect?.state}`)
check(!gi.executed?.length, 'dryRun 默认不执行命令')

const nogit = await call('git_repair', { repoDir: dir })
check(nogit.inspect.state === 'no-git', '非仓库目录返回 no-git 且不崩')

fs.rmSync(dir, { recursive: true, force: true })

console.log('')
if (failures) { console.error(`冒烟测试失败 ${failures} 项`); process.exit(1) }
console.log('冒烟测试全部通过 ✅')
