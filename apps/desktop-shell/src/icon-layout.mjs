import { join } from 'node:path'

const BASE_APPLICATION_ID = 'com.xiaoshe.desktop'
// Windows caches taskbar artwork by AppUserModelID even after the executable
// and every ICO frame change. This one-time identity revision makes the
// enlarged approved mark observable; keep it stable until the artwork changes.
const WINDOWS_APPLICATION_ID = 'com.xiaoshe.desktop.icon-v4'

export function applicationUserModelId(platform) {
  return platform === 'win32' ? WINDOWS_APPLICATION_ID : BASE_APPLICATION_ID
}

/** Windows taskbar artwork needs less outer padding than the macOS Dock tile. */
export function appIconPath({ platform, size, productRoot, desktopRoot }) {
  if (platform === 'win32') return join(desktopRoot, 'src', 'assets', `app-icon-win-${size}.png`)
  return join(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'assets', `app-icon-${size}.png`)
}

/**
 * Assign the reviewed artwork to the actual window as well as the executable.
 * Windows can otherwise retain a stale taskbar bitmap for the application
 * identity even though the executable contains the new multi-resolution ICO.
 */
export function browserWindowIconOptions({ platform, packaged, icon }) {
  return { icon }
}

/** Windows needs explicit white pixels; macOS applies its own template tint. */
export function trayImagePaths({ platform, productRoot, desktopRoot }) {
  if (platform === 'win32') {
    return {
      standard: join(desktopRoot, 'src', 'assets', 'tray-white-32.png'),
      retina: join(desktopRoot, 'src', 'assets', 'tray-white-64.png'),
    }
  }
  const assets = join(productRoot, 'runtime', 'xiaoshe-legacy', 'ui', 'assets')
  return { standard: join(assets, 'icon-16.png'), retina: join(assets, 'icon-32.png') }
}

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

export function trayHeightForDisplay(display, fallback = 15) {
  if (!Number.isInteger(fallback) || fallback <= 0) throw new TypeError('fallback tray height must be a positive integer')
  const boundsY = display?.bounds?.y
  const workAreaY = display?.workArea?.y
  if (!Number.isFinite(boundsY) || !Number.isFinite(workAreaY)) return fallback

  // On macOS the top work-area inset is the menu-bar height in DIP. Deriving
  // from that system geometry adapts to display scaling and notched screens;
  // bounded output prevents a transient or unusual work area from oversizing
  // the status item. Auto-hidden menu bars report no usable inset, so retain
  // the reviewed 15pt baseline in that case.
  const menuBarHeight = workAreaY - boundsY
  if (menuBarHeight < 16 || menuBarHeight > 80) return fallback
  return Math.min(17, Math.max(14, Math.round(menuBarHeight * 0.625)))
}
