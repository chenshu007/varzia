# VARZIA

> Warframe Prime 重生规划器

让 RNG 跑 100,000 条时间线。

🌐 [varzia.starport1116.com](https://varzia.starport1116.com) · [中文](https://varzia.starport1116.com/zh/) · [English](https://varzia.starport1116.com/en/)

VARZIA 是一个面向 Warframe 玩家的 Prime 重生规划工具。选择当前轮换中的 Prime 装备、勾选已经拥有的部件并输入阿耶精华预算，Varzia 会通过联合蒙地卡罗模拟估算整期毕业概率、P50/P90/P95/P99 资源需求，并给出遗物购买建议。界面提供 `/zh/` 与 `/en/` 两个语言入口，语言选择会保存在浏览器本地。

Varzia 是非官方社区工具，与 Digital Extremes 没有隶属、赞助或授权关系。

## 功能

- 当前 Prime 重生轮换
- 下一期轮换倒计时、预告与到点自动切换
- Prime 战甲与 Prime 武器全量模拟
- 已有部件收藏与整件完成标记
- 共享阿耶精华预算
- 单人、2 人、3 人、4 人同遗物模式
- 遗物精炼策略与 100,000 次联合蒙地卡罗模拟
- P50、P90、P95、P99 资源需求
- 当前 Aya 到 P90/P95/P99 的安全线差值
- SVG → Canvas/PNG 结果卡，可下载或调用系统分享
- 基于已有离散经验 CDF 的毕业复盘与脸黑指数
- 面向整期目标的遗物购买建议
- 本地收藏保存
- 中英文与移动端优先界面

安全线差值直接读取同一次模拟产生的 P90/P95/P99，不会触发第二次模拟。毕业复盘也只查同一条离散预算曲线：它描述的是本次模拟时间线中的相对位置，不代表真实玩家总体分布；不在曲线节点中的预算不会被线性外推。

## 模拟模型

一次 trial 表示一个玩家从当前已有部件与阿耶精华预算开始，完成所有选中 Prime 装备的完整刷取过程。

- 所有装备共享同一个阿耶精华钱包。
- 每开启一枚遗物消耗一次对应资源。
- 4 人同遗物会模拟全队奖励。
- 每次裂缝最终只能领取一个奖励。
- 获得部件后会重新评估整期剩余目标。
- 本期全部毕业概率来自同一 trial 中所有目标同时完成的比例。

遗物选择与奖励选择采用可解释的动态贪心启发式。它用于寻找高毕业率方案，但不保证数学意义上的全局最优。页面中的联合毕业概率是当前实现策略下的蒙地卡罗估计结果，不是理论保证。

## 验证

以光辉遗物的单个稀有奖励概率 10% 为例，4 人同遗物时至少出现一次目标奖励的理论概率为：

```text
1 - (1 - 0.10)^4 ≈ 34.39%
```

项目测试会验证该概率，以及以下联合模拟规则：战甲与武器共享 Aya 钱包、同一遗物覆盖多个目标、每把裂缝只能领取一个奖励、部件与遗物双向映射完整、P50/P90/P95/P99 使用真实完成成本分布。

## 本地运行

项目是无构建步骤的静态页面。浏览器需要通过 HTTP 服务读取 JSON 数据：

```bash
git clone https://github.com/chenshu007/varzia.git
cd varzia
python3 -m http.server 4173
```

然后打开 <http://127.0.0.1:4173/>。

运行测试：

```bash
npm test
```

项目不依赖 Vite、React 或其他前端构建链。Cloudflare Pages 继续负责官方实例的正式部署；GitHub 仓库用于源代码、Issue、Pull Request、文档和测试。

## 项目结构

```text
data/
  rotation.json          # 按 UTC 生效时间排列的轮换时间表
  primes.json            # Prime 装备、部件和部件 -> 遗物映射
  relics.json            # 遗物 -> 目标奖励映射

js/
  i18n.js                # 双语词典、语言解析、入口与选择持久化
  wave1.js               # P90/P95/P99 差值与离散毕业复盘
  share-card.js          # 运行时 SVG 结果卡与 PNG 转换
  route-entry.js         # /zh/ 与 /en/ 的共享 App 静态入口
  rotation-schedule.js   # 当前/下一期解析、倒计时与轮换边界逻辑
  simulator.js           # 联合蒙地卡罗核心与启发式选择
  simulation-worker.js   # 浏览器 Worker
  data-validation.js     # 轮换、部件、遗物数据校验
  presentation.js        # 概率与结果展示格式化
  storage.js             # 本地收藏保存
  app.js                 # 页面交互

data/locales/
  zh-cn.json             # 简体中文词典
  en.json                # English dictionary

zh/index.html            # 中文静态入口
en/index.html            # English static entry

tests/
  data.test.mjs
  simulator.test.mjs
  storage.test.mjs
  rotation-schedule.test.mjs
  wave1.test.mjs

assets/
  ocisly-m.svg            # Starport 标志资源
```

## 数据来源

- Prime 重生轮换：[Warframe 官方 Prime 重生页面](https://www.warframe.com/zh-hans/prime-resurgence)
- 掉落概率：[Warframe 官方掉落表](https://www.warframe.com/droptables)
- 中文名称：Warframe 官方简体中文优先，中文 Wiki 可用于辅助核对

轮换和掉落数据会随游戏官方内容变化。提交数据更新时，请在 JSON 中同步更新核验日期、来源和映射，并运行完整测试。

## 每月 Prime 重生更新流程

`data/rotation.json` 是按 `startsAt` 严格递增的轮换时间表。每一期只填写开始时间；上一期会在下一期 `startsAt` 自动结束，最后一个已知轮换则持续生效，不需要维护 `endsAt`。

所有生效时间必须使用精确到秒的 ISO 8601 UTC，例如 `2026-09-01T18:00:00Z`。页面负责按玩家浏览器的本地时区显示时间。

1. 等待官方发布下一期 Prime 重生公告。
2. 核对官方简体中文名称和准确的轮换生效时间。
3. 如有新装备或遗物，先追加更新 `data/primes.json` 与 `data/relics.json`，保持历史装备定义、玩家全局收藏以及部件和遗物奖励双向映射；不要用新一期覆盖旧目录。
4. 在 `data/rotation.json` 的 `rotations[]` 末尾加入下一期，填写唯一 `id`、UTC `startsAt`、`items`、`relics` 和可选的 `defaults.ayaBudget`。
5. 不要填写 `endsAt`，也不要把未公布或猜测的数据放入生产 JSON。
6. 运行 `npm test`，确认时间边界、数据关系、存储迁移和原有蒙地卡罗测试全部通过。
7. 用 `?rotation=<id>` 打开维护预览，例如 `http://127.0.0.1:4173/?rotation=2026-09`。页面会标明“预览模式”，且不会写入正式选择或 Aya 输入。
8. 检查 1440 桌面端以及 430、390、375、320 宽度移动端，确认倒计时、预告、选择、收藏与模拟无横向溢出。
9. 提前部署。普通 URL 会继续按浏览器当前时间显示真实轮换；到达 `startsAt` 后，已打开的页面也会在当前状态内自动切换。

正常轮换当天不需要重新部署、刷新页面或执行服务端定时任务。

## 贡献

欢迎提交数据修正、概率或界面 Bug，以及有测试支持的模拟改进。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

如果提交 optimizer 或 simulation 核心改动，请同时提供测试、最小复现案例和数学依据或 benchmark。仅凭主观感觉调整概率核心，不足以作为合并依据。

安全问题请先阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中粘贴凭证或其他敏感细节。

## 品牌与许可证

本项目源代码使用 [MIT License](LICENSE) 开源。

VARZIA 名称、Logo、Starport1116 品牌及官方项目标识不包含在 MIT License 的品牌授权范围内。开源代码可以被合法使用、修改、Fork 和再发布，但这不等于获得官方 VARZIA 实例或品牌的授权，也不应使衍生项目误认为由 Starport1116 官方发布。

官方部署地址：<https://varzia.starport1116.com>

Varzia 是非官方 Warframe 玩家工具，与 Digital Extremes 没有隶属、赞助或授权关系。Warframe 及相关名称、图像和知识产权归其各自权利人所有。

The source code of this project is licensed under the MIT License.

The VARZIA name, logo, Starport1116 branding, and official project identity are not granted for use under the MIT License.

The official deployment is <https://varzia.starport1116.com>.

Varzia is an unofficial community project and is not affiliated with, endorsed by, or sponsored by Digital Extremes. Warframe and related names, assets, and intellectual property belong to their respective owners.
