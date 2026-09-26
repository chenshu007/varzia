# 页面模块边界

页面继续使用原生 ES modules，由 `app.js` 组合 controller 和 view，再按原顺序完成 locale/route 解析、数据加载与校验、轮换及 session 恢复、事件绑定、首屏渲染和计时器启动。HTML/CSS、分享编码、storage/session schema、概率算法和 Worker 协议沿用原实现。

| 模块 | 负责 | 状态与输入 |
| --- | --- | --- |
| `app-data-loader.js` | 启动时读取并校验必需目录、生成语言展示数据、加载可选公告 | 显式接收 locale/fetch/warn，返回完整 snapshot 与错误；不访问 DOM、storage 或 app state |
| `simulation-controller.js` | debounce、请求身份、pending rerun、过期响应、取消及失败恢复 | 独占请求计数器、运行状态和 timer；每次运行从 `prepareRequest` 读取最新输入，结果通过 hooks 返回 |
| `rotation-ui-controller.js` | 倒计时、preview 解析/提示、公告候选展示、页面生命周期监听 | 独占 watcher；显式读取轮换快照，复用 `rotation-schedule.js`，通过 `applyRotation` 请求页面切换 |
| `session-ui-controller.js` | start/resume/log/undo/finish/cancel、持久化次序和 session 面板 | 独占 active/suspended/unresolved session 与 ticker；复用 `session.js` 和 `storage.js`，仅通过 `applyPlannerState` 更新 planner |
| `share-ui-controller.js` | 计划链接、PNG/QR、复制/系统分享、generation 竞态和 Blob URL | 独占卡片与 generation；读取已接受的结果快照，保留原浏览器降级路径 |
| `collection-view.js` | 轮换装备、目标选择和拥有部件列表 | 按调用接收目录、选择、拥有数量及锁定状态，不修改 planner |
| `results-view.js` | 概率结果、推荐、明细、percentile 和 recap 展示 | 接收 result/options 与展示模型；recap 返回给 app，不访问 app state |
| `budget-chart-view.js` | SVG 曲线、标签、tooltip、键盘交互与 resize | 独占图表缓存/resize timer；使用原曲线校验，不参与模拟 |
| `planner-ownership.js`、`dom-helpers.js` | 拥有数量转换和 HTML 转义 | 纯 helper，无 DOM/storage 副作用 |

`app.js` 保留 locale/SEO 初始化、顶层事件绑定、collection 持久化、输入/结果 UI 衔接和 `applyRotation`。轮换采用会同时切换目录、session、收藏与模拟，因此跨 controller 的执行次序继续由入口管理；没有再建一个全局 store 或事件总线。

controller 不导入 `app.js`，也不互相导入；与页面的协作用明确 callbacks 完成。唯一权威的 planner 输入和已接受结果留在 app，controller 拥有自己的生命周期状态；传入的 snapshot 只供读取。原 app 导出的测试/兼容 helper 名称仍可使用。

启动目录沿用原有失败策略：rotation/primes/relics 任一读取或联合校验失败，整个可用目录置空，并由 app 显示数据错误；不使用不完整目录启动模拟。此时不请求公告候选。可选公告缺失或不合法只清空预告，不影响已经校验的正式目录。浏览器仍对每个资源执行一次 `cache: "no-store"` 请求，不复用官方同步器的重试。日期标签保留原有原始文档／fallback 日期选择规则，不代表失败的数据已经验证成功。

验收运行 `npm run verify`。controller 测试使用 fake worker/timer/storage/DOM，覆盖过期结果、排队重跑、恢复/撤销、持久化失败、future schema、preview 和分享竞态；依赖图测试保护无循环导入。`app-data-loader.test.mjs` 用真实本地目录和 mock fetch 验证上述失败边界、中英文展示与源文档不变性。`planner-views.test.mjs` 执行实际 renderer，检查输出、动态文本转义、已有数量、锁定控件及结果分支，不依赖源码模板的拼写。实际页面及 Worker/PNG 行为另外用本地静态服务器检查。
