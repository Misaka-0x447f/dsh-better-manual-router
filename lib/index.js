import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

// ============================================================================
// dsh-better-manual-router —— OpenRouter 实时方案驱动的小字块
// （v0.2.0 起只跟踪 deepseek/deepseek-v4.1-flash 单模型）
//
// 每 5 分钟抓一次 OpenRouter（host 缓存节流），单行，锚定在侧边栏“设置”按钮
// 的正上方。
//
// 数据源（固定 1W、匿名）：
//   GET /api/frontend/v1/stats/listed-pricing?permaslug=<canonical>&range=1w&shape=v5
//   permaslug 必须用带日期后缀的 canonical 形式；简写 slug 会返回空 series。
// 单行内容：
//   [文字 峰/谷] [图标] [HH:MM 倒计时到下一切换点] [(x 分钟前)]
//
// 文字（只看 DeepSeek 自身时刻表，不再叠加“是否最优价”维度）：
//   时刻表高(峰) → 梁文峰 ；时刻表低(谷) → 梁文谷
// 图标（只看谁当前最便宜，与文字相互独立）：
//   最优 provider == DeepSeek → 鲸鱼 ；否则 → 路由器
// 倒计时：距该行下一次“文字或图标变化”的时间。
//
// 时间编码：schedule.windows[].utcStart/utcEnd 为 hours*100+minutes（非分钟数），
//   且是 UTC 墙钟时间；前端 s() 用 floor(e/100) 取小时、e%100 取分钟。
//   DeepSeek 峰时窗口 100-400 / 600-1000 = UTC 01:00-04:00 / 06:00-10:00
//   = 北京 09:00-12:00 / 14:00-18:00（与官方公告一致）。
// 价格语义：schedule.input 与 series.input 均已是折后现价（$ / 1M tokens），
//   discount 仅用于反推原价展示（prompt / (1-discount)），不要再乘 (1-discount)。
//   每个 provider 各自用其 schedule 求“当前生效价”，无 schedule 的用 series 末值。
//
// 4.1-flash 的成本格局（$/1M input，2026-09-11 实测）：
//   DeepSeek 谷 $0.15 / 峰 $0.30 ；DeepInfra $0.20 ；Fireworks $0.22 ；其余 6 家 $0.30。
//   因此：谷时 DeepSeek 最优 → 鲸鱼；峰时 DeepInfra 最优 → 路由器。
//   注意只有 DeepSeek 一家带 schedule，其余全为固定价，故本模型只会出现
//   “梁文峰 / 梁文谷”两态，梁文尖、梁文平不会出现（旧四态规则见文末历史留档）。
// ============================================================================

// 当前只跟踪 4.1-flash 一个模型（单行）。
// permaslug 必须是 canonical 形式；deepseek/deepseek-v4.1-flash 这种简写查不到数据。
const MODELS = [
  { permaslug: 'deepseek/deepseek-v4.1-flash-20260910' },
]
const listedUrl = (permaslug) =>
  `https://openrouter.ai/api/frontend/v1/stats/listed-pricing?permaslug=${encodeURIComponent(permaslug)}&range=1w&shape=v5&variant=standard`
const POLL_MS = 5 * 60 * 1000

