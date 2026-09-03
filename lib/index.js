import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

// ============================================================================
// dsh-better-manual-router —— OpenRouter 实时方案驱动的两行小字块（pro / exp）
//
// 每 5 分钟抓一次 OpenRouter（host 缓存节流），每个模型一行，锚定在侧边栏
// “设置”按钮的正上方。
//
// 数据源（固定 1W、匿名）：
//   GET /api/frontend/v1/stats/listed-pricing?permaslug=<canonical>&range=1w&shape=v5
// 每行内容：
//   [pro/exp 标签] [文字 峰/平/谷/尖] [图标] [HH:MM 倒计时到下一切换点] [(x 分钟前)]
//
// 文字（由“DeepSeek 自身时刻表 高/低” × “DeepSeek 是否当前最优价”决定）：
//   时刻表高(峰):  最优价=梁文尖 / 非最优=梁文峰
//   时刻表低(谷):  最优价=梁文平 / 非最优=梁文谷
// 图标（只看谁是最优价，与文字无关）：
//   最优 provider == DeepSeek → 鲸鱼 ；否则 → 路由器
// 倒计时：距该模型下一次“峰↔谷”切换的时间。
//
// 时间编码：schedule.windows[].utcStart/utcEnd 为 hours*100+minutes（非分钟数），
//   且是 UTC 墙钟时间；前端 s() 用 floor(e/100) 取小时、e%100 取分钟。
//   DeepSeek 峰时窗口 100-400 / 600-1000 = UTC 01:00-04:00 / 06:00-10:00
//   = 北京 09:00-12:00 / 14:00-18:00（与官方公告一致）。
// 价格语义：schedule.input 与 series.input 均已是折后现价（$ / 1M tokens），
//   discount 仅用于反推原价展示（prompt / (1-discount)），不要再乘 (1-discount)。
//   每个 provider 各自用其 schedule 求“当前生效价”，无 schedule 的用 series 末值。
// ============================================================================

const MODELS = [
  { tag: 'pro', permaslug: 'deepseek/deepseek-v4-pro-20260813' },
  { tag: 'exp', permaslug: 'deepseek/deepseek-v4-flash-vision-exp-20260821' },
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
    '.dpw-row .dpw-tag{font-size:11px;line-height:1;opacity:.75}',
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

  var rows = []        // [{tag,label,icon,nextTs,ts}]
  var lastLabels = {}  // tag -> label，用于闪烁检测
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
      '<span class="dpw-tag ' + e.tag + '">' + e.tag + '</span>' +
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
    var changed = false
    for (var i = 0; i < rows.length; i++) {
      var tag = rows[i].tag
      if (lastLabels[tag] && lastLabels[tag] !== rows[i].label) changed = true
      lastLabels[tag] = rows[i].label
    }
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
// 计算某个时刻的完整状态（峰/谷 × 最优是否 DeepSeek）
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
  let label
  if (isPeak) label = isDsOptimal ? '梁文尖' : '梁文峰'
  else label = isDsOptimal ? '梁文平' : '梁文谷'
  return { isPeak, isDsOptimal, bestProv: best.prov, bestPerM: best.price, label, icon: isDsOptimal ? 'whale' : 'router' }
}

// 收集所有会改变“最优价”的窗口边界（分钟-of-day），含 DeepSeek 峰谷边界
function allBoundaries(series) {
  const set = new Set([0, 1440])
  for (const e of series) {
    const sched = (e.schedule || []).filter((s) => Array.isArray(s.windows) && s.windows.length)
    if (!sched.length) continue
    sched.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    for (const w of sched[sched.length - 1].windows) {
      set.add(decodeT(w.utcStart))
      set.add(normEnd(w.utcEnd))
    }
  }
  return [...set].sort((a, b) => a - b)
}

// 距下一次“文字（label）变化”的时间（考虑所有 provider 的最优价切换 + DeepSeek 峰谷切换）
function nextChange(series, nowMs, cur) {
  if (!cur) return null
  const bounds = allBoundaries(series)
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
    if (st && st.label !== cur.label) return t
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
    return st.ok ? Object.assign({ tag: m.tag }, st) : null
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
