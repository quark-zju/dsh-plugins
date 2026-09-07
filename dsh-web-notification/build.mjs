/**
 * 零依赖构建脚本：
 * - 插件入口：src/index.js 原样拷贝 → lib/index.js
 * - 客户端插件：src/client/index.js 包上 ModuleLoader 工厂握手格式 → lib/client.js
 *
 * 浏览器加载 bundle 时，模块表（dsh-client-modules）提供 __ModuleLoader__ 与 require；
 * factory 返回的 module.exports（{ inject, apply }）即插件本体。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

mkdirSync('lib', { recursive: true })

copyFileSync('src/index.js', 'lib/index.js')

const clientSrc = readFileSync('src/client/index.js', 'utf8')
const wrapped = [
  "window.__ModuleLoader__.load({ id: 'dsh-web-notification', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
  clientSrc,
  'return module.exports; } });',
  '',
].join('\n')
writeFileSync('lib/client.js', wrapped)

console.log('build: lib/index.js + lib/client.js written')