// —— 浏览器侧 widget 源码（host 端作为 JS 内容服务并注入页面）——
const WIDGET_JS = `(function () {
  if (window.__dshBetterManualRouter) return
  window.__dshBetterManualRouter = true

  var ICONS = {
    whale: '<img src="/dsh-better-manual-router/deepseek.png" width="16" height="16" alt="" style="display:block;width:16px;height:16px">',
    router: '<img src="/dsh-better-manual-router/openrouter.png" width="16" height="16" alt="" style="display:block;width:16px;height:16px">'
  }

  var css = [
    '.dpw-root{font-size:13px;line-height:1.2;color:rgba(148,163,184,.72);font-family:inherit;pointer-events:none;user-select:none;-webkit-user-select:none;white-space:nowrap;display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:left;margin-bottom:6px;margin-left:6px}',
    '.dpw-row{display:flex;align-items:center;gap:5px;justify-content:flex-start}',
    '.dpw-row .dpw-ic img{display:block;opacity:.9;width:16px;height:16px;margin-top:1px}',
    '.dpw-row .dpw-cd{font-variant-numeric:tabular-nums;opacity:.85;margin-left:1px}',
    '.dpw-age-line{opacity:.6;font-size:12px}',
    '.dpw-root.dpw-blinking{animation:dpw-blink 1s linear infinite}',
    '@keyframes dpw-blink{0%,100%{opacity:.25}50%{opacity:.9}}'
  ].join('\\n')

  var styleEl = document.createElement('style')
  styleEl.textContent = css
  document.head.appendChild(styleEl)

  var root = document.createElement('div')
  root.className = 'dpw-root'
  root.style.display = 'none'
  document.body.appendChild(root)

  var rows = []        // [{label,icon,nextTs,ts}]
  var lastSig = ''     // 上一次的 "label|icon" 组合签名，用于检测切换并闪烁
  var blinkTimer = null
  var everLoaded = false

  function pad(n) { return (n < 10 ? '0' : '') + n }
  function fmtCD(ms) {
    if (!ms || ms <= 0) return '00:00'
    return pad(Math.floor(ms / 3600000)) + ':' + pad(Math.floor((ms % 3600000) / 60000))
  }
  function overallAgeHtml() {
    if (!rows.length) return ''
    var maxM = 0
    for (var i = 0; i < rows.length; i++) {
      var m = Math.floor((Date.now() - rows[i].ts) / 60000)
      if (m > maxM) maxM = m
    }
    if (maxM <= 15) return ''
    return '<div class="dpw-age-line">(' + maxM + ' 分钟前)</div>'
  }

  function startBlink() {
    if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null }
    root.classList.add('dpw-blinking')
    blinkTimer = setTimeout(function () {
      blinkTimer = null
      root.classList.remove('dpw-blinking')
    }, 5000)
  }

  function rowHtml(e) {
    var icon = ICONS[e.icon] || ''
    var cd = e.nextTs ? fmtCD(e.nextTs - Date.now()) : ''
    return '<div class="dpw-row">' +
      '<span>' + e.label + '</span>' +
      (icon ? '<span class="dpw-ic">' + icon + '</span>' : '') +
      (cd ? '<span class="dpw-cd">' + cd + '</span>' : '') +
      '</div>'
  }

  function render() {
    if (!rows.length) {
      if (!everLoaded) { root.textContent = '连线中…' }
      realign()
      return
    }
    var sig = rows.map(function (e) { return e.label + '|' + e.icon }).join(';')
    var changed = !!lastSig && lastSig !== sig
    lastSig = sig
    root.innerHTML = rows.map(rowHtml).join('') + overallAgeHtml()
    if (changed) startBlink()
    realign()
  }

  function poll() {
    fetch('/dsh-better-manual-router/prices')
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (j && j.ok && Array.isArray(j.rows) && j.rows.length) {
          rows = j.rows
          everLoaded = true
        }
        render()
      })
      .catch(function () { render() })
  }

  // 锚定：attach 为侧边栏设置区内部第一个子元素，始终显示在“设置”按钮上方
  function realign() {
    var area = document.querySelector('[class*="_settingsArea"]')
    if (!area) { root.style.display = 'none'; return }
    if (area.firstElementChild !== root) {
      area.insertBefore(root, area.firstElementChild)
    }
    root.style.display = ''
  }

  poll()
  realign()
  setInterval(function () { poll(); realign() }, 5 * 60 * 1000)
  setInterval(function () { if (rows.length) render() }, 1000) // 倒计时每秒刷新
})()`

// ============================================================================
// host 侧：拉取 + 缓存 + 计算
// ============================================================================
let cache = { ts: 0, data: null }

function lastVal(series) {
  const pts = (series || []).filter((p) => p && typeof p === 'object' && 'value' in p)
  if (!pts.length) return null
  pts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  return pts[pts.length - 1].value
}
// utcStart/utcEnd 编码为 hours*100 + minutes（前端 s() 用 floor(e/100) 取小时、e%100 取分钟）
function decodeT(v) {
  const h = Math.floor(v / 100)
  const m = v % 100
  return h * 60 + m
}
function normEnd(end) {
  const e = decodeT(end)
  return e === 0 ? 1440 : e
}

