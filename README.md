# 河道监测采样包

监测站在连接恢复后，以 JSON 文件补传原始读数和校准记录。本项目提供采样包协议、结构与摘要检查器，以及可在本地查看的合成数据。

## 环境与命令

使用 Node.js 22 或更新版本，仅使用内置模块，无需安装第三方依赖。

```sh
npm test
npm run build
npm run inspect -- fixtures/packets/01-initial.json
```

检查器输出包编号、摘要、站点和记录数量。格式或摘要不合法时返回非零退出码。构建命令检查项目 JavaScript 模块的语法；数据文件不需要编译。

## 文件

`src/packet.mjs` 提供采样包规范化、摘要计算及结构校验。`src/inspect.mjs` 为单文件检查入口。`docs/protocol.md` 说明站点协议和业务字段。`fixtures/packets` 存放合成采样包；这些文件的编号方便阅读，不表示传输顺序。

本项目不包含真实站点地址、密钥或个人数据。检查器只读取文件，不写入站点或采样结果。
