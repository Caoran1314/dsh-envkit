/**
 * dsh-envkit — 宿主半侧
 * ----------------------------------------------------------------------------
 * 注册三个工具：
 *   env_probe       一次性探明网络/TLS/代理/可写性/子进程管道能力
 *   safe_json_edit  无 BOM 安全改写 JSON（附 inspect_json 只读检查）
 *   git_repair      检测 .git 元数据缺失并给出/执行重建步骤
 *
 * 契约（见 dsh-plugin-authoring 技能）：
 *   - dsh.bundle.patch 指向 cordis.patch.yml（顶层数组）
 *   - dsh.client 与 exports["./client"] 成对出现
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from './core.mjs'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NS = 'dsh-envkit'

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version || '0.0.0' }
  catch { return '0.0.0' }
})()

/* ── 工具定义 ─────────────────────────────────────────────────────── */
/* ── 工具定义 ─────────────────────────────────────────────────────────
 * ★ 关键契约（踩坑实录）：工具必须声明 output { schema, render }，否则
 *   tools.register() 抛
 *     'tool "x" must declare output { schema, render, presentationMeta? }'
 *   而这个异常会被静默吞掉 —— 表现为"插件加载成功但工具一个都没有"。
 *   排查手段：把 register 的返回值/异常落盘（见 writeProbe）。
 * ─────────────────────────────────────────────────────────────────── */
const textBlock = (text) => [{ type: 'text', text }]

const renderText = (view) => {
  try {
    return textBlock(typeof view === 'string' ? view : JSON.stringify(view, null, 2))
  } catch { return textBlock(String(view)) }
}

export function buildTools() {
  const T = []
  const add = (name, description, properties, required, run, outputSchema) => T.push({
    name, description,
    parameters: { type: 'object', properties, required: required ?? [], additionalProperties: false },
    /* ★ 必需项：缺了会抛 'tool "x" must declare output { schema, render }'，且异常被静默吞掉 */
    output: {
      schema: outputSchema ?? { type: 'object', additionalProperties: true },
      render: (_args, value) => renderText(value)
    },
    run
  })

  add('env_probe',
    '一次性探明当前运行环境：网络端点可达性（npm/GitHub API/raw/codeload/jsDelivr/PyPI）、代理环境变量、临时目录与家目录可写性、子进程管道 spawn 是否可用。在遇到"某类操作莫名失败"时先跑它，避免误判方向。',
    {
      urls: { type: 'array', items: { type: 'string' }, description: '自定义探测端点（默认一组常见服务）' },
      timeoutMs: { type: 'number', description: '每个端点超时，默认 10000' },
      testSpawn: { type: 'boolean', description: '是否测试子进程管道 spawn（默认 true）' }
    },
    [],
    (args) => core.envProbe(args))

  add('safe_json_edit',
    '安全改写 JSON 文件：读取时容忍 BOM，写回时保证 UTF-8 无 BOM、原子替换，并默认留一份备份。用于修 profile 的 package.json（BOM 会让 dsh 命令全线 SyntaxError）。支持点路径 set/del 或 raw 函数。',
    {
      file: { type: 'string', description: '目标 JSON 文件的绝对路径' },
      set: { type: 'object', description: '点路径 → 新值，如 {"dsh.profile.bundles": ["a","b"]}' },
      del: { type: 'array', items: { type: 'string' }, description: '要删除的点路径列表' },
      backup: { type: 'boolean', description: '是否备份（默认 true）' },
      eol: { type: 'string', enum: ['lf', 'crlf'], description: '换行风格（默认沿用原文件）' },
      inspectOnly: { type: 'boolean', description: '只检查不修改' }
    },
    ['file'],
    (args) => {
      if (args.inspectOnly) return { ok: true, tool: 'inspect_json', ...core.inspectJsonFile(args.file) }
      return core.safeJsonEdit(args.file, { set: args.set, del: args.del }, { backup: args.backup, eol: args.eol })
    })

  add('git_repair',
    '检测仓库的 .git 元数据是否完整（HEAD/config/index 是否丢失），并在确认后按 init → branch → remote → fetch → reset --mixed 的顺序重建，保留工作区改动。默认 dryRun 只列命令不执行。',
    {
      repoDir: { type: 'string', description: '仓库目录绝对路径' },
      remote: { type: 'string', description: '远端地址，如 git@github.com:owner/repo.git' },
      branch: { type: 'string', description: '分支名，默认 main' },
      sshKey: { type: 'string', description: '可选：写进 core.sshCommand 的私钥路径' },
      dryRun: { type: 'boolean', description: '默认 true（只列命令）' }
    },
    ['repoDir'],
    (args) => core.gitRepair(args.repoDir, { remote: args.remote, branch: args.branch, sshKey: args.sshKey, dryRun: args.dryRun !== false }))

  return T
}