function winFor(win, dayNum, minutes) {
  if (win.utcDays && !win.utcDays.includes(dayNum)) return null
  const start = decodeT(win.utcStart)
  const end = normEnd(win.utcEnd)
  if (start <= minutes && minutes < end) return win
  return null
}
function stateAt(d, windows, peakPrice) {
  const dayNum = d.getUTCDay()
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes()
  for (const w of windows) {
    if (winFor(w, dayNum, minutes)) return w.input === peakPrice ? 'peak' : 'off'
  }
  return 'off'
}
// 计算某个时刻的完整状态（DeepSeek 峰/谷 + 谁当前最优）
function evalState(series, nowMs) {
  const now = new Date(nowMs)
  const ds = series.find((e) => e.providerSlug === 'deepseek')
  if (!ds) return null
  const sched = (ds.schedule || []).filter((s) => Array.isArray(s.windows) && s.windows.length)
  sched.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const windows = sched.length ? sched[sched.length - 1].windows : []
  if (!windows.length) return null
  const peakPrice = Math.max(...windows.map((w) => w.input))
  const isPeak = stateAt(now, windows, peakPrice) === 'peak'

  let best = null
  for (const e of series) {
    const price = providerPrice(e, now)
    if (price == null || !isFinite(price) || price < 0) continue
    // 同价时优先 DeepSeek
    if (!best ||
        price < best.price ||
        (price === best.price && best.prov !== 'deepseek' && e.providerSlug === 'deepseek')) {
      best = { prov: e.providerSlug, price }
    }
  }
  if (!best) return null
  const isDsOptimal = best.prov === 'deepseek'
  // 文字只看 DeepSeek 自身峰谷，不再叠加“是否最优”维度；是否最优由 icon 表达。
  // （旧版四态命名 梁文尖/梁文峰/梁文平/梁文谷 见文件末尾「历史实现留档」。）
  const label = isPeak ? '梁文峰' : '梁文谷'
  return { isPeak, isDsOptimal, bestProv: best.prov, bestPerM: best.price, label, icon: isDsOptimal ? 'whale' : 'router' }
}

// —— 当前版本定时器（v0.2.0）：只看 DeepSeek 自身峰谷边界 ——
// 只跟 4.1-flash 后，带 schedule 的 provider 只剩 DeepSeek 一家（其余均为固定价），
// 因此“下一次显示变化”必然落在 DeepSeek 的峰谷窗口边界上。
// 旧版“合并所有 provider 边界”的完整规则见文件末尾「历史实现留档」。
function deepseekBoundaries(series) {
  const set = new Set([0, 1440])
  const ds = series.find((e) => e.providerSlug === 'deepseek')
  const sched = ((ds && ds.schedule) || []).filter((s) => Array.isArray(s.windows) && s.windows.length)
  if (sched.length) {
    sched.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    for (const w of sched[sched.length - 1].windows) {
      set.add(decodeT(w.utcStart))
      set.add(normEnd(w.utcEnd))
    }
  }
  return [...set].sort((a, b) => a - b)
}

// 距下一次“文字或图标变化”的时间（两者取先到者）
function nextChange(series, nowMs, cur) {
  if (!cur) return null
  const bounds = deepseekBoundaries(series)
  const now = new Date(nowMs)
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const cand = []
  for (let d = 0; d <= 7; d++) {
    for (const m of bounds) {
      const t = base + d * 86400000 + m * 60000
      if (t > nowMs + 1000) cand.push(t)
    }
  }
  cand.sort((a, b) => a - b)
  for (const t of cand) {
    const st = evalState(series, t)
    if (st && (st.label !== cur.label || st.icon !== cur.icon)) return t
  }
  return null
}

// 单 provider 当前生效价（$/M；schedule.input 与 series.input 均已含折扣，无需再乘）
function providerPrice(e, now) {
  const sched = (e.schedule || []).filter((s) => Array.isArray(s.windows) && s.windows.length)
  if (sched.length) {
    sched.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    const windows = sched[sched.length - 1].windows
    const dayNum = now.getUTCDay()
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
    for (const w of windows) {
      if (w.utcDays && !w.utcDays.includes(dayNum)) continue
      const start = decodeT(w.utcStart)
      const end = normEnd(w.utcEnd)
      if (start <= minutes && minutes < end) return w.input
    }
    return null
  }
  return lastVal(e.input)
}

// 单模型状态（json 为 listed-pricing 响应）
function computeState(json, nowMs) {
  const series = (json && json.data && json.data.series) || []
  const cur = evalState(series, nowMs)
  if (!cur) return { ok: false }
  const nextTs = nextChange(series, nowMs, cur)
  return {
    ok: true,
    label: cur.label,
    icon: cur.icon,
    nextTs,
    bestPerM: Math.round(cur.bestPerM * 100) / 100,
    ts: nowMs,
  }
}

