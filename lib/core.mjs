/**
 * dsh-envkit — 环境侦测与安全修复工具（核心逻辑，零依赖）
 * ----------------------------------------------------------------------------
 * 存在的理由：某些环境（受限沙箱、被劫持的 DNS、缺 TLS 凭据）会让一整类操作
 * 神秘失败，而失败信息往往指向错误的方向。这三个工具把"先探明环境再动手"固化下来。
 *
 *   env_probe       一次性探明 网络/TLS/代理/命名管道/文件权限
 *   safe_json_edit  无 BOM 安全改写 JSON（DSH profile 的头号杀手是 BOM）
 *   git_repair      检测 .git 元数据缺失并给出/执行重建步骤
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/* ── env_probe：网络与环境能力侦测 ─────────────────────────────────── */
export const DEFAULT_PROBE_URLS = [
  ['npm registry', 'https://registry.npmjs.org/-/ping'],
  ['GitHub API', 'https://api.github.com/rate_limit'],
  ['GitHub raw', 'https://raw.githubusercontent.com/'],
  ['codeload', 'https://codeload.github.com/'],
  ['jsDelivr', 'https://data.jsdelivr.com/v1/package/npm/react'],
  ['PyPI', 'https://pypi.org/simple/']
]

export async function envProbe(opts = {}) {
  const timeout = Number(opts.timeoutMs) || 10000
  const urls = Array.isArray(opts.urls) && opts.urls.length
    ? opts.urls.map((u) => (Array.isArray(u) ? u : [String(u), String(u)]))
    : DEFAULT_PROBE_URLS

  const results = await Promise.all(urls.map(async ([label, url]) => {
    const t0 = Date.now()
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'dsh-envkit' }, signal: AbortSignal.timeout(timeout) })
      await r.arrayBuffer().catch(() => {})
      return { label, url, ok: r.ok, status: r.status, ms: Date.now() - t0 }
    } catch (e) {
      return { label, url, ok: false, status: 0, ms: Date.now() - t0, error: String(e?.cause?.message || e?.message || e) }
    }
  }))

  const proxyEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => /^(https?|all|no)_proxy$/i.test(k))
  )

  const writable = {}
  for (const [k, p] of Object.entries({
    tmp: os.tmpdir(),
    home: os.homedir(),
    cwd: process.cwd()
  })) {
    try {
      fs.mkdirSync(p, { recursive: true })
      const probe = path.join(p, `.envkit-probe-${process.pid}-${Date.now()}`)
      fs.writeFileSync(probe, 'x')
      fs.unlinkSync(probe)
      writable[k] = { path: p, writable: true }
    } catch (e) {
      writable[k] = { path: p, writable: false, error: String(e?.message || e) }
    }
  }

  /* 命名管道受限的探针：Node 在受限环境下 spawn(stdio:'pipe') 会 EPERM */
  let pipeSpawn = '未测试'
  if (opts.testSpawn !== false) {
    try {
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
        encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe']
      })
      pipeSpawn = r.error ? `失败: ${r.error.code || r.error.message}` : (r.status === 0 ? '可用' : `退出码 ${r.status}`)
    } catch (e) {
      pipeSpawn = `失败: ${String(e?.message || e)}`
    }
  }

  const reachable = results.filter((r) => r.ok).length
  return {
    ok: true,
    tool: 'env_probe',
    summary: `${reachable}/${results.length} 个端点可达`,
    network: results,
    proxyEnv: Object.keys(proxyEnv).length ? proxyEnv : null,
    writable,
    spawnedWithPipes: pipeSpawn,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    hints: buildHints(results, pipeSpawn)
  }
}

function buildHints(results, pipeSpawn) {
  const hints = []
  const byLabel = Object.fromEntries(results.map((r) => [r.label, r]))
  if (byLabel['npm registry'] && !byLabel['npm registry'].ok) {
    hints.push('npm registry 不可达：npm/pnpm 安装会失败；若已开代理，检查 HTTP(S)_PROXY 是否被放进环境变量')
  }
  if (byLabel['GitHub API'] && !byLabel['GitHub API'].ok && byLabel['codeload']?.ok) {
    hints.push('GitHub API 不可达但 codeload 可用：改用 codeload tarball 抓源码，避免走 API（匿名 API 仅 60 次/小时）')
  }
  if (pipeSpawn !== '可用' && pipeSpawn !== '未测试') {
    hints.push(`子进程管道 spawn ${pipeSpawn}：Node 的 child_process 捕获输出可能失败；考虑 stdio:'inherit'/'ignore'，或对需要它的一步申请更宽的沙箱权限`)
  }
  if (!hints.length) hints.push('未发现明显环境异常')
  return hints
}

/* ── safe_json_edit：无 BOM 安全改写 JSON ──────────────────────────── */
export function inspectJsonFile(file) {
  const out = { file, exists: false }
  try {
    const buf = fs.readFileSync(file)
    out.exists = true
    out.bytes = buf.length
    out.hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
    out.encoding = 'utf8'
    const text = buf.toString('utf8')
    try {
      const obj = JSON.parse(out.hasBom ? text.replace(/^\uFEFF/, '') : text)
      out.parses = true
      out.topLevelKeys = Object.keys(obj)
      out.indent = detectIndent(text)
      out.eol = text.includes('\r\n') ? 'crlf' : 'lf'
    } catch (e) {
      out.parses = false
      out.parseError = String(e?.message || e)
    }
  } catch (e) {
    out.error = String(e?.message || e)
  }
  return out
}

function detectIndent(text) {
  const m = /\n(\s+)"/.exec(text)
  return m ? m[1].length : 2
}

