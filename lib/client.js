/**
 * dsh-envkit — 浏览器半侧：设置页「环境工具」面板
 * ----------------------------------------------------------------------------
 * 手写 ModuleLoader bundle（无需构建）。注册 id 必须等于包名 dsh-envkit。
 * 数据全部来自宿主半侧的路由 /envkit/*，面板本身不做判断。
 */
window.__ModuleLoader__.load({
  id: 'dsh-envkit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var CSS = [
      '.ek_root{max-width:700px;display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.ek_row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
      '.ek_title{font-size:14px;font-weight:700}',
      '.ek_ver{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.ek_hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.ek_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:11px 13px}',
      '.ek_sect{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}',
      '.ek_list{display:flex;flex-direction:column;gap:5px;font-family:ui-monospace,Consolas,monospace;font-size:11.5px}',
      '.ek_item{display:flex;gap:8px;align-items:baseline}',
      '.ek_ok{color:#3fbf6f}.ek_bad{color:#ff5c5c}',
      '.ek_label{min-width:120px;color:var(--dsw-alias-label-secondary)}',
      '.ek_ms{color:var(--dsw-alias-label-tertiary);margin-left:auto}',
      '.ek_err{color:#ff5c5c;font-size:11px}',
      '.ek_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.ek_btn:hover{border-color:var(--dsw-alias-state-business-primary)}',
      '.ek_pre{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap}'
    ].join('')

    function ensureCss() {
      if (document.getElementById('ek_panel_css')) return
      var s = document.createElement('style')
      s.id = 'ek_panel_css'
      s.textContent = CSS
      document.head.appendChild(s)
    }

    function Panel() {
      ensureCss()
      var [data, setData] = react.useState(null)
      var [msg, setMsg] = react.useState('')
      var [raw, setRaw] = react.useState('')

      function load() {
        setMsg('侦测中…')
        fetch('/envkit/probe', { credentials: 'same-origin' })
          .then(function (r) { return r.json() })
          .then(function (j) { setData(j.result || j); setMsg('') })
          .catch(function (e) { setMsg('侦测失败：' + String(e && e.message || e)) })
      }

      react.useEffect(function () { load() }, [])

      if (!data) return h('div', { className: 'ek_root' }, h('div', { className: 'ek_hint' }, msg || '载入中…'))

      return h('div', { className: 'ek_root' },
        h('div', { className: 'ek_row' },
          h('div', { className: 'ek_title' }, '环境工具'),
          h('span', { className: 'ek_ver' }, 'dsh-envkit · ' + (data.summary || '')),
          h('span', { className: 'ek_ver' }, data.platform + ' · node ' + data.node)
        ),
        h('div', { className: 'ek_hint' },
          '在遇到「某类操作莫名失败」时先看这里：能省掉大量误判。工具：' +
          'env_probe（环境侦测）、safe_json_edit（无 BOM 改 JSON）、git_repair（.git 元数据重建）。'),

        h('div', { className: 'ek_card' },
          h('div', { className: 'ek_sect' }, '网络端点'),
          h('div', { className: 'ek_list' }, (data.network || []).map(function (n, i) {
            return h('div', { key: i, className: 'ek_item' },
              h('span', { className: n.ok ? 'ek_ok' : 'ek_bad' }, n.ok ? '✓' : '✗'),
              h('span', { className: 'ek_label' }, n.label),
              h('span', null, String(n.status || '-')),
              h('span', { className: 'ek_ms' }, n.ms + 'ms'),
              n.error ? h('span', { className: 'ek_err' }, n.error.slice(0, 60)) : null
            )
          }))
        ),

        h('div', { className: 'ek_card' },
          h('div', { className: 'ek_sect' }, '运行环境'),
          h('div', { className: 'ek_list' },
            h('div', { className: 'ek_item' }, h('span', { className: 'ek_label' }, '子进程管道'), h('span', { className: data.spawnedWithPipes === '可用' ? 'ek_ok' : 'ek_bad' }, data.spawnedWithPipes || '-')),
            Object.keys(data.writable || {}).map(function (k) {
              var w = data.writable[k]
              return h('div', { key: k, className: 'ek_item' },
                h('span', { className: w.writable ? 'ek_ok' : 'ek_bad' }, w.writable ? '✓' : '✗'),
                h('span', { className: 'ek_label' }, k + ' 可写'),
                h('span', null, w.path)
              )
            }),
            data.proxyEnv ? h('div', { className: 'ek_item' }, h('span', { className: 'ek_label' }, '代理变量'), h('span', null, Object.keys(data.proxyEnv).join(', '))) : null
          )
        ),

        (data.hints && data.hints.length) ? h('div', { className: 'ek_card' },
          h('div', { className: 'ek_sect' }, '提示'),
          h('div', { className: 'ek_list' }, data.hints.map(function (t, i) { return h('div', { key: i }, '· ' + t) }))
        ) : null,

        h('div', { className: 'ek_row' },
          h('button', { className: 'ek_btn', onClick: load }, '重新侦测'),
          h('button', { className: 'ek_btn', onClick: function () {
            fetch('/envkit/inspect', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'profiles' }) })
              .then(function (r) { return r.json() })
              .then(function (j) { setRaw(JSON.stringify(j, null, 2)) })
              .catch(function (e) { setMsg('检查失败：' + String(e && e.message || e)) })
          } }, '检查我的 profile（BOM/bundles）'),
          msg ? h('span', { className: 'ek_hint' }, msg) : null
        ),

        raw ? h('div', { className: 'ek_pre' }, raw) : null
      )
    }

    var inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'envkit', order: 29, label: '环境工具' },
          function () { return h(Panel, {}) }
        )
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
