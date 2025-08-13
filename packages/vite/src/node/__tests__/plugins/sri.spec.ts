import { createHash } from 'node:crypto'
import type { OutputAsset, OutputBundle, OutputChunk } from 'rollup'
import { describe, expect, it } from 'vitest'

import { sriPlugin } from '../../plugins/sri'
import type { ResolvedConfig } from '../../config'

function integrity(
  source: string | Uint8Array,
  algorithm: 'sha256' | 'sha384' | 'sha512',
): string {
  const hash = createHash(algorithm)
  hash.update(typeof source === 'string' ? source : Buffer.from(source))
  return `${algorithm}-${hash.digest('base64')}`
}

describe('sri plugin', () => {
  it('injects integrity, crossorigin and runtime', () => {
    const config = {
      base: '/',
      build: { sri: { crossorigin: 'anonymous' } },
    } as unknown as ResolvedConfig

    const plugin = sriPlugin(config)

    const js = `console.log('hi');import('./dynamic.js')`
    const css = new TextEncoder().encode('body{color:red}')
    const dyn = `console.log('dyn')`

    const bundle: OutputBundle = {
      'index.html': {
        type: 'asset',
        source:
          '<html><head></head><body><script src="/main.js"></script><link rel="stylesheet" href="/style.css"></body></html>',
      } as OutputAsset,
      'main.js': {
        type: 'chunk',
        fileName: 'main.js',
        code: js,
        dynamicImports: ['dynamic.js'],
        isEntry: true,
      } as unknown as OutputChunk,
      'style.css': {
        type: 'asset',
        source: css,
      } as OutputAsset,
      'dynamic.js': {
        type: 'chunk',
        fileName: 'dynamic.js',
        code: dyn,
        dynamicImports: [],
        isEntry: false,
      } as unknown as OutputChunk,
    }

    ;(plugin.generateBundle as any)?.({}, bundle)

    const jsHash = integrity(js, 'sha384')
    const cssHash = integrity(css, 'sha384')
    const dynHash = integrity(dyn, 'sha384')

    const html = bundle['index.html'] as OutputAsset
    expect(html.source as string).toContain(
      `<script src="/main.js" integrity="${jsHash}" crossorigin="anonymous"></script>`,
    )
    expect(html.source as string).toContain(
      `<link rel="stylesheet" href="/style.css" integrity="${cssHash}" crossorigin="anonymous">`,
    )
    expect(html.source as string).toContain(
      `<link rel="modulepreload" href="/dynamic.js" integrity="${dynHash}" crossorigin="anonymous">`,
    )

    const rendered = (plugin.renderChunk as any)?.(js, {
      isEntry: true,
      fileName: 'main.js',
    })
    expect(rendered?.code).toContain('installSriRuntime')
  })

  it('respects base and disabled options', () => {
    const config = {
      base: '/foo/',
      build: {
        sri: {
          algorithm: 'sha256',
          crossorigin: 'use-credentials',
          preloadDynamicImports: false,
          runtime: false,
        },
      },
    } as unknown as ResolvedConfig

    const plugin = sriPlugin(config)

    const js = `console.log('base');import('./dynamic.js')`
    const css = 'body{color:blue}'
    const dyn = `console.log('dyn')`

    const bundle: OutputBundle = {
      'index.html': {
        type: 'asset',
        source:
          '<html><head></head><body><script src="/foo/main.js"></script><link rel="stylesheet" href="/foo/style.css"></body></html>',
      } as OutputAsset,
      'main.js': {
        type: 'chunk',
        fileName: 'main.js',
        code: js,
        dynamicImports: ['dynamic.js'],
        isEntry: true,
      } as unknown as OutputChunk,
      'style.css': {
        type: 'asset',
        source: css,
      } as OutputAsset,
      'dynamic.js': {
        type: 'chunk',
        fileName: 'dynamic.js',
        code: dyn,
        dynamicImports: [],
        isEntry: false,
      } as unknown as OutputChunk,
    }

    ;(plugin.generateBundle as any)?.({}, bundle)

    const jsHash = integrity(js, 'sha256')
    const cssHash = integrity(css, 'sha256')

    const html = bundle['index.html'] as OutputAsset
    expect(html.source as string).toContain(
      `<script src="/foo/main.js" integrity="${jsHash}" crossorigin="use-credentials"></script>`,
    )
    expect(html.source as string).toContain(
      `<link rel="stylesheet" href="/foo/style.css" integrity="${cssHash}" crossorigin="use-credentials">`,
    )
    expect(html.source as string).not.toContain('modulepreload')

    const rendered = (plugin.renderChunk as any)?.(js, {
      isEntry: true,
      fileName: 'main.js',
    })
    expect(rendered).toBeNull()
  })
})

