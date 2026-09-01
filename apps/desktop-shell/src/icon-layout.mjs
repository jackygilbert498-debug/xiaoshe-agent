export function alphaBounds(bitmap, width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError('icon dimensions must be positive integers')
  }
  if (!(bitmap instanceof Uint8Array) || bitmap.length < width * height * 4) {
    throw new TypeError('icon bitmap must contain four bytes per pixel')
  }

  let left = width; let top = height; let right = -1; let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (bitmap[(y * width + x) * 4 + 3] === 0) continue
      left = Math.min(left, x); top = Math.min(top, y)
      right = Math.max(right, x); bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) throw new Error('icon bitmap has no visible pixels')
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

export function fittedWidth(bounds, targetHeight) {
  if (!Number.isInteger(targetHeight) || targetHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) {
    throw new TypeError('icon bounds and target height must be positive')
  }
  return Math.max(1, Math.round(bounds.width * targetHeight / bounds.height))
}
