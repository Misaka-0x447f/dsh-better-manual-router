# dsh-better-manual-router

DSH Web 侧边栏"设置"按钮正上方的**峰谷定价小字块**。每 5 分钟轮询一次 OpenRouter 实时定价，单行显示：

- **文字（峰/谷）**：只看 DeepSeek 自身时刻表，不叠加"是否最优价"维度
  - DeepSeek 峰（贵）→ 梁文峰
  - DeepSeek 谷（便宜）→ 梁文谷
- **图标（谁最便宜）**：DeepSeek 当前最低价 → 鲸鱼；其他 provider 更低 → 路由器
- **倒计时**：距下一次"文字或图标变化"的 HH:MM
- **数据新鲜度**：超过 15 分钟时显示"(x 分钟前)"

> v0.2.0 起只跟踪 `deepseek/deepseek-v4.1-flash` 单模型，原先的 pro/exp 双行与小标签已退役；旧版四态命名（梁文尖/梁文峰/梁文平/梁文谷）与旧版定时器规则的完整留档见 `lib/index.js` 末尾的「历史实现留档」。

## 安装

在 DSH profile 的 `package.json` 中添加依赖：

```json
{
  "dependencies": {
    "dsh-better-manual-router": "github:Misaka-0x447f/dsh-better-manual-router"
  },
  "dsh": {
    "profile": {
      "bundles": [ "...", "dsh-better-manual-router" ]
    }
  }
}
```

然后 `pnpm install`，重启 DSH host，刷新浏览器。

> `github:` 依赖锁定到具体 commit；改完代码 push 后，profile 侧需 `pnpm update dsh-better-manual-router` 才能拉到新版本。

## 数据源

- `GET https://openrouter.ai/api/frontend/v1/stats/listed-pricing?permaslug=<canonical>&range=1w&shape=v5&variant=standard`
  - 固定 `range=1w`，匿名访问，host 端 5 分钟缓存节流
- 跟踪模型：`deepseek/deepseek-v4.1-flash-20260910`
  - **必须用带日期后缀的 canonical slug**；简写 `deepseek/deepseek-v4.1-flash` 会返回空 `series`
- 成本格局（$/1M input，2026-09-11 实测）：DeepSeek 谷 $0.15 / 峰 $0.30；DeepInfra $0.20；Fireworks $0.22；其余 6 家 $0.30
  - 谷时 DeepSeek 最优 → 鲸鱼；峰时 DeepInfra 最优 → 路由器
  - 只有 DeepSeek 一家带 schedule，其余全为固定价

## 行为细节

- 时间编码：`schedule.windows[].utcStart/utcEnd` 为 `hours*100+minutes`（UTC 墙钟），解析见 `decodeT`。
- 峰时窗口（工作日）：UTC 01:00-04:00 / 06:00-10:00 = 北京 09:00-12:00 / 14:00-18:00；周末全天谷价。
- 价格语义：`schedule.input` 与 `series[].input` 均为折后现价（$/1M tokens），`discount` 仅用于反推原价展示，不可再乘 `(1-discount)`。
- 倒计时只看 DeepSeek 自身峰谷边界；因为周末全天谷价不产生切换，周五晚间会出现 `60+` 小时的长倒计时（指向周一 09:00），这是预期行为。
- 旧版曾用"合并所有 provider 边界"的定时器规则来处理带 schedule 的第三方 provider（如旧 pro 上的 Alibaba 22:00 降价），该规则已保留为代码注释备查。