async function fetchOpenRouter() {
  const now = Date.now()
  const results = await Promise.all(MODELS.map(async (m) => {
    const res = await fetch(listedUrl(m.permaslug), { headers: { 'User-Agent': 'dsh-better-manual-router' } })
    if (!res.ok) throw new Error('openrouter ' + res.status)
    const json = await res.json()
    const st = computeState(json, now)
    return st.ok ? st : null
  }))
  const rows = results.filter(Boolean)
  return rows.length ? { ok: true, rows } : { ok: false }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ASSETS = {}
try {
  ASSETS.deepseek = fs.readFileSync(path.join(__dirname, 'deepseek.png'))
  ASSETS.openrouter = fs.readFileSync(path.join(__dirname, 'openrouter.png'))
} catch (err) {}

const name = 'dsh-better-manual-router'
const inject = ['webServer']

function apply(ctx) {
  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-better-manual-router/widget.js',
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(WIDGET_JS)
    },
  }))

  for (const [file, route] of [['deepseek', '/dsh-better-manual-router/deepseek.png'], ['openrouter', '/dsh-better-manual-router/openrouter.png']]) {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: route,
      handler: (req, res) => {
        if (!ASSETS[file]) { res.writeHead(404); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' })
        res.end(ASSETS[file])
      },
    }))
  }

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-better-manual-router/prices',
    handler: async (req, res) => {
      const now = Date.now()
      if (!cache.data || now - cache.ts >= POLL_MS) {
        try {
          cache.data = await fetchOpenRouter()
          if (cache.data.ok) cache.ts = now
        } catch (err) {
          // 失败保留旧缓存；若从未成功则 ok:false
        }
      }
      const payload = cache.data && cache.data.ok ? cache.data : { ok: false }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    },
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-better-manual-router/widget.js') !== -1) return html
    const tag = '<script defer src="/dsh-better-manual-router/widget.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}

export { name, inject, apply }

// ============================================================================
// 【历史实现留档 · v0.1.x 多模型时代（pro + exp 双行）】—— 当前版本未启用
//
// 一、旧版四态命名规则
//   v0.1.x 的文字同时表达两个维度（DeepSeek 自身峰谷 × DeepSeek 是否当前最优价）：
//     峰 + DeepSeek 最优   → 梁文尖
//     峰 + DeepSeek 非最优 → 梁文峰
//     谷 + DeepSeek 最优   → 梁文平
//     谷 + DeepSeek 非最优 → 梁文谷
//   图标规则与现在相同：最优 provider == DeepSeek → 鲸鱼，否则 → 路由器。
//   v0.2.0 起文字砍成两态（峰 → 梁文峰 / 谷 → 梁文谷），“谁最优”完全交给图标。
//
// 二、旧版定时器规则（“合并所有 provider 的边界”）
//   动机案例：旧 pro 模型的供应商里，Alibaba 自带一套 schedule
//     （UTC 0-1400 = $1.122 / 1400-0 = $0.5808，即北京 22:00 起降价）。
//     DeepSeek 自身谷价 $0.66 时，Alibaba 一过 22:00 降到 $0.5808，
//     “最优 provider”就从 DeepSeek 变成 Alibaba，文字与图标都要跟着变。
//     若倒计时只看 DeepSeek 自己的峰谷边界，就会漏掉这个点
//     （实测 21:14 曾显示 11:43，正确值应是约 46 分钟后到 22:00）。
//   规则：把列表里【每个】provider 的 schedule 边界收集起来，逐个时刻试算 evalState，
//     取第一个会让状态（label）改变的时刻。
//
//   旧版实现（原样留档，重新启用时可直接恢复）：
//
//   // 收集所有会改变“最优价”的窗口边界（分钟-of-day），含 DeepSeek 峰谷边界
//   function allBoundaries(series) {
//     const set = new Set([0, 1440])
//     for (const e of series) {
//       const sched = (e.schedule || []).filter((s) => Array.isArray(s.windows) && s.windows.length)
//       if (!sched.length) continue
//       sched.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
//       for (const w of sched[sched.length - 1].windows) {
//         set.add(decodeT(w.utcStart))
//         set.add(normEnd(w.utcEnd))
//       }
//     }
//     return [...set].sort((a, b) => a - b)
//   }
//
//   // 距下一次“文字（label）变化”的时间
//   function nextChange(series, nowMs, cur) {
//     if (!cur) return null
//     const bounds = allBoundaries(series)
//     const now = new Date(nowMs)
//     const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
//     const cand = []
//     for (let d = 0; d <= 7; d++) {
//       for (const m of bounds) {
//         const t = base + d * 86400000 + m * 60000
//         if (t > nowMs + 1000) cand.push(t)
//       }
//     }
//     cand.sort((a, b) => a - b)
//     for (const t of cand) {
//       const st = evalState(series, t)
//       if (st && st.label !== cur.label) return t
//     }
//     return null
//   }
//
// 三、何时重新启用
//   跟踪列表里再次出现“带 schedule 的非 DeepSeek provider”时：
//   例如把 pro / exp 加回 MODELS，或 DeepInfra / Fireworks 之类开始分时段定价。
//   届时恢复上面的 allBoundaries 为现行函数，并让 nextChange 同时比较 label 与 icon。
// ============================================================================
