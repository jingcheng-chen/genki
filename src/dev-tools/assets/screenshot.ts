import type { WebGLRenderer } from 'three'

/**
 * Module singleton holding the active WebGLRenderer. The R3F Canvas registers
 * its renderer here via `<ScreenshotBridge />` (in PreviewPane), and the
 * Transport's "save PNG" button reads it via `captureScreenshot`.
 *
 * Same pattern as `setActiveAnimationController` in
 * src/vrm/animation-controller.ts — a bridge between R3F's reactive scope
 * and the DOM-side controls outside the Canvas.
 */

let activeRenderer: WebGLRenderer | null = null

export function setActiveScreenshotRenderer(r: WebGLRenderer | null) {
  activeRenderer = r
}

/**
 * Save the current rendered frame to disk as PNG. Resolves once the download
 * dialog is triggered (the bytes are encoded synchronously by the browser).
 *
 * Relies on the renderer being created with `preserveDrawingBuffer: true`,
 * `alpha: true`, and `premultipliedAlpha: false` — see PreviewPane's Canvas
 * `gl` prop — otherwise the captured image is either blank or has muddied
 * alpha at translucent edges.
 */
export async function captureScreenshot(filename: string): Promise<boolean> {
  const r = activeRenderer
  if (!r) return false
  const canvas = r.domElement
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(false)
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Revoke on next tick so Safari/Firefox have a chance to start the
      // download before the URL is invalidated.
      setTimeout(() => URL.revokeObjectURL(url), 0)
      resolve(true)
    }, 'image/png')
  })
}

export function makeScreenshotFilename(
  vrmUrl: string | null,
  animationUrl: string | null,
): string {
  const character = vrmUrl?.match(/\/vrm\/([^/]+)\//)?.[1] ?? 'character'
  const animName =
    animationUrl?.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'pose'
  // Local time, filesystem-safe — sortable, unambiguous, no colons.
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  return `${character}_${animName}_${ts}.png`
}
