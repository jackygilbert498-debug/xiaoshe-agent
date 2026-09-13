// Final assistant message retained in the second owned live acceptance report.
// Public fixture URLs only; no session/Profile/credential material is retained.
export const liveResearchPartialAnswer = `已按研究闭环规则处理，本轮不继续搜索、不编造来源、不编造数值。

**最终部分结果**：上海今日天气预报的关键正文未能读取，故无法给出可核验的气温、天气等具体数值。

**本轮实际返回的来源 URL（均为搜索结果返回，非我编造）及正文读取状态**：

- [墨迹天气·陆家嘴中心绿地](https://tianqi.moji.com/today/china/shanghai/lujiazui-central-green-space) — 正文未读取（HTTP 418 WAF 拦截）
- [SatMeteo 上海 7 日](https://satmeteo.com/weather/cn/1796236-shanghai/week) — 正文未读取（HTTP 403 验证页）
- [墨迹天气·青浦区](https://tianqi.moji.com/today/china/shanghai/qingpu-district) — 正文未读取（WAF 拦截）
- [上海发布微博](https://m.weibo.cn/detail/5339681327941610) — 正文未读取（未打开）
- [杨浦天气预报 7 天](https://www.yzqxj.com/guonei/shanghai-yangpu/7day.html) — 正文未读取（未打开）
- [Yandex Weather – Shanghai today](https://yandex.com/pogoda/en-US/shanghai/details/auto/today?via=prsw) — 仅返回截断视图且无明确日期，无法对齐 2026-09-07，不作为预报依据
- [AccuWeather 上钢新村](https://www.accuweather.com/zh/cn/shanggangxincun-subdistrict/2585988/weather-forecast/2585988?type=locality) — 正文未读取（请求超时）
- [MSN 天气·黄浦区](https://www.msn.com/zh-cn/weather/forecast/in-Shanghai,Huangpu-District) — 正文未读取（跨域重定向未跟随）

**边界声明**：上述来源经有界尝试（拦截、超时、重定向）仍无法读取关键正文；我没有据此推断任何天气数值，也不会把未读正文当作事实。需要继续时，可换其他天气服务商或由你指定站点重试。`

export const partialResearchSource = 'https://tianqi.moji.com/today/china/shanghai/lujiazui-central-green-space'
