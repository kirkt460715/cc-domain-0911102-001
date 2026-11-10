# 采样包协议 v1

每个文件是一个 JSON 对象，包含 `format=river-samples/v1`、`packetId`、`records` 和 `sha256`。包编号是发送方赋予的一次补传标识，重发时不会更换编号；不同文件也可能重复承载同一观测。

## 摘要

摘要只针对 `records` 数组，先按 `src/packet.mjs` 的 `canonical` 递归排序对象键并生成无空白 JSON，再对 UTF-8 字节计算 SHA-256。数组次序不变。包内包含 1 至 10000 条记录。`packetId` 不参与摘要。修改数据后须由发送方重新计算摘要。

## 原始读数

`type=reading` 使用 `stationId`、`bootId`、`seq` 标识一条观测。站点开机时生成新的 `bootId`，序号从零开始，只在同一次开机内有序。`revision` 是该观测的内容修订号，较高修订可以改变 `sampledAt` 和 `raw`。同一身份和修订下，业务字段完全相同才属于同一内容。

`sampledAt` 是观测发生的 UTC 时间，不是接收时间。`raw` 是设备输出的有符号十进制字符串，不允许指数写法。时间统一为 `YYYY-MM-DDTHH:mm:ss.sssZ`，整数均为 JavaScript 安全整数。

## 校准

`type=calibration` 使用 `stationId`、`calibrationId`、`revision` 标识校准内容。有效区间为 `[validFrom, validTo)`，换算公式为 `raw × scale + offset`。`scale` 和 `offset` 均为有符号十进制字符串，最多 24 位整数和 12 位小数。校准的 revision 表示站点校准优先级，同站点生效区间重叠时数值更大的优先；不同 calibrationId 也可能竞争同一时间。相同最高优先级有不同换算依据时，仪器维护记录不足以作出唯一选择。同一 calibrationId 的新修订替换旧修订，包括有效区间变动；必须考虑旧区间失去覆盖的观测。更低修订不能撤销已接收的更高修订。

没有覆盖的读数仍然是有效原始观测。接收时间和文件名都不能推导校准优先级，校准文件也不证明此前补传已完整。

## 合成数据

`01-initial` 含北站和南站的原始值及部分校准。`02-backfill` 是迟到补传。`03-new-boot` 展示北站重启后序号重用。`04-calibration` 是回溯生效的校准。`05-correction` 更正既有观测的时间和原始值。`06-conflict` 含同一读数修订的不同内容及另一站点的正常观测。`07-overlap` 提供同优先级重叠校准。`08-rounding` 保留正负临界小数。所有值均为合成，文件自身不包含接入结果。
