# Prime featured equipment 目录维护

`scripts/catalogs/prime-featured-equipment.json` 是人工确认的 Prime → featured equipment 归属目录。日常同步只读此文件；它不在同步任务可写的 `data/` 文件集合中。

`schemaVersion: 1` 的每个条目包含一名 `warframe`、两件 `items`，以及证明归属的 `sourceUrl`。名称使用官方英文名称，`uniqueName` 使用 Public Export 的完整 `/Lotus/...` 标识。来源必须是 HTTPS 的 `www.warframe.com` 官方新闻页，不接受第三方名单、凭据、查询参数或未经核实的“已验证”标记。现有四个条目保留原来的官方证据链接；目录不记录虚构的核验时间。

新增轮换时：

1. 人工阅读官方 Prime Access / Prime Vault 公告，确认每名 Prime 搭配的两件装备；引用直接支持归属的官方新闻 URL。来源不清楚或互相冲突时，保留失败状态并人工复核。
2. 对缺少的 Prime 补充条目，从官方 Public Export 填入准确名称与标识。不要根据本期遗物含有某件装备就推断 featured 归属；也不要修改核心算法来猜测新组合。
3. 为新增条目保留相应官方导出/奖励 fixture，并补充已知归属的回归期望；执行 `node --test tests/featured-equipment-catalog.test.mjs tests/prime-resurgence-sync.test.mjs`，以及项目统一的 `npm run verify`。这些命令使用本地 fixtures/mock，不改写生产数据。

校验会拒绝非法版本/名称/标识、缺失来源、重复或歧义归属，以及当前选中条目与官方导出的名称、标识或装备角色冲突。完整目录的结构在每次加载时校验；官方导出身份只在该组合的 Vault 组出现后核对，尚未出现的已知组合仍保留 pending。未知 Prime 或缺失归属会明确要求补录和人工复核。

`items` 是本期 featured 规划目标；`rewardItems` 是所选遗物的全部奖励装备；`incidentalItemNames` 是奖励中不属于 featured 的装备名称。Braton/Burston 等 incidental 装备仍接受官方奖励、概率和配方审计。目录不改变这些验证或候选发布边界。

Public Export 能证明装备身份，不能独立证明它与某名 Prime 的发行归属。校验来源 URL 不等于自动阅读并验证公告内容；同一组合内错误交换归属也可能无法仅由导出和奖励检测出来，因此目录更改仍需按引用的官方公告人工审核。数据化降低维护成本，不意味着未来所有组合都能无人维护；新来源格式、并非两件装备的组合或证据冲突都需要明确复核。
