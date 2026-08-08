// 引用者：src/render 模块的直接反向引用者（depth 1）
import { useLeaferSpikeRenderer } from "../render/useLeaferSpikeRenderer";

export function useSpike() {
  return useLeaferSpikeRenderer();
}