/**
 * 改 JSON：读（容忍 BOM）→ 应用改动 → **无 BOM、原子** 写回。
 * op 形如 { set?: {path: value}, del?: [path], raw?: (obj)=>obj }
 */
export function safeJsonEdit(file, op = {}, opts = {}) {
  const before = inspectJsonFile(file)
  if (!before.exists) return { ok: false, tool: 'safe_json_edit', error: `文件不存在: ${file}` }
  if (before.parses === false) {
    return { ok: false, tool: 'safe_json_edit', error: `JSON 解析失败: ${before.parseError}`, inspect: before }
  }

  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  let obj
  try { obj = JSON.parse(text) } catch (e) {
    return { ok: false, tool: 'safe_json_edit', error: `JSON 解析失败: ${e.message}` }
  }

  if (opts.backup !== false) {
    const bak = `${file}.envkit-backup-${Date.now()}`
    try { fs.copyFileSync(file, bak); } catch { /* 备份失败不阻断 */ }
  }

  if (typeof op.raw === 'function') obj = op.raw(obj) ?? obj
  for (const [p, v] of Object.entries(op.set ?? {})) setPath(obj, p, v)
  for (const p of op.del ?? []) delPath(obj, p)

  const indent = opts.indent ?? before.indent ?? 2
  const eol = opts.eol ?? before.eol ?? 'lf'
  let out = JSON.stringify(obj, null, indent) + '\n'
  if (eol === 'crlf') out = out.replace(/\n/g, '\r\n')

  const tmp = `${file}.envkit-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, out, 'utf8')          // node 写 utf8 = 无 BOM
  fs.renameSync(tmp, file)

  const after = inspectJsonFile(file)
  return {
    ok: true, tool: 'safe_json_edit', file,
    hadBom: before.hasBom, bomRemoved: before.hasBom === true && after.hasBom === false,
    bytesBefore: before.bytes, bytesAfter: after.bytes,
    parses: after.parses, topLevelKeys: after.topLevelKeys
  }
}

function setPath(obj, dotPath, value) {
  const parts = String(dotPath).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i]
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

function delPath(obj, dotPath) {
  const parts = String(dotPath).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = cur?.[parts[i]]
    if (!cur || typeof cur !== 'object') return
  }
  delete cur[parts[parts.length - 1]]
}

/* ── git_repair：.git 元数据缺失检测与重建 ─────────────────────────── */
const GIT_ESSENTIALS = ['HEAD', 'config']

export function gitInspect(repoDir) {
  const gitDir = path.join(repoDir, '.git')
  const out = { ok: true, tool: 'git_repair', repoDir, gitDir, exists: fs.existsSync(gitDir) }
  if (!out.exists) {
    out.state = 'no-git'
    out.note = '不是 git 仓库；如需发布可先 git init'
    return out
  }
  const entries = fs.readdirSync(gitDir)
  out.entries = entries
  out.missingEssentials = GIT_ESSENTIALS.filter((f) => !entries.includes(f))
  out.hasObjects = entries.includes('objects')
  out.hasRefs = entries.includes('refs')

  let heads = []
  try {
    heads = fs.readdirSync(path.join(gitDir, 'refs', 'heads')).map((f) => {
      const sha = fs.readFileSync(path.join(gitDir, 'refs', 'heads', f), 'utf8').trim()
      return { branch: f, sha }
    })
  } catch { /* 无本地分支 */ }

  out.heads = heads
  if (out.missingEssentials.length === 0) out.state = 'healthy'
  else if (out.hasObjects && heads.length) out.state = 'metadata-lost-objects-intact'
  else out.state = 'damaged'
  return out
}

/**
 * 重建被删了 HEAD/config/index 的仓库。
 * 不做任何破坏性操作：只 init / remote / fetch / reset --mixed。
 */
export function gitRepair(repoDir, { remote, branch = 'main', sshKey, dryRun = true } = {}) {
  const inspect = gitInspect(repoDir)
  const steps = []
  const push = (s) => steps.push(s)

  push(`git -C "${repoDir}" init -q`)
  push(`git -C "${repoDir}" branch -M ${branch}`)
  if (remote) {
    push(`git -C "${repoDir}" remote add origin ${remote}`)
    push(`git -C "${repoDir}" fetch origin`)
    push(`git -C "${repoDir}" reset --mixed origin/${branch}   # 保留工作区改动`)
  }
  if (sshKey) {
    push(`git -C "${repoDir}" config core.sshCommand "ssh -i ${sshKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`)
  }

  const result = { ok: true, tool: 'git_repair', inspect, steps, executed: [] }
  if (dryRun) {
    result.note = 'dryRun：以上命令未执行。确认后传 dryRun:false 执行。'
    return result
  }
  for (const cmd of steps) {
    const isWin = process.platform === 'win32'
    const r = isWin ? spawnSync('cmd.exe', ['/c', cmd], { encoding: 'utf8', timeout: 120000 })
      : spawnSync('sh', ['-c', cmd], { encoding: 'utf8', timeout: 120000 })
    const code = r.status ?? -1
    result.executed.push({ cmd, code, out: String(r.stdout || '').trim().slice(0, 300), err: String(r.stderr || '').trim().slice(0, 300) })
    if (code !== 0 && !cmd.includes('remote add')) {
      result.ok = false
      result.failedAt = cmd
      break
    }
  }
  result.after = gitInspect(repoDir)
  return result
}

export const TOOLS = { env_probe: envProbe, safe_json_edit: safeJsonEdit, git_repair: gitRepair, inspect_json: inspectJsonFile }
