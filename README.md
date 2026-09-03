# dsh-better-manual-router

DSH Web 侧边栏"设置"按钮正上方的**峰谷定价倒计时小字块**。每 5 分钟轮询一次 OpenRouter 实时定价，显示两行（pro / exp），每行包含：

- **状态文字**：由"DeepSeek 自身时刻表（峰/谷）× DeepSeek 是否当前最低价"决定
  - 峰 + 最优 → 梁文尖（保留态，极少出现）
  - 峰 + 非最优 → 梁文峰
  - 谷 + 最优 → 梁文平
  - 谷 + 非最优 → 梁文谷
- **图标**：只看"谁是最优价"——DeepSeek 最优显示鲸鱼，其他 provider 最优显示路由器
- **倒计时**：距下一次"峰↔谷"切换的 HH:MM
- **数据新鲜度**：超过 15 分钟时显示"(x 分钟前)"

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

## 数据源

- `GET https://openrouter.ai/api/frontend/v1/stats/listed-pricing?permaslug=<canonical>&range=1w&shape=v5&variant=standard`
  - 固定 `range=1w`，匿名访问，host 端 5 分钟缓存节流
- 监控模型：`deepseek/deepseek-v4-pro-20260813`（pro）与 `deepseek/deepseek-v4-flash-vision-exp-20260821`（exp）

## 行为细节

- 时间编码：`schedule.windows[].utcStart/utcEnd` 为 `hours*100+minutes`（UTC 墙钟），解析见 `decodeT`。
- 价格语义：`schedule.input` 与 `series[].input` 均为折后现价（$/1M tokens），`discount` 仅用于反推原价展示，不可再乘 `(1-discount)`。
- 倒计时基于**所有 provider** 的调度边界（含非 DeepSeek 提供商的低价切换点），取第一个会让当前行状态改变的时刻。