/* ── 工具注册 ─────────────────────────────────────────────────────────
 * 真实契约（从可用的 dsh-whale-market 实现里读出来的）：
 *   const toolsService = ctx.get('tools')            // 服务名就是 'tools'
 *   ctx.effect(() => toolsService.register(tool))    // 注册要包在 effect 里
 *   ctx.on('internal/service', n => { if (n === 'tools') retry() })
 *
 * 关键：apply() 跑的时候 'tools' 服务**可能还没就绪**。必须监听 internal/service
 * 重试，否则会出现"插件加载成功但一个工具都没注册"（本插件第一版就踩了这个坑，
 * last-load.json 里 tools: 0 就是证据）。
 * ─────────────────────────────────────────────────────────────────── */
function registerTools(ctx, defs, state, onCount) {
  const toolsService = (typeof ctx.get === 'function' ? ctx.get('tools') : undefined) || ctx.tools
  const diag = { hasService: !!toolsService, hasRegister: !!(toolsService && typeof toolsService.register === 'function'), attempts: [] }
  state.diag = state.diag || []
  const record = (r) => { state.diag.push({ at: new Date().toISOString(), ...diag, ...r }); if (state.diag.length > 20) state.diag.shift() }

  if (!toolsService || typeof toolsService.register !== 'function') {
    record({ outcome: 'no-service' })
    return 0
  }
  if (state.done) return defs.length

  let count = 0
  for (const def of defs) {
    const tool = {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: def.output,                       // ★ 必须带上，否则注册中心拒绝
      execute: async (args = {}) => {
        try { return await def.run(args) }
        catch (e) { return { ok: false, tool: def.name, error: String(e?.message || e) } }
      }
    }
    let effRet; let effErr = null; let directRet; let directErr = null
    /* 前置自检：output 缺失必然被注册中心拒绝，提前给出清晰错误 */
    if (!tool.output || !tool.output.schema || typeof tool.output.render !== 'function') {
      diag.attempts.push({ name: def.name, outcome: 'missing-output', hint: '必须声明 output { schema, render }' })
      continue
    }
    try {
      effRet = ctx.effect(() => toolsService.register(tool))
      count += 1
    } catch (e) {
      effErr = String(e?.message || e)
      /* 不再静默吞掉：注册失败必须留下痕迹（本插件曾因此"加载成功但 tools:0"而无任何报错） */
      try { ctx.logger?.warn?.(`[${NS}] 工具 ${def.name} 注册失败: ${effErr}`) } catch {}
      try { directRet = toolsService.register(tool); count += 1 }
      catch (e2) { directErr = String(e2?.message || e2) }
    }
    diag.attempts.push({
      name: def.name,
      effectReturn: effRet === undefined ? 'undefined' : (typeof effRet === 'function' ? 'dispose-fn' : String(effRet)),
      effectError: effErr,
      directReturn: directRet === undefined ? 'undefined' : String(directRet),
      directError: directErr
    })
  }
  /* 只有真的注册成功才置位；0 个成功时保持未完成，等待 internal/service 再试 */
  if (count > 0) state.done = true
  record({ outcome: count > 0 ? 'registered' : 'zero', count })
  try { onCount?.(count) } catch {}
  return count
}

const name = NS
/* webServer/connection：用于挂载 /envkit/* 路由。没有它们的 profile 仍可加载工具。 */
const inject = ['webServer', 'connection']

