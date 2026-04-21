/**
 * Encode a mono `Float32Array` of PCM samples (range -1…1) into a 16-bit
 * signed little-endian WAV `Blob`.
 *
 * The VAD callback gives us exactly this shape — Float32 mono at 16 kHz —
 * and Scribe's `pcm_s16le_16` fast-path expects 16-bit LE PCM in a WAV
 * container at 16 kHz, so encoding happens once at the boundary.
 *
 * Before:
 * - Float32Array[N] of samples in [-1, 1]
 *
 * After:
 * - WAV Blob: 44-byte RIFF header + 2·N bytes of int16 PCM
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const byteLength = 44 + samples.length * 2
  const buffer = new ArrayBuffer(byteLength)
  const view = new DataView(buffer)

  // RIFF header
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, byteLength - 8, true) // file size - 8
  writeAscii(view, 8, 'WAVE')

  // fmt chunk
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true)  // PCM format
  view.setUint16(22, 1, true)  // 1 channel (mono)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate: sampleRate * blockAlign
  view.setUint16(32, 2, true)  // block align: channels * bytesPerSample
  view.setUint16(34, 16, true) // bits per sample

  // data chunk
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  // PCM samples, clamped to int16 range
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, ascii: string) {
  for (let i = 0; i < ascii.length; i++) {
    view.setUint8(offset + i, ascii.charCodeAt(i))
  }
}
