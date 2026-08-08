// 引用者（降级模式靠 git grep 粗粒度命中）
import { useLeaferSpikeRenderer } from "../render/useLeaferSpikeRenderer";

export function useSpike() {
  return useLeaferSpikeRenderer();
}
