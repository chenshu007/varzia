# 贡献指南

感谢你帮助改进 VARZIA。请先搜索已有 Issue，再提交一个小而明确的 Pull Request。

## 数据修正

欢迎修正：

- Prime 重生轮换
- 遗物和部件
- 稀有度
- 官方简体中文译名

请在 PR 中附上官方页面或掉落表来源，并同步更新核验日期和相关双向映射。数据改动必须通过：

```bash
npm run verify
```

本地与 CI 共用这个只读入口：检查 `js/` 和 `scripts/` 下源码的 Node 语法，运行一次完整测试，再执行 `git diff --check`。完整测试已通过 `tests/growth.test.mjs` 检查 locale 生成页面与模板、词典一致，因此不会重复生成或检查 locale 文件。默认使用 fixtures 和 mock，不请求官方来源；仅检查语言页面时仍可运行 `npm run check:locales`。

Prime featured 装备归属按[目录维护说明](docs/featured-equipment-catalog.md)补录并人工核对官方证据。日常同步只读此目录。

官方 GET 抓取集中在 `scripts/lib/official-sources.mjs`，默认最多三次尝试、单次 30 秒、每个资源总预算 75 秒（包含读取响应、清理和退避）。退避从 500 毫秒指数增长，加入最多 20% jitter，上限 4 秒；`Retry-After` 的等待要求优先，超过剩余预算便失败，不提前重试。HTTP 日期按 [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3) 处理。仅明确可恢复的连接错误、请求超时和 429/500/502/503/504 会重试；403、来源/大小校验和后续解析/证据错误不会重试。重试不能解决永久 CDN 限制或语义错误。

调用同步函数可传入 `signal` 取消；传输测试可注入 `sleep`、随机源、时钟、timer 和日志回调，无需真实等待。日志只含来源 origin、实际尝试次数、错误类型和下一步动作，不包含查询参数或上游错误正文。重试限于单个资源，外层不得再循环执行整个 pipeline。

## Bug 报告

请尽量提供浏览器、设备、操作步骤、预期结果、实际结果，以及涉及的 Prime 或遗物。移动端问题请注明屏幕宽度。

## 模拟器和算法改动

如果修改 `js/simulator.js`、`js/simulation-worker.js` 或相关概率逻辑，请同时提供：

- 自动化测试
- 最小复现案例
- 数学依据或 benchmark
- 对共享 Aya 钱包、奖励选择和联合毕业概率的影响说明

不要只用一次随机运行结果判断算法是否正确。

## Pull Request 原则

- 保持改动范围小而清晰。
- 不提交 `.env`、凭证、浏览器缓存或本地截图输出。
- 不把尚未完成的功能写成已支持功能。
- 不修改官方品牌资源的授权边界。
