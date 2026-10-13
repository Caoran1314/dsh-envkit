/**
 * 契约测试 —— 与 dsh-plugin-authoring 技能里的范式一致。
 * 这条测试的存在理由：曾经因为 exports 少写 "./client" 导致整个 DSH 启动失败。
 * 运行：node test/contract.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
const fail = (m) => { console.error('✗ ' + m); process.exit(1) }
const ok = (m) => console.log('✓ ' + m)

/* 1. bundle patch 存在且是顶层数组 */
const patch = pkg.dsh?.bundle?.patch
if (!patch) fail('缺少 dsh.bundle.patch —— 不会被当作插件层加载')
const patchPath = path.join(pkgDir, patch)
if (!fs.existsSync(patchPath)) fail(`dsh.bundle.patch 指向的文件不存在: ${patch}`)
const firstContentLine = fs.readFileSync(patchPath, 'utf8')
  .split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'))
if (!/^\s*-\s/.test(firstContentLine ?? '')) fail('patch 顶层不是 YAML 数组（首行应以 "- " 开头）')
ok(`bundle patch 合法: ${patch}`)

/* 2. patch 里 insert 的 name 可解析（本包名或宿主内置） */
const inserted = [...fs.readFileSync(patchPath, 'utf8').matchAll(/name:\s*['"]?([^'"\n]+)['"]?/g)].map((m) => m[1].trim())
for (const n of inserted) {
  if (n.startsWith('@deepseek-ai/')) continue
  const base = n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0]
  if (base !== pkg.name) fail(`patch 插入的模块既不是本包也不是宿主内置: ${n}`)
}
ok(`patch 插入模块可解析: ${inserted.join(', ')}`)

/* 3. dsh.client 与 exports["./client"] 成对（致命项） */
if (pkg.dsh?.client) {
  const clientExport = pkg.exports?.['./client']
  if (!clientExport) fail('dsh.client 已声明，但 exports 缺少 "./client" —— 会让 DSH 启动失败并清空所有插件层')
  const clientPath = path.join(pkgDir, clientExport)
  if (!fs.existsSync(clientPath)) fail(`exports["./client"] 指向的文件不存在: ${clientExport}`)
  const src = fs.readFileSync(clientPath, 'utf8')
  if (!src.includes('__ModuleLoader__')) fail('client 不是手写 ModuleLoader bundle')
  if (!src.includes(`id: '${pkg.name}'`) && !src.includes(`id: "${pkg.name}"`)) {
    fail(`client 的 ModuleLoader 注册 id 必须等于包名 ${pkg.name}`)
  }
  ok(`dsh.client 与 exports["./client"] 成对完整 (${clientExport}, id=${pkg.name})`)
} else {
  ok('未声明 dsh.client，跳过客户端校验')
}

/* 4. 客户端引用的路由必须在宿主里出现（防止面板调空接口） */
if (pkg.dsh?.client) {
  const clientSrc = fs.readFileSync(path.join(pkgDir, pkg.exports['./client']), 'utf8')
  const hostSrc = fs.readFileSync(path.join(pkgDir, pkg.main), 'utf8')
  const used = [...clientSrc.matchAll(/['"](\/[a-z0-9-]+\/[a-z0-9/-]+)['"]/gi)].map((m) => m[1])
  const missing = [...new Set(used)].filter((p) => !hostSrc.includes(`'${p}'`) && !hostSrc.includes(`"${p}"`))
  if (missing.length) fail('client 引用了宿主没有的路由: ' + missing.join(', '))
  ok(`client 引用的 ${new Set(used).size} 条路由在宿主均有实现`)
}

/* 5. 宿主导出 name/inject/apply */
const hostUrl = new URL('../' + pkg.main, import.meta.url).href
const host = await import(hostUrl)
if (typeof host.apply !== 'function') fail('宿主半侧未导出 apply 函数')
if (typeof host.name !== 'string' || host.name !== pkg.name) fail(`宿主导出的 name 应与包名一致（now: ${host.name}）`)
if (!Array.isArray(host.inject)) fail('宿主半侧未导出 inject 数组')
ok(`宿主导出完整: name=${host.name} inject=[${host.inject.join(',')}]`)

console.log('\n契约测试全部通过 ✅')
