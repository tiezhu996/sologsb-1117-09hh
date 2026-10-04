import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// 给 tsx 运行时注册最小的 `@/` → `src/` 路径别名解析
register('./scripts/tsconfig-resolver.ts', pathToFileURL('./'))