/* ── 看板/面板路由（客户端 lib/client.js 引用的端点，必须真实存在）────── */
function registerRoutes(ctx, result) {
  let count = 0
  try {
    const webServer = (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) || ctx.webServer
    const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
    if (!webServer || typeof webServer.register !== 'function') return 0

    const rejected = (req, res) => {
      try {
        if (!conn || typeof conn.requestRejection !== 'function') return false
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch { return false }
    }
    const sendJson = (res, payload, code = 200) => {
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(body.length) })
      res.end(body)
    }
    const route = (p, handler) => {
      try {
        webServer.register({ kind: 'exact', path: p, handler: async (req, res) => { if (rejected(req, res)) return; return handler(req, res) } })
        count += 1
      } catch { /* 单条路由失败不影响其他 */ }
    }

    route('/envkit/probe', async (req, res) => {
      try { sendJson(res, { ok: true, version: VERSION, result: await core.envProbe({}) }) }
      catch (e) { sendJson(res, { ok: false, error: String(e?.message || e) }, 500) }
    })

    /* 只读检查本机 profile：BOM / bundles 与 deps 是否匹配（不改任何文件） */
    route('/envkit/inspect', (req, res) => {
      const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
      const profilesDir = path.join(home, 'profiles')
      const profiles = []
      try {
        for (const dir of fs.readdirSync(profilesDir)) {
          const pj = path.join(profilesDir, dir, 'package.json')
          if (!fs.existsSync(pj)) continue
          const info = core.inspectJsonFile(pj)
          let bundles = 0; let deps = 0; let disabled = []
          if (info.parses) {
            const j = JSON.parse(fs.readFileSync(pj, 'utf8').replace(/^\uFEFF/, ''))
            const b = j?.dsh?.profile?.bundles ?? []
            const d = Object.keys(j?.dependencies ?? {})
            bundles = b.length; deps = d.length
            disabled = d.filter((n) => !b.includes(n) && !n.startsWith('@deepseek-ai/'))
          }
          profiles.push({ profile: dir, hasBom: info.hasBom, parses: info.parses, bundles, deps, installedButDisabled: disabled })
        }
      } catch (e) { /* 目录不存在 */ }
      sendJson(res, { ok: true, version: VERSION, profiles, note: '只读检查；hasBom=true 会使 dsh 命令报 SyntaxError' })
    })
  } catch { /* 路由不可用时静默降级 */ }
  return count
}

/**
 * 诊断探针：把 ctx 的真实形态落盘。
 * 背景：本插件第一版工具注册数为 0（ctx.get('tools') 拿不到），靠猜 API 反复失败。
 * 与其继续猜，不如让插件写下"它到底看到了什么"。
 *//**
 * 诊断探针：把 ctx 的真实形态与注册返回值落盘。
 * **默认关闭**，只在 DSH_ENVKIT_PROBE=1 时启用。
 * 保留它的理由：本插件第一版"加载成功但工具数为 0"且无任何报错，
 * 正是靠它一次重启就定位到 'must declare output { schema, render }'。
 */
function writeProbe(ctx, extra = {}) {
  if (process.env.DSH_ENVKIT_PROBE !== '1') return false
  try {
    const dataDir = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'envkit')
    fs.mkdirSync(dataDir, { recursive: true })

    const safeGet = (k) => {
      try {
        const v = typeof ctx.get === 'function' ? ctx.get(k) : undefined
        if (v === undefined) return { present: false }
        let members = []
        if (v && (typeof v === 'object' || typeof v === 'function')) {
          const proto = Object.getPrototypeOf(v)
          members = Object.getOwnPropertyNames(v).concat(proto ? Object.getOwnPropertyNames(proto) : [])
        }
        return { present: true, type: typeof v, members: [...new Set(members)].slice(0, 30) }
      } catch (e) { return { present: false, error: String(e?.message || e) } }
    }

    const probe = {
      at: new Date().toISOString(),
      version: VERSION,
      hasGet: typeof ctx.get === 'function',
      hasEffect: typeof ctx.effect === 'function',
      hasOn: typeof ctx.on === 'function',
      ctxOwnKeys: Object.getOwnPropertyNames(ctx).slice(0, 60),
      services: {},
      ...extra
    }
    for (const k of ['tools', 'commands', 'webServer', 'connection', 'logger', 'llm', 'slots', 'server', 'httpServer']) {
      probe.services[k] = safeGet(k)
    }
    fs.writeFileSync(path.join(dataDir, 'ctx-probe.json'), JSON.stringify(probe, null, 2), 'utf8')
    return true
  } catch { return false }
}

/** 数据目录里的加载证据：宿主半侧确实跑起来了（tools 数应为 3） */
function writeLoadMarker(tools, total) {
  try {
    const dataDir = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'envkit')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'last-load.json'), JSON.stringify({
      version: VERSION, at: new Date().toISOString(),
      tools, toolsTotal: total, node: process.version, platform: process.platform
    }, null, 2), 'utf8')
    return dataDir
  } catch { return null }
}

