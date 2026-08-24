// is-direct-run.mjs — CLI 入口守卫。经 ~/.claude/skills/... 软链调用时,
// import.meta.url(已解析) !== pathToFileURL(argv[1])(未解析),旧比较会静默空转。
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isDirectRun(metaUrl, argv1 = process.argv[1]) {
  if (!argv1 || !metaUrl) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
