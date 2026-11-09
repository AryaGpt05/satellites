/** Test helper: a .npy file (version 1.0, little-endian, C order) as titiler writes it. */
export function makeNpy(shape: number[], descr: '|u1' | '<u2' | '<f4', values: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`
  const pad = 64 - ((10 + header.length + 1) % 64)
  header += ' '.repeat(pad % 64) + '\n'
  const n = shape.reduce((a, b) => a * b, 1)
  const Arr = descr === '|u1' ? Uint8Array : descr === '<u2' ? Uint16Array : Float32Array
  const data = new Arr(n)
  for (let i = 0; i < n; i++) data[i] = values[i] ?? 0
  const out = new Uint8Array(10 + header.length + data.byteLength)
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, header.length & 0xff, header.length >> 8])
  for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i)
  out.set(new Uint8Array(data.buffer), 10 + header.length)
  return out
}

/** A mask npy (class band + validity band) of w × h with `cls(x, y)` as the class value. */
export function maskNpy(w: number, h: number, cls: (x: number, y: number) => number, valid: (x: number, y: number) => boolean = () => true): Uint8Array<ArrayBuffer> {
  const v = new Array<number>(2 * w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      v[y * w + x] = cls(x, y)
      v[w * h + y * w + x] = valid(x, y) ? 255 : 0
    }
  return makeNpy([2, h, w], '<u2', v)
}
