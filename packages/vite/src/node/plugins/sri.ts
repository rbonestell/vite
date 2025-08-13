import { createHash } from 'node:crypto'
import { parse, serialize } from 'parse5'
import type { OutputBundle } from 'rollup'
import type { Plugin } from '../plugin'
import type { ResolvedConfig } from '../config'
import type { BuildSriOptions } from '../build'

export function sriPlugin(config: ResolvedConfig): Plugin {
  const options = (config.build.sri || {}) as BuildSriOptions
  const algorithm = options.algorithm || 'sha384'
  const crossorigin = options.crossorigin
  const preloadDynamic = options.preloadDynamicImports !== false
  const runtime = options.runtime !== false

  let base = config.base || '/'
  if (!base.endsWith('/')) base += '/'

  const sriMap = new Map<string, string>()
  const dynamicImports = new Set<string>()

  return {
    name: 'vite:sri',
    apply: 'build',
    enforce: 'post',

    generateBundle(_: unknown, bundle: OutputBundle) {
      for (const [fileName, out] of Object.entries(bundle)) {
        if (out.type === 'asset') {
          if (/\.(css|js|mjs)$/i.test(fileName)) {
            const source = out.source as string | Uint8Array
            sriMap.set('/' + fileName, createIntegrity(source, algorithm))
          }
        } else if (out.type === 'chunk') {
          if (/\.(css|js|mjs)$/i.test(fileName)) {
            sriMap.set('/' + fileName, createIntegrity(out.code, algorithm))
          }
          if (preloadDynamic && out.dynamicImports) {
            for (const dep of out.dynamicImports) {
              const imported = bundle[dep]
              if (imported && imported.type === 'chunk') {
                dynamicImports.add(imported.fileName)
              } else {
                dynamicImports.add(dep)
              }
            }
          }
        }
      }

      for (const [fileName, out] of Object.entries(bundle)) {
        if (out.type === 'asset' && fileName.endsWith('.html')) {
          const html = typeof out.source === 'string' ? out.source : String(out.source)
          out.source = processHtml(
            html,
            sriMap,
            dynamicImports,
            base,
            crossorigin,
            preloadDynamic,
          )
        }
      }
    },

    renderChunk(code, chunk) {
      if (!runtime || !chunk.isEntry) return null
      if (sriMap.size === 0) return null
      const mapObject = Object.fromEntries(sriMap)
      const serialized = JSON.stringify(mapObject)
      const cors = crossorigin ? JSON.stringify(crossorigin) : 'false'
      const injected = `\n(${installSriRuntime.toString()})(${serialized}, { crossorigin: ${cors} });\n`
      return { code: injected + code, map: null }
    },
  }
}

function createIntegrity(
  source: string | Uint8Array,
  algorithm: 'sha256' | 'sha384' | 'sha512',
): string {
  const hash = createHash(algorithm)
  hash.update(typeof source === 'string' ? source : Buffer.from(source))
  return `${algorithm}-${hash.digest('base64')}`
}

function processHtml(
  html: string,
  sriMap: Map<string, string>,
  dynamicImports: Set<string>,
  base: string,
  crossorigin: string | undefined,
  preloadDynamic: boolean,
): string {
  const document = parse(html)
  const head = findElement(document, 'head')
  const existingPreloads = new Set<string>()

  const lookup = (url: string): string | undefined => {
    try {
      const u = new URL(url, 'http://example.com')
      let p = u.pathname
      if (base !== '/' && p.startsWith(base)) {
        p = '/' + p.slice(base.length)
      }
      return sriMap.get(p)
    } catch {
      return undefined
    }
  }

  const visit = (node: any): void => {
    if (node.tagName === 'script') {
      const src = getAttr(node, 'src')
      if (src) {
        const integrity = lookup(src)
        if (integrity) {
          setAttr(node, 'integrity', integrity)
          if (crossorigin) setAttr(node, 'crossorigin', crossorigin)
        }
      }
    } else if (node.tagName === 'link') {
      const rel = getAttr(node, 'rel')
      const href = getAttr(node, 'href')
      if (href) {
        if (rel === 'modulepreload') existingPreloads.add(href)
        if (
          rel === 'stylesheet' ||
          rel === 'modulepreload' ||
          (rel === 'preload' && ['script', 'style', 'font'].includes(getAttr(node, 'as') || ''))
        ) {
          const integrity = lookup(href)
          if (integrity) {
            setAttr(node, 'integrity', integrity)
            if (crossorigin) setAttr(node, 'crossorigin', crossorigin)
          }
        }
      }
    }
    if (node.childNodes) node.childNodes.forEach(visit)
  }
  visit(document)

  if (preloadDynamic && head) {
    for (const file of dynamicImports) {
      const href = base + file
      if (existingPreloads.has(href)) continue
      const integrity = sriMap.get('/' + file)
      if (!integrity) continue
      const attrs: any[] = [
        { name: 'rel', value: 'modulepreload' },
        { name: 'href', value: href },
        { name: 'integrity', value: integrity },
      ]
      if (crossorigin) attrs.push({ name: 'crossorigin', value: crossorigin })
      const linkNode: any = {
        nodeName: 'link',
        tagName: 'link',
        attrs,
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        childNodes: [],
        parentNode: head,
      }
      head.childNodes.unshift(linkNode)
    }
  }

  return serialize(document)
}

function findElement(node: any, tag: string): any | null {
  if (node.tagName === tag) return node
  if (node.childNodes) {
    for (const child of node.childNodes) {
      const res = findElement(child, tag)
      if (res) return res
    }
  }
  return null
}

function getAttr(node: any, name: string): string | undefined {
  const attr = node.attrs?.find((a: any) => a.name === name)
  return attr?.value
}

function setAttr(node: any, name: string, value: string): void {
  const attr = node.attrs?.find((a: any) => a.name === name)
  if (attr) {
    attr.value = value
  } else {
    node.attrs = node.attrs || []
    node.attrs.push({ name, value })
  }
}

function installSriRuntime(
  sri: Record<string, string>,
  opts?: { crossorigin?: false | 'anonymous' | 'use-credentials' },
) {
  try {
    const cors =
      opts && Object.prototype.hasOwnProperty.call(opts, 'crossorigin')
        ? opts.crossorigin
        : 'anonymous'
    const lookup = (url: string): string | undefined => {
      try {
        const u = new URL(url, location.href)
        return sri[u.pathname]
      } catch {
        return undefined
      }
    }
    const apply = (el: any) => {
      const url = el.tagName === 'LINK' ? el.href : el.src
      const integrity = lookup(url)
      if (integrity) {
        if (!el.integrity) el.integrity = integrity
        if (cors && !el.crossOrigin) el.crossOrigin = cors
      }
    }
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if ((n as any).tagName === 'SCRIPT' || (n as any).tagName === 'LINK') {
            apply(n)
          }
        }
      }
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  } catch {
    // ignore
  }
}

