import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'

// 最小 ESM resolve 钩子：把 `@/x` 映射到 `<cwd>/src/x`，交由默认解析器补扩展名
export async function resolve(specifier: string, context: { parentURL?: string }, nextResolve: Function) {
  if (specifier.startsWith('@/')) {
    const abs = resolvePath(process.cwd(), 'src', specifier.slice(2))
    return nextResolve(pathToFileURL(abs).href, context)
  }
  return nextResolve(specifier, context)
}
