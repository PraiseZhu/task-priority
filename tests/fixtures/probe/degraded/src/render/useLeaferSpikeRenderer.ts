// 降级 fixture 关注路径：无 scripts/codemap.mjs → probe 必须标 degraded: true
// 引用者 src/canvas/useSpike.ts 的 import 语句含 basename，git grep 粗粒度扫描应命中
export function useLeaferSpikeRenderer() {
  return "renderer";
}
