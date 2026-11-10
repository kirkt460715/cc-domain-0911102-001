# 河道监测采样包

监测站在连接恢复后，以 JSON 文件补传原始读数和校准记录。本项目提供采样包协议、结构与摘要检查器、可恢复的数据接入模块，以及可在本地查看的合成数据。

## 环境与命令

使用 Node.js 22 或更新版本，仅使用内置模块，无需安装第三方依赖。

```sh
npm test          # 自动化测试（含崩溃恢复与双进程并发）
npm run build     # 语法构建检查
npm run inspect -- fixtures/packets/01-initial.json   # 检查单个采样包
npm run demo      # 端到端演示：首次接入、崩溃恢复、校准更正
```

## 数据接入

接入模块把一个目录里乱序到达的采样包汇成可追溯、按版本发布的数据集。
状态保存在 SQLite（内置 `node:sqlite`），默认目录 `./state`，可用 `--state` 或
环境变量 `RIVER_STATE` 指定。

```sh
npm run river -- ingest <文件或目录>...   # 导入采样包；目录取其下全部 .json
npm run river -- process                  # 继续处理：把未发布变更发布为新版本
npm run river -- query --station north --from 2026-11-01T00:00:00.000Z --to 2026-11-02T00:00:00.000Z
npm run river -- query --station north --version 1    # 读取某个完整历史版本
npm run river -- status                   # 已接收的包、未发布变更、拒绝记录
npm run river -- quarantine               # 被隔离的冲突观测
npm run river -- versions                 # 发布历史
```

行为要点：

- 同一读数（`stationId`/`bootId`/`seq`）重发不重复计数；较高 `revision` 更正采样时间与原始值。
- 同身份同修订但内容不同的记录双双隔离待核对，其余观测照常接入；包标识相同而内容不同明确拒绝。
- 结构不合法或摘要不符的包整体回滚，不影响当前数据。
- 校准按采样时刻选择（左闭右开），重叠取最高 `revision`，同优先级歧义保留待核对；
  缺少校准的读数保留原始值但不冒充已换算。换算 `raw × scale + offset` 保留三位小数，
  正中间向绝对值更大方向舍入。
- 查询固定在某个完整发布版本；迟到的校准或更正发布后使旧结果失效，旧版本仍可查询。
- 导入与发布都是单事务，进程中途退出可安全重跑；两个接入进程可同时处理同一目录。
  设置 `RIVER_FAULT_AT=ingest.precommit|publish.afterDerive|publish.precommit` 可在
  固定中断点注入崩溃，用于演练恢复。

设计与取舍详见 `docs/design.md`。

## 文件

`src/packet.mjs` 提供采样包规范化、摘要计算及结构校验。`src/inspect.mjs` 为单文件检查入口。`src/cli.mjs`、`src/ingest.mjs`、`src/derive.mjs`、`src/query.mjs`、`src/store.mjs`、`src/decimal.mjs` 构成接入模块。`docs/protocol.md` 说明站点协议和业务字段。`fixtures/packets` 存放合成采样包；这些文件的编号方便阅读，不表示传输顺序。`demo/demo.sh` 串起首次接入、崩溃恢复与校准更正的完整演示。

本项目不包含真实站点地址、密钥或个人数据。检查器只读取文件，不写入站点或采样结果。
