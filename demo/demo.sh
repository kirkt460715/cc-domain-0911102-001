#!/usr/bin/env bash
# 端到端演示：首次接入 → 崩溃恢复 → 校准更正 → 冲突隔离与舍入。
# 直接执行：bash demo/demo.sh（状态目录为临时目录，退出即清理）。
set -euo pipefail
cd "$(dirname "$0")/.."

STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT
CLI=(node --disable-warning=ExperimentalWarning src/cli.mjs --state "$STATE")
P=fixtures/packets

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
run()  { printf '\n$ river %s\n' "$*" >&2; "${CLI[@]}" "$@"; }
rows() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('  发布版本 v'+j.version);for(const r of j.readings)console.log('   ',r.stationId,r.bootId+'/'+r.seq,'rev'+r.revision,r.sampledAt,'raw='+r.raw,'=>',r.value??'(未换算)',r.status,r.calibration?'依据 '+r.calibration.calibrationId+'@'+r.calibration.revision:'',r.competitors?'待核对:'+r.competitors.map(c=>c.calibrationId+'@'+c.revision).join(' vs '):'')})"; }

say '阶段 1：首次接入 —— 乱序到达的补传包形成首个发布版本'
run ingest "$P/03-new-boot.json" "$P/01-initial.json" "$P/02-backfill.json"
run process
run query --station north | rows
printf '\n（02-backfill 重发了 01-initial 的 seq10，只计数一次；南站尚无校准，保留原始观测）\n'
run query --station south | rows

say '阶段 2：崩溃恢复 —— 写入事实与发布切换中途退出'
printf '\n$ RIVER_FAULT_AT=ingest.precommit … ingest 04-calibration.json  # 模拟写事实中途崩溃\n'
RIVER_FAULT_AT=ingest.precommit "${CLI[@]}" ingest "$P/04-calibration.json" || true
run status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('  崩溃后：已接收包 =',j.packets.map(p=>p.packetId).join(', '),'| 当前版本 v'+j.currentVersion,'| 未发布 =',JSON.stringify(j.pending.unpublishedPackets))})"
printf '\n（整包回滚，04 号包未留痕迹；重新导入即可恢复）\n'
run ingest "$P/04-calibration.json" >/dev/null && echo '  重新导入 04-calibration.json：已接收'
printf '\n$ RIVER_FAULT_AT=publish.precommit … process  # 模拟发布切换中途崩溃\n'
RIVER_FAULT_AT=publish.precommit "${CLI[@]}" process || true
run query --station north | rows
printf '\n（发布失败，值班人员看到的仍是完整的 v1，不是半成品）\n'
run process
run versions | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('  发布历史：',JSON.parse(s).publications.map(p=>'v'+p.version).join(', '),'—— 重试恰好补发一次，没有重复版本')})"

say '阶段 3：校准更正 —— 回溯生效的校准使已发布结果失效并更新'
printf '\n（04 号包的 base@2 校准 [00:00,06:00) scale=1.02 已随 v2 生效；对比同一查询的两个版本）\n'
run query --station north --version 1 | rows
run query --station north | rows
printf '\n（继续接收读数更正 05 与同优先级重叠校准 07）\n'
run ingest "$P/05-correction.json" "$P/07-overlap.json" >/dev/null && echo '  05-correction、07-overlap：已接收'
run process >/dev/null && echo '  已发布 v3'
run query --station north | rows
printf '\n（seq10 被更正到 07:00 并移出校准覆盖 → 保留原始值但不冒充已换算；02:00–05:00 内同优先级校准歧义 → 保留待核对）\n'

say '阶段 4：冲突隔离与十进制舍入'
run ingest "$P/06-conflict.json" "$P/08-rounding.json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const r of JSON.parse(s).results)console.log('  ',r.file.split('/').pop(),'=>',r.status,r.quarantined?'隔离 '+r.quarantined+' 条':'')})"
run process >/dev/null && echo '  已发布 v4'
run quarantine | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const g of JSON.parse(s).groups){const id=g.identity;console.log('  隔离：',id.stationId,id.bootId+'/'+id.seq,'rev'+id.revision,'内容',g.contents.map(c=>JSON.stringify(c.content)).join(' 与 '),'来源',g.contents.flatMap(c=>c.sources.map(x=>x.packetId)).join('、'))}})"
run query --station north | rows
printf '\n（seq10 的 rev2 两种内容双双隔离，回退到无冲突的 rev1；冲突包中南站的正常观测不受影响）\n'
run query --station edge | rows
printf '\n（±0.0005 的正中间都向绝对值更大方向舍入；大整数原始值不丢精度）\n'

say '演示结束'