function apply(ctx, config = {}) {
  const defs = buildTools()
  /* 每次 apply 用独立状态：0 个注册成功时保持未完成，等 internal/service 补注册 */
  const regState = { done: false }
  const seenServices = []
  let registered = registerTools(ctx, defs, regState)

  /* 记录 apply 时刻观察到的服务状态与每次 register 的返回值/异常（诊断的关键） */
  writeProbe(ctx, { phase: 'apply', registered, seenServices, registerDiag: regState.diag })

  /* 'tools' 服务可能晚于 apply() 就绪 —— 监听到就重试注册 */
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('internal/service', (serviceName) => {
        seenServices.push({ name: String(serviceName), at: new Date().toISOString() })
        const n = registerTools(ctx, defs, regState)
        if (n && !regState.reported) {
          regState.reported = true
          registered = n
          try { ctx.logger?.info?.(`[${NS}] 服务 ${serviceName} 到达后补注册 ${n} 个工具`) } catch {}
          writeLoadMarker(registered, defs.length)
        }
        writeProbe(ctx, { phase: 'internal/service', serviceName: String(serviceName), registered, seenServices, registerDiag: regState.diag })
      })
    }
  } catch { /* 不支持该事件也不影响已有注册 */ }

  /* 兜底：有些版本在 apply 之后才注入服务，定时重试几次 */
  let tries = 0
  const timer = setInterval(() => {
    tries += 1
    const n = registerTools(ctx, defs, regState)
    if (n && !regState.reported) {
      regState.reported = true
      registered = n
      writeLoadMarker(registered, defs.length)
      writeProbe(ctx, { phase: 'timer', tries, registered, seenServices, registerDiag: regState.diag })
    }
    if (regState.done || tries >= 10) {
      clearInterval(timer)
      if (!regState.done) writeProbe(ctx, { phase: 'timer-giveup', tries, registered, seenServices, registerDiag: regState.diag })
    }
  }, 1500)
  try { if (typeof timer.unref === 'function') timer.unref() } catch {}

  /* 无 UI 的命令入口（dsh.commands 是最稳的契约） */
  const registerCommand = (n, description, run) => {
    try { if (ctx.commands?.register) { ctx.commands.register({ name: n, description, run }); return true } } catch {}
    try { if (ctx.commands?.add) { ctx.commands.add({ name: n, description, run }); return true } } catch {}
    return false
  }
  registerCommand('env-probe', '环境侦测：网络/代理/可写性/子进程', async () => {
    const r = await core.envProbe({})
    const lines = [`环境侦测（dsh-envkit v${VERSION}）`, r.summary, '', '端点:']
    for (const x of r.network) lines.push(`  ${x.ok ? '✓' : '✗'} ${x.label.padEnd(14)} ${x.status || '-'}  ${x.ms}ms  ${x.error || ''}`)
    lines.push('', `子进程管道: ${r.spawnedWithPipes}`, '', '提示:')
    for (const h of r.hints) lines.push('  · ' + h)
    return { ok: true, text: lines.join('\n') }
  })
  registerCommand('env-json-check', '检查一个 JSON 文件是否带 BOM / 能否解析', async (args = {}) => {
    const file = args.file || args._?.[0]
    if (!file) return { ok: false, text: '用法: env-json-check <file>' }
    const r = core.inspectJsonFile(file)
    return { ok: true, text: JSON.stringify(r, null, 2) }
  })
  registerCommand('env-git-check', '检查仓库 .git 元数据完整性', async (args = {}) => {
    const dir = args.dir || args._?.[0] || process.cwd()
    const r = core.gitInspect(dir)
    return { ok: true, text: JSON.stringify(r, null, 2) }
  })

  /* 数据目录：宿主半侧确实跑起来的可见证据 */
  const dataDir = writeLoadMarker(registered, defs.length)

  try {
    ctx.logger?.info?.(`[${NS}] v${VERSION} 已加载：注册 ${registered}/${defs.length} 个工具`)
  } catch {}

  const routes = registerRoutes(ctx, { registered })

  return { registered, total: defs.length, routes, dataDir, version: VERSION }
}

export { name, inject, apply, VERSION }
export default { name, inject, apply }
