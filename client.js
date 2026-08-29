// Browser half of the Xiaoshe DSH Bundle. Kept dependency-light so the
// external package can ride DSH's dynamic client module protocol directly.
window.__ModuleLoader__.load({
  id: '@xiaoshe/dsh-desktop-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var XIAOSHE_THEME_ID = 'xiaoshe-product-theme-v1'
    var XIAOSHE_MARK_URL = '/xiaoshe/brand/favicon.svg?v=0.2.0'

    // This is decorative line work, not a second logo. The approved snake.svg
    // remains the only source for every Xiaoshe brand mark.
    var XIAOSHE_RIBBON_SVG_NS = 'http://www.w3.org/2000/svg'
    var XIAOSHE_RIBBON_SAMPLE_COUNT = 104
    var XIAOSHE_RIBBON_LANE_COUNT = 17
    var XIAOSHE_RIBBON_DURATION_MS = 11000
    var XIAOSHE_RIBBON_FRAME_INTERVAL_MS = 1000 / 24
    var XIAOSHE_RIBBON_CENTER_Y = 380
    var XIAOSHE_RIBBON_BODY_SPAN_X = 1080
    // Archived for later visual experiments. Keep the renderer dormant in the
    // product shell so the empty conversation remains lightweight.
    var XIAOSHE_RIBBON_BACKGROUND_ENABLED = false

    function xiaosheRibbonMaterialPoint(value, phase) {
      var t = Math.max(0, Math.min(1, value))
      // The body bends as one continuous S, with a gentle secondary wave that
      // rounds the reversals instead of introducing short, angular corners.
      // Every material point still crosses the field after half a cycle; the
      // SVG itself remains fixed in place.
      var localPhase = phase + 0.30 * (t - 0.5)
      var base = 226 * Math.sin(2 * Math.PI * (t - 0.18))
        + 24 * Math.cos(Math.PI * (t + 0.1))
        + 26 * Math.sin(4 * Math.PI * (t + 0.03))
      var cross = 197 * Math.cos(Math.PI * (t - 0.03))
      var arc = 52 * Math.sin(Math.PI * (t - 0.08))
        + 19 * Math.cos(2 * Math.PI * (t + 0.15))
      return {
        x: 500 - XIAOSHE_RIBBON_BODY_SPAN_X / 2
          + XIAOSHE_RIBBON_BODY_SPAN_X * t
          + arc * Math.sin(phase),
        y: XIAOSHE_RIBBON_CENTER_Y
          + base * Math.cos(localPhase)
          + cross * Math.sin(localPhase),
      }
    }

    function xiaosheRibbonCenterlineAt(phase) {
      var points = []
      var meanX = 0
      var meanY = 0
      for (var index = 0; index <= XIAOSHE_RIBBON_SAMPLE_COUNT; index += 1) {
        var point = xiaosheRibbonMaterialPoint(index / XIAOSHE_RIBBON_SAMPLE_COUNT, phase)
        points.push(point)
        meanX += point.x
        meanY += point.y
      }
      meanX /= points.length
      meanY /= points.length
      var shiftX = 500 - meanX
      var shiftY = XIAOSHE_RIBBON_CENTER_Y - meanY
      var frames = points.map(function (point, index) {
        var before = points[Math.max(0, index - 1)]
        var after = points[Math.min(points.length - 1, index + 1)]
        var dx = after.x - before.x
        var dy = after.y - before.y
        var length = Math.hypot(dx, dy) || 1
        return {
          t: index / XIAOSHE_RIBBON_SAMPLE_COUNT,
          x: point.x + shiftX,
          y: point.y + shiftY,
          tx: dx / length,
          ty: dy / length,
          nx: -dy / length,
          ny: dx / length,
        }
      })

      // A broad orientation field follows every reversal continuously. This
      // avoids selecting two discrete peak indexes, which made the width pop
      // whenever neighbouring samples exchanged rank between animation frames.
      var orientation = frames.map(function (frame) { return Math.abs(frame.tx) })
      var bendRadius = 28
      var bendSigma = 14.3
      var smoothOrientation = orientation.map(function (_value, index) {
        var weighted = 0
        var totalWeight = 0
        for (var offset = -bendRadius; offset <= bendRadius; offset += 1) {
          var sourceIndex = Math.max(0, Math.min(frames.length - 1, index + offset))
          var distance = offset / bendSigma
          var weight = Math.exp(-0.5 * distance * distance)
          weighted += orientation[sourceIndex] * weight
          totalWeight += weight
        }
        return weighted / totalWeight
      })
      var minimumOrientation = Math.min.apply(null, smoothOrientation)
      var maximumOrientation = Math.max.apply(null, smoothOrientation)
      var orientationRange = maximumOrientation - minimumOrientation || 1
      frames.forEach(function (frame, index) {
        var normalized = (smoothOrientation[index] - minimumOrientation) / orientationRange
        frame.bendWeight = Math.pow(Math.max(0, Math.min(1, normalized)), 0.70)
      })
      return frames
    }

    function xiaosheRibbonWidthAt(frame) {
      // Reversals reach up to 1.7 times the ordinary body width through a continuous
      // field, so the transition stays rounded in both space and time.
      var bendWeight = Math.max(0, Math.min(1, frame.bendWeight || 0))
      return 23.5 * (1 + 0.70 * bendWeight)
    }

    function xiaosheRibbonPath(lane, centerline) {
      return centerline.map(function (frame, index) {
        var offset = lane * xiaosheRibbonWidthAt(frame)
        var x = frame.x + frame.nx * offset
        var y = frame.y + frame.ny * offset
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
      }).join(' ')
    }

    function xiaosheRibbonElement(name, attributes) {
      var node = document.createElementNS(XIAOSHE_RIBBON_SVG_NS, name)
      Object.keys(attributes || {}).forEach(function (key) {
        node.setAttribute(key, attributes[key])
      })
      return node
    }

    function xiaosheRibbonGradient(id, stops) {
      var gradient = xiaosheRibbonElement('radialGradient', { id: id })
      stops.forEach(function (stop) {
        gradient.appendChild(xiaosheRibbonElement('stop', {
          offset: stop[0],
          'stop-color': stop[1],
          'stop-opacity': stop[2],
        }))
      })
      return gradient
    }

    function createXiaosheRibbonSvg() {
      var svg = xiaosheRibbonElement('svg', {
        'data-xiaoshe-ribbon-field': '',
        viewBox: '0 0 1000 560',
        preserveAspectRatio: 'none',
        'aria-hidden': 'true',
      })
      var defs = xiaosheRibbonElement('defs')
      var lineGradient = xiaosheRibbonElement('linearGradient', {
        id: 'xiaoshe-ribbon-line',
        x1: '0',
        y1: '0',
        x2: '1000',
        y2: '0',
        gradientUnits: 'userSpaceOnUse',
      })
      ;[
        ['0', 'var(--xiaoshe-jade)', '0'],
        ['.10', 'var(--xiaoshe-jade)', '.19'],
        ['.34', 'var(--xiaoshe-jade)', '.40'],
        ['.63', 'var(--xiaoshe-jade)', '.31'],
        ['.85', 'var(--xiaoshe-champagne)', '.19'],
        ['1', 'var(--xiaoshe-champagne)', '0'],
      ].forEach(function (stop) {
        lineGradient.appendChild(xiaosheRibbonElement('stop', {
          offset: stop[0],
          'stop-color': stop[1],
          'stop-opacity': stop[2],
        }))
      })
      defs.appendChild(lineGradient)
      defs.appendChild(xiaosheRibbonGradient('xiaoshe-ribbon-focus-a', [
        ['0', 'white', '.95'], ['.46', 'white', '.52'], ['1', 'white', '0'],
      ]))
      defs.appendChild(xiaosheRibbonGradient('xiaoshe-ribbon-focus-b', [
        ['0', 'white', '.70'], ['.54', 'white', '.28'], ['1', 'white', '0'],
      ]))
      var veil = xiaosheRibbonElement('filter', {
        id: 'xiaoshe-ribbon-veil', x: '-12%', y: '-18%', width: '124%', height: '136%',
      })
      veil.appendChild(xiaosheRibbonElement('feGaussianBlur', { stdDeviation: '1' }))
      defs.appendChild(veil)
      var soft = xiaosheRibbonElement('filter', {
        id: 'xiaoshe-ribbon-soft', x: '-26%', y: '-40%', width: '152%', height: '180%',
      })
      soft.appendChild(xiaosheRibbonElement('feGaussianBlur', { stdDeviation: '20' }))
      defs.appendChild(soft)
      var haze = xiaosheRibbonElement('filter', {
        id: 'xiaoshe-ribbon-haze', x: '-48%', y: '-70%', width: '196%', height: '240%',
      })
      haze.appendChild(xiaosheRibbonElement('feGaussianBlur', { stdDeviation: '55' }))
      defs.appendChild(haze)
      var mask = xiaosheRibbonElement('mask', { id: 'xiaoshe-ribbon-focus' })
      mask.appendChild(xiaosheRibbonElement('rect', { width: '1000', height: '560', fill: 'black' }))
      ;[
        ['185', '230', '165', '82', 'xiaoshe-ribbon-focus-a', '-24'],
        ['458', '470', '158', '78', 'xiaoshe-ribbon-focus-b', '-17'],
        ['712', '188', '168', '79', 'xiaoshe-ribbon-focus-a', '12'],
        ['900', '390', '144', '68', 'xiaoshe-ribbon-focus-b', '22'],
      ].forEach(function (focus) {
        mask.appendChild(xiaosheRibbonElement('ellipse', {
          cx: focus[0], cy: focus[1], rx: focus[2], ry: focus[3],
          fill: `url(#${focus[4]})`,
          transform: `rotate(${focus[5]} ${focus[0]} ${focus[1]})`,
        }))
      })
      defs.appendChild(mask)

      var paths = []
      var initialCenterline = xiaosheRibbonCenterlineAt(0)
      for (var laneIndex = 0; laneIndex < XIAOSHE_RIBBON_LANE_COUNT; laneIndex += 1) {
        var lane = -1 + (2 * laneIndex) / (XIAOSHE_RIBBON_LANE_COUNT - 1)
        var path = xiaosheRibbonElement('path', {
          id: `xiaoshe-ribbon-lane-${laneIndex}`,
          'data-xiaoshe-ribbon-lane': String(lane),
          d: xiaosheRibbonPath(lane, initialCenterline),
        })
        paths.push(path)
        defs.appendChild(path)
      }
      svg.appendChild(defs)
      ;[
        { width: '1.04', opacity: '.24', filter: 'url(#xiaoshe-ribbon-haze)' },
        { width: '.84', opacity: '.42', filter: 'url(#xiaoshe-ribbon-soft)' },
        { width: '.66', opacity: '.58', filter: 'url(#xiaoshe-ribbon-veil)', mask: 'url(#xiaoshe-ribbon-focus)' },
      ].forEach(function (layer) {
        var group = xiaosheRibbonElement('g', {
          fill: 'none',
          stroke: 'url(#xiaoshe-ribbon-line)',
          'stroke-width': layer.width,
          'stroke-linecap': 'round',
          opacity: layer.opacity,
        })
        if (layer.filter) group.setAttribute('filter', layer.filter)
        if (layer.mask) group.setAttribute('mask', layer.mask)
        paths.forEach(function (path) {
          group.appendChild(xiaosheRibbonElement('use', { href: `#${path.id}` }))
        })
        svg.appendChild(group)
      })
      svg.__xiaosheRibbonPaths = paths
      return svg
    }

    function drawXiaosheRibbon(svg, phase) {
      var centerline = xiaosheRibbonCenterlineAt(phase)
      ;(svg.__xiaosheRibbonPaths || []).forEach(function (path) {
        var lane = Number(path.getAttribute('data-xiaoshe-ribbon-lane'))
        path.setAttribute('d', xiaosheRibbonPath(lane, centerline))
      })
    }

    function mountXiaosheRibbonMotion() {
      var svg = null
      var animationFrame = 0
      var startTime = globalThis.performance?.now?.() || Date.now()
      var nextDrawTime = startTime + XIAOSHE_RIBBON_FRAME_INTERVAL_MS
      var reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') || null

      function stopAnimation() {
        if (animationFrame !== 0) globalThis.cancelAnimationFrame?.(animationFrame)
        animationFrame = 0
      }

      function animate(now) {
        if (svg === null || !svg.isConnected || reducedMotion?.matches === true) {
          animationFrame = 0
          return
        }
        if (now + 0.01 >= nextDrawTime) {
          var elapsed = now - startTime
          drawXiaosheRibbon(svg, elapsed * (2 * Math.PI / XIAOSHE_RIBBON_DURATION_MS))
          var elapsedIntervals = Math.floor((now - nextDrawTime) / XIAOSHE_RIBBON_FRAME_INTERVAL_MS) + 1
          nextDrawTime += Math.max(1, elapsedIntervals) * XIAOSHE_RIBBON_FRAME_INTERVAL_MS
        }
        animationFrame = globalThis.requestAnimationFrame(animate)
      }

      function startAnimation() {
        stopAnimation()
        if (svg === null) return
        drawXiaosheRibbon(svg, 0)
        startTime = globalThis.performance?.now?.() || Date.now()
        nextDrawTime = startTime + XIAOSHE_RIBBON_FRAME_INTERVAL_MS
        if (reducedMotion?.matches !== true) {
          animationFrame = globalThis.requestAnimationFrame(animate)
        }
      }

      function syncRibbon() {
        var stage = document.querySelector?.("[data-phase='hero'] [data-conversation-scroll]") || null
        if (svg !== null && svg.parentElement === stage) return
        stopAnimation()
        svg?.remove()
        svg = null
        if (stage === null) return
        svg = createXiaosheRibbonSvg()
        stage.insertBefore(svg, stage.firstChild)
        startAnimation()
      }

      function handleMotionPreference() {
        startAnimation()
      }

      syncRibbon()
      var observer = typeof MutationObserver === 'function'
        ? new MutationObserver(syncRibbon)
        : null
      observer?.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-phase'],
      })
      reducedMotion?.addEventListener?.('change', handleMotionPreference)

      return function unmountXiaosheRibbonMotion() {
        observer?.disconnect()
        reducedMotion?.removeEventListener?.('change', handleMotionPreference)
        stopAnimation()
        svg?.remove()
        svg = null
      }
    }

    var XIAOSHE_THEME_CSS = String.raw`
body[data-xiaoshe-shell] {
  --xiaoshe-jade: #5f7d6e;
  --xiaoshe-jade-deep: #345444;
  --xiaoshe-champagne: #c5a95f;
  --xiaoshe-stage: #ffffff;
  --xiaoshe-rail: #f8faf8;
  --xiaoshe-card: #ffffff;
  --xiaoshe-card-hover: #f1f4f2;
  --xiaoshe-line: rgba(27, 29, 28, 0.08);
  --xiaoshe-line-strong: rgba(27, 29, 28, 0.14);
  --xiaoshe-ink: #1b1d1c;
  --xiaoshe-ink-2: #555b57;
  --xiaoshe-ink-3: #7c8580;
  --xiaoshe-sheen-1: #23362d;
  --xiaoshe-sheen-2: #4f8069;
  --xiaoshe-sheen-3: #9cc2b1;
  --xiaoshe-sheen-4: #d7c27f;
  --xiaoshe-active-mark-opacity: 0.055;
  --xiaoshe-inspector-width: 300px;
  --xiaoshe-hero-balance-shift: clamp(24px, 3.2vh, 52px);
  --xiaoshe-focus: color-mix(in srgb, var(--xiaoshe-jade) 78%, var(--xiaoshe-champagne));
  --xiaoshe-focus-glow: color-mix(in srgb, var(--xiaoshe-jade) 18%, transparent);
  --dsw-alias-bg-base: var(--xiaoshe-stage);
  --dsw-alias-bg-layer-1: var(--xiaoshe-rail);
  --dsw-alias-bg-layer-2: var(--xiaoshe-card);
  --dsw-alias-bg-layer-3: var(--xiaoshe-card-hover);
  --dsw-specific-sidebar-fill: var(--xiaoshe-rail);
  --dsw-specific-input-major: color-mix(in srgb, var(--xiaoshe-card) 94%, var(--xiaoshe-jade) 6%);
  --dsw-specific-selector: color-mix(in srgb, var(--xiaoshe-jade) 10%, transparent);
  --dsw-alias-border-l1: var(--xiaoshe-line);
  --dsw-alias-border-l2: var(--xiaoshe-line-strong);
  --dsw-alias-border-l2-darkmode-thin: var(--xiaoshe-line-strong);
  --dsw-alias-border-l3: color-mix(in srgb, var(--xiaoshe-jade) 40%, transparent);
  --dsw-alias-label-primary: var(--xiaoshe-ink);
  --dsw-alias-label-secondary: var(--xiaoshe-ink-2);
  --dsw-alias-label-tertiary: var(--xiaoshe-ink-3);
  --dsw-alias-label-caption: #929a95;
  --dsw-alias-state-business-primary: var(--xiaoshe-jade-deep);
  --dsw-alias-state-business-tertiary: color-mix(in srgb, var(--xiaoshe-jade) 14%, transparent);
  --dsw-alias-button-primary-fill: #202321;
  --dsw-alias-button-primary-hover: #111412;
  --dsw-alias-button-elevated-fill: var(--xiaoshe-card);
  --dsw-alias-button-floating-fill: var(--xiaoshe-card);
  --dsw-alias-button-floating-hover: var(--xiaoshe-card-hover);
  --dsw-alias-interactive-bg-hover: color-mix(in srgb, var(--xiaoshe-jade) 8%, transparent);
  --dsw-alias-interactive-bg-hover-solid: color-mix(in srgb, var(--xiaoshe-jade) 13%, var(--xiaoshe-stage));
  --dsw-specific-sidebar-nav-item-active: color-mix(in srgb, var(--xiaoshe-jade) 12%, transparent);
  --dsw-specific-sidebar-nav-item-active-accent: var(--xiaoshe-jade-deep);
  --dsw-shadow-lv1: 0 1px 2px rgba(16, 24, 20, 0.04);
  --dsw-shadow-lv2: 0 12px 34px rgba(31, 48, 39, 0.10), 0 2px 8px rgba(31, 48, 39, 0.05);
  --dsw-shadow-lv3: 0 24px 64px rgba(20, 35, 27, 0.16);
  --dsw-font-family: Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--xiaoshe-stage);
  color: var(--xiaoshe-ink);
}

body[data-xiaoshe-shell][data-ds-dark-theme] {
  --xiaoshe-jade: #86aa96;
  --xiaoshe-jade-deep: #b6d4c3;
  --xiaoshe-champagne: #dbc788;
  --xiaoshe-stage: #0f1311;
  --xiaoshe-rail: #151a17;
  --xiaoshe-card: #191d1b;
  --xiaoshe-card-hover: #202522;
  --xiaoshe-line: rgba(255, 255, 255, 0.08);
  --xiaoshe-line-strong: rgba(255, 255, 255, 0.14);
  --xiaoshe-ink: #eef0ee;
  --xiaoshe-ink-2: #acb2ae;
  --xiaoshe-ink-3: #747d78;
  --xiaoshe-sheen-1: #f0f4f1;
  --xiaoshe-sheen-2: #a7d6bf;
  --xiaoshe-sheen-3: #5fa17f;
  --xiaoshe-sheen-4: #dbc788;
  --xiaoshe-active-mark-opacity: 0.075;
  --dsw-alias-label-caption: #737b76;
  --dsw-alias-button-primary-fill: #d7dad7;
  --dsw-alias-button-primary-hover: #eef0ee;
  --dsw-alias-button-elevated-fill: #1b211d;
  --dsw-alias-button-floating-fill: #202622;
  --dsw-alias-button-floating-hover: #28302b;
  --dsw-shadow-lv1: 0 1px 2px rgba(0, 0, 0, 0.38);
  --dsw-shadow-lv2: 0 16px 42px rgba(0, 0, 0, 0.38), 0 2px 8px rgba(0, 0, 0, 0.30);
  --dsw-shadow-lv3: 0 28px 72px rgba(0, 0, 0, 0.56);
}

/* DSH leaves several shell/chip buttons on the browser's default blue focus
   ring. Xiaoshe keeps the keyboard affordance, but owns its color and shape;
   pointer focus stays quiet so clicks do not leave a persistent blue box. */
body[data-xiaoshe-shell] :where(button, [role='button']):focus {
  outline: none;
}

body[data-xiaoshe-shell] :where(button, [role='button']):focus-visible {
  outline: 1px solid var(--xiaoshe-focus);
  outline-offset: 2px;
  box-shadow: 0 0 0 3px var(--xiaoshe-focus-glow);
}

body[data-xiaoshe-shell] [data-composer-card] :where(button, [role='button']):focus-visible {
  outline-offset: 1px;
}

body[data-xiaoshe-shell] [data-slot='root'] {
  background: var(--xiaoshe-stage);
}

body[data-xiaoshe-shell] [data-slot='sidebar'] {
  background:
    radial-gradient(120% 40% at 0% 0%, color-mix(in srgb, var(--xiaoshe-jade) 9%, transparent), transparent 70%),
    var(--xiaoshe-rail);
}

body[data-xiaoshe-shell] [data-slot='sidebar.brand.name'] {
  min-width: 0;
  display: flex;
  align-items: center;
  overflow: visible;
}

body[data-xiaoshe-shell] [data-xiaoshe-brand-mark] {
  background: linear-gradient(135deg,
    var(--xiaoshe-sheen-1) 0%, var(--xiaoshe-sheen-2) 42%,
    var(--xiaoshe-sheen-3) 72%, var(--xiaoshe-sheen-4) 100%);
  filter: drop-shadow(0 4px 9px color-mix(in srgb, var(--xiaoshe-jade) 22%, transparent));
}

body[data-xiaoshe-shell] [data-slot='sidebar.brand.mark'] [data-xiaoshe-brand-mark] {
  width: 36px !important;
  height: 36px !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-brand-name] {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 0;
  line-height: 1;
  text-align: left;
  min-height: 52px;
  padding: 7px 0 4px;
  overflow: visible;
}

body[data-xiaoshe-shell] [data-xiaoshe-brand-title] {
  display: block;
  color: var(--xiaoshe-ink);
  font-family: "Noto Serif SC", "Songti SC", serif;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.025em;
  line-height: 1.6;
  padding: 6px 0 1px;
}

body[data-xiaoshe-shell] [data-xiaoshe-brand-subtitle] {
  overflow: hidden;
  color: var(--xiaoshe-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.105em;
  line-height: 1.1;
  margin-top: 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Recover the legacy session-tree rhythm without replacing DSH's tree. The
   selected row keeps its native semantics and receives Xiaoshe's jade rail. */
body[data-xiaoshe-shell] [data-slot='sidebar'] [role='treeitem'] {
  position: relative;
}

body[data-xiaoshe-shell] [data-slot='sidebar'] [role='treeitem'][aria-selected='true'] {
  background:
    linear-gradient(90deg,
      color-mix(in srgb, var(--xiaoshe-jade) 14%, transparent),
      color-mix(in srgb, var(--xiaoshe-jade) 6%, transparent)) !important;
  box-shadow: inset 2px 0 0 var(--xiaoshe-jade);
}

body[data-xiaoshe-shell] [data-slot='sidebar'] :is(
  button[aria-label='收起侧边栏'],
  button[aria-label='打开侧边栏'],
  button[aria-label='Collapse sidebar'],
  button[aria-label='Open sidebar']
) {
  border-radius: 9px;
  transition: color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
}

body[data-xiaoshe-shell] [data-slot='sidebar'] :is(
  button[aria-label='收起侧边栏'],
  button[aria-label='打开侧边栏'],
  button[aria-label='Collapse sidebar'],
  button[aria-label='Open sidebar']
):hover {
  background: color-mix(in srgb, var(--xiaoshe-jade) 11%, transparent);
  color: var(--xiaoshe-jade-deep);
}

/* Keep the DSH frame as the layout owner. The Xiaoshe inspector rides the
   additive shell overlay and reserves its own product column on wide screens. */
body[data-xiaoshe-shell] [data-slot='root'] > div {
  box-sizing: border-box;
  padding-right: var(--xiaoshe-inspector-width, 300px);
  transition: padding-right 180ms ease;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-host] {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-header] {
  position: absolute;
  top: 0;
  right: var(--xiaoshe-inspector-width, 300px);
  left: var(--xiaoshe-sidebar-width, 248px);
  z-index: 1;
  display: flex;
  min-width: 0;
  height: 140px;
  box-sizing: border-box;
  align-items: center;
  justify-content: space-between;
  gap: 28px;
  padding: 22px 38px 20px;
  border-bottom: 1px solid var(--xiaoshe-line);
  background:
    linear-gradient(180deg,
      color-mix(in srgb, var(--xiaoshe-stage) 98%, var(--xiaoshe-jade) 2%),
      var(--xiaoshe-stage));
  color: var(--xiaoshe-ink);
  pointer-events: none;
  transition: left 180ms ease, right 180ms ease;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-header][data-visible='false'] {
  display: none;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-heading] {
  min-width: 0;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-title] {
  margin: 0 0 9px;
  font-family: "Noto Serif SC", "Songti SC", serif;
  font-size: clamp(28px, 2.4vw, 40px);
  font-weight: 750;
  letter-spacing: -0.04em;
  line-height: 1.1;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-meta],
body[data-xiaoshe-shell] [data-xiaoshe-stage-state] {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--xiaoshe-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-meta] > span,
body[data-xiaoshe-shell] [data-xiaoshe-stage-state] > span {
  overflow: hidden;
  text-overflow: ellipsis;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-state] {
  flex: none;
  justify-content: flex-end;
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-dot] {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--xiaoshe-jade);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--xiaoshe-jade) 10%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-stage-divider] {
  color: color-mix(in srgb, var(--xiaoshe-ink-3) 45%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector] {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--xiaoshe-inspector-width, 300px);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--xiaoshe-line);
  background:
    radial-gradient(115% 34% at 100% 0%, color-mix(in srgb, var(--xiaoshe-jade) 8%, transparent), transparent 72%),
    var(--xiaoshe-rail);
  color: var(--xiaoshe-ink);
  pointer-events: auto;
  transition: width 180ms ease, transform 180ms ease;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-head] {
  display: flex;
  min-height: 58px;
  box-sizing: border-box;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 18px 8px;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-title] {
  color: var(--xiaoshe-ink);
  font-family: "Noto Serif SC", "Songti SC", serif;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-actions] {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-live] {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--xiaoshe-ink-3);
  font-size: 11px;
  white-space: nowrap;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-live]::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--xiaoshe-jade);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--xiaoshe-jade) 12%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-live][data-state='loading']::before {
  background: var(--xiaoshe-ink-3);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--xiaoshe-ink-3) 10%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-live][data-state='error']::before {
  background: var(--xiaoshe-champagne);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--xiaoshe-champagne) 14%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-tabs] {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  min-height: 42px;
  margin: 0 14px;
  padding: 0;
  border-bottom: 1px solid var(--xiaoshe-line);
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-tabs] button {
  position: relative;
  border: 0;
  background: transparent;
  color: var(--xiaoshe-ink-3);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-tabs] button[aria-selected='true'] {
  color: var(--xiaoshe-jade-deep);
  font-weight: 650;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-tabs] button[aria-selected='true']::after {
  content: '';
  position: absolute;
  right: 22px;
  bottom: -1px;
  left: 22px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--xiaoshe-jade), var(--xiaoshe-champagne));
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-body] {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 20px 28px;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-phase='hero'] [data-xiaoshe-inspector-body] {
  overflow: hidden;
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-card] {
  overflow: hidden;
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 30%, var(--xiaoshe-line)) !important;
  background:
    radial-gradient(85% 130% at 0% 0%, color-mix(in srgb, var(--xiaoshe-jade) 9%, transparent), transparent 70%),
    linear-gradient(145deg,
      color-mix(in srgb, var(--xiaoshe-rail) 96%, var(--xiaoshe-champagne) 4%),
      var(--xiaoshe-rail)) !important;
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 6%, transparent),
    0 14px 34px color-mix(in srgb, var(--xiaoshe-jade-deep) 9%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-trigger] {
  position: relative;
  align-items: center;
  padding: 17px 18px !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-trigger]::before {
  content: '';
  width: 3px;
  align-self: stretch;
  flex: none;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--xiaoshe-jade), var(--xiaoshe-champagne));
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-trigger] > span:first-of-type {
  flex: 1;
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-trigger] > span:first-of-type > span:first-child {
  color: var(--xiaoshe-ink);
  font-family: "Noto Serif SC", "Songti SC", serif;
  font-size: 16px !important;
  letter-spacing: 0.035em;
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-body] {
  padding: 2px 18px 18px !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-summaries] {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-summary] {
  min-height: 78px;
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 20%, var(--xiaoshe-line)) !important;
  background: color-mix(in srgb, var(--xiaoshe-rail) 91%, var(--xiaoshe-jade) 9%);
}

body[data-xiaoshe-shell] [data-xiaoshe-response-style] {
  padding-top: 15px;
  border-top: 1px solid var(--xiaoshe-line);
}

body[data-xiaoshe-shell] [data-xiaoshe-runtime-badges] span {
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 24%, var(--xiaoshe-line)) !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-runtime-status] {
  padding: 12px 14px;
  border: 1px solid var(--xiaoshe-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--xiaoshe-rail) 94%, var(--xiaoshe-champagne) 6%);
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-switch] {
  border-top-color: color-mix(in srgb, var(--xiaoshe-jade) 18%, var(--xiaoshe-line)) !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-settings-probe] {
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 34%, var(--xiaoshe-line)) !important;
  background: linear-gradient(110deg,
    color-mix(in srgb, var(--xiaoshe-jade) 13%, var(--xiaoshe-rail)),
    color-mix(in srgb, var(--xiaoshe-champagne) 8%, var(--xiaoshe-rail))) !important;
}

@media (max-width: 1080px) {
  body[data-xiaoshe-shell] [data-xiaoshe-settings-summaries] {
    grid-template-columns: 1fr;
  }
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-section] {
  margin: 0;
  padding: 18px 0;
  border: 0;
  border-bottom: 1px solid var(--xiaoshe-line);
  background: transparent;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-section]:last-child {
  border-bottom: 0;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-section] h3 {
  margin: 0 0 11px;
  color: var(--xiaoshe-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.13em;
  line-height: 1.4;
  text-transform: uppercase;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-lead] {
  margin: 0 0 13px;
  color: var(--xiaoshe-ink);
  font-family: "Noto Serif SC", "Songti SC", serif;
  font-size: 21px;
  font-weight: 680;
  letter-spacing: -0.025em;
  line-height: 1.35;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-metrics] {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--xiaoshe-line);
  border-radius: 10px;
  background: var(--xiaoshe-line);
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-metric] {
  min-width: 0;
  padding: 10px 6px 9px;
  background: color-mix(in srgb, var(--xiaoshe-card) 98%, var(--xiaoshe-jade) 2%);
  text-align: center;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-metric] strong {
  display: block;
  margin-bottom: 2px;
  color: var(--xiaoshe-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 16px;
  font-weight: 650;
  line-height: 1.2;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-metric] span {
  display: block;
  overflow: hidden;
  color: var(--xiaoshe-ink-3);
  font-size: 9px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-row] {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  padding: 5px 0;
  color: var(--xiaoshe-ink-3);
  font-size: 12px;
  line-height: 1.45;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-row] > :last-child {
  color: var(--xiaoshe-ink-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  text-align: right;
  word-break: break-word;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-note] {
  margin: 0;
  color: var(--xiaoshe-ink-3);
  font-size: 12px;
  line-height: 1.65;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-dot] {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--xiaoshe-jade);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--xiaoshe-jade) 12%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-button] {
  display: inline-flex;
  min-height: 34px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  border: 1px solid var(--xiaoshe-line-strong);
  border-radius: 9px;
  background: var(--xiaoshe-card);
  color: var(--xiaoshe-ink-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-button]:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 45%, var(--xiaoshe-line-strong));
  background: color-mix(in srgb, var(--xiaoshe-card) 91%, var(--xiaoshe-jade) 9%);
  color: var(--xiaoshe-jade-deep);
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-button]:disabled {
  cursor: wait;
  opacity: 0.56;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-form] {
  display: grid;
  gap: 10px;
  padding: 13px;
  border: 1px solid color-mix(in srgb, var(--xiaoshe-jade) 18%, var(--xiaoshe-line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--xiaoshe-card) 97%, var(--xiaoshe-jade) 3%);
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-scope] {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--xiaoshe-line);
  border-radius: 9px;
  background: var(--xiaoshe-rail);
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-scope] button {
  min-height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--xiaoshe-ink-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-scope] button[aria-pressed='true'] {
  background: var(--xiaoshe-card);
  box-shadow: var(--dsw-shadow-lv1);
  color: var(--xiaoshe-ink);
  font-weight: 650;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-scope] button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-form] textarea {
  width: 100%;
  min-height: 76px;
  box-sizing: border-box;
  resize: vertical;
  padding: 9px 10px;
  border: 1px solid var(--xiaoshe-line-strong);
  border-radius: 9px;
  outline: 0;
  background: var(--xiaoshe-stage);
  color: var(--xiaoshe-ink);
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-form] textarea:focus-visible {
  border-color: var(--xiaoshe-focus);
  box-shadow: 0 0 0 3px var(--xiaoshe-focus-glow);
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-actions],
body[data-xiaoshe-shell] [data-xiaoshe-memory-item-actions] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-list] {
  display: grid;
  gap: 8px;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-item] {
  padding: 11px 12px 9px;
  border: 1px solid var(--xiaoshe-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--xiaoshe-card) 98%, var(--xiaoshe-jade) 2%);
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-item][data-state='forgotten'] {
  background: transparent;
  opacity: 0.72;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-text] {
  margin: 0 0 8px;
  color: var(--xiaoshe-ink-2);
  font-size: 12px;
  line-height: 1.58;
  white-space: pre-wrap;
  word-break: break-word;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-meta] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--xiaoshe-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-item-actions] button {
  min-height: 24px;
  padding: 0 6px;
  border: 0;
  background: transparent;
  color: var(--xiaoshe-ink-3);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-item-actions] button:hover:not(:disabled) {
  color: var(--xiaoshe-jade-deep);
}

body[data-xiaoshe-shell] [data-xiaoshe-memory-empty] {
  margin: 0;
  padding: 9px 0 2px;
  color: var(--xiaoshe-ink-3);
  font-size: 11px;
  line-height: 1.55;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-toggle],
body[data-xiaoshe-shell] [data-xiaoshe-inspector-close],
body[data-xiaoshe-shell] [data-xiaoshe-inspector-collapse] {
  border: 1px solid var(--xiaoshe-line-strong);
  background: var(--xiaoshe-card);
  color: var(--xiaoshe-ink-2);
  cursor: pointer;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-collapse] {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  border-radius: 9px;
}

body[data-xiaoshe-shell] [data-xiaoshe-panel-icon] {
  display: block;
  width: 18px;
  height: 18px;
  overflow: visible;
  transition: transform 180ms ease;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-rail-collapsed='true'] [data-xiaoshe-panel-icon] {
  transform: scaleX(-1);
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-collapse]:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--xiaoshe-jade) 10%, transparent);
  color: var(--xiaoshe-jade-deep);
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-toggle] {
  display: none;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-resizer] {
  position: absolute;
  top: 0;
  right: calc(var(--xiaoshe-inspector-width, 300px) - 6px);
  bottom: 0;
  z-index: 3;
  width: 12px;
  cursor: col-resize;
  pointer-events: auto;
  touch-action: none;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-resizer]::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 5px;
  width: 2px;
  height: 54px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--xiaoshe-jade) 34%, var(--xiaoshe-line-strong));
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity 140ms ease;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-resizer]:is(:hover, :focus-visible)::after,
body[data-xiaoshe-shell][data-xiaoshe-resizing='inspector'] [data-xiaoshe-inspector-resizer]::after {
  opacity: 1;
}

body[data-xiaoshe-shell][data-xiaoshe-resizing='inspector'] {
  cursor: col-resize;
  user-select: none;
}

body[data-xiaoshe-shell] [data-xiaoshe-active-mark] {
  position: absolute;
  right: calc(var(--xiaoshe-inspector-width, 300px) + 28px);
  bottom: 118px;
  z-index: 1;
  display: block;
  width: 300px;
  height: 300px;
  opacity: var(--xiaoshe-active-mark-opacity);
  pointer-events: none;
}

body[data-xiaoshe-shell] [data-xiaoshe-active-mark] [data-xiaoshe-hero-outline-mark] {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

body[data-xiaoshe-shell] [data-xiaoshe-inspector-close] {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 1;
  display: none;
  width: 30px;
  height: 30px;
  border-radius: 9px;
}

/* The Hero brand seat is the authorized Xiaoshe takeover. Hide only the two
   shipped copy siblings (headline + Preview), leaving workspace/composer live. */
body[data-xiaoshe-shell] [data-phase='hero'] span:has(> [data-slot='conversation.hero.brand.mark']) {
  grid-column: auto !important;
  width: auto !important;
  height: auto !important;
}

body[data-xiaoshe-shell] [data-phase='hero'] div:has(> span > [data-slot='conversation.hero.brand.mark']) {
  display: flex !important;
  grid-template-columns: none !important;
  justify-content: center !important;
  width: 100%;
}

body[data-xiaoshe-shell] [data-phase='hero'] [data-slot='conversation.hero.brand.mark'] {
  width: auto !important;
}

body[data-xiaoshe-shell] [data-phase='hero'] span:has(> [data-slot='conversation.hero.brand.mark']) ~ span {
  display: none !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-brand] {
  --xiaoshe-feature-track: min(420px, calc(100vw - 48px));
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 0;
  text-align: center;
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-kicker] {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--xiaoshe-jade-deep);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.16em;
  margin-bottom: 14px;
  text-transform: uppercase;
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-kicker]::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--xiaoshe-jade), var(--xiaoshe-champagne));
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--xiaoshe-jade) 10%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-title] {
  position: relative;
  display: flex;
  width: var(--xiaoshe-feature-track);
  min-width: 0;
  min-height: 90px;
  align-items: center;
  justify-content: center;
  isolation: isolate;
  margin-bottom: 12px;
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-word] {
  position: relative;
  z-index: 1;
  color: transparent;
  font-family: "Noto Serif SC", "Songti SC", serif;
  font-size: clamp(68px, 6.2vw, 94px);
  font-weight: 750;
  letter-spacing: -0.095em;
  line-height: 0.95;
  background: linear-gradient(115deg,
    var(--xiaoshe-sheen-1) 0%, var(--xiaoshe-sheen-2) 28%, var(--xiaoshe-sheen-3) 48%,
    var(--xiaoshe-sheen-4) 62%, var(--xiaoshe-sheen-2) 78%, var(--xiaoshe-sheen-1) 100%);
  background-size: 280% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  animation: stage-sheen 9s ease-in-out infinite;
  white-space: nowrap;
}

@keyframes stage-sheen {
  0%, 100% { background-position: 0% 0; }
  50% { background-position: 100% 0; }
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-description] {
  max-width: min(620px, calc(100vw - 48px));
  color: var(--xiaoshe-ink-3);
  font-size: 13px;
  font-weight: 450;
  letter-spacing: 0.012em;
  line-height: 1.7;
  text-align: center;
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-capabilities] {
  display: grid;
  width: var(--xiaoshe-feature-track);
  max-width: calc(100vw - 48px);
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 0;
  margin-top: 15px;
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-capability] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 17px;
  color: var(--xiaoshe-ink-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 560;
  letter-spacing: 0.055em;
  line-height: 1.5;
  white-space: nowrap;
}

body[data-xiaoshe-shell] [data-xiaoshe-hero-capability] + [data-xiaoshe-hero-capability] {
  border-left: 1px solid color-mix(in srgb, var(--xiaoshe-jade) 30%, var(--xiaoshe-line-strong));
}

/* The DSH composer and Hero intentionally share one persistent subtree. A
   relative offset preserves that identity and fixed-menu geometry while
   recreating the legacy composition: brand in the stage, work surface lower. */
body[data-xiaoshe-shell] [data-phase='hero'] [data-composer-seat] {
  position: relative;
  top: calc(clamp(94px, 12vh, 158px) + var(--xiaoshe-hero-balance-shift));
}

body[data-xiaoshe-shell] [data-phase='hero'] div:has(> span > [data-slot='conversation.hero.brand.mark']) {
  position: relative;
  top: calc(clamp(-156px, -12vh, -94px) + var(--xiaoshe-hero-balance-shift));
}

body[data-xiaoshe-shell] [data-conversation-scroll] {
  position: relative;
  isolation: isolate;
  background:
    radial-gradient(660px 330px at 51% 48%, color-mix(in srgb, var(--xiaoshe-jade) 6%, transparent), transparent 72%),
    var(--xiaoshe-stage);
}

/* DSH keeps the active transcript scrollable so its history remains usable.
   Before the first turn, however, the hero is a fixed viewport: anything that
   does not fit is intentionally clipped instead of creating a false scrollbar. */
body[data-xiaoshe-shell] [data-phase='hero'] [data-conversation-scroll] {
  overflow: hidden;
  background: var(--xiaoshe-stage);
  scrollbar-gutter: auto;
}

body[data-xiaoshe-shell] [data-phase='hero'] [data-conversation-scroll]::before {
  content: '';
  position: absolute;
  inset: -8% -7% -12%;
  z-index: 0;
  background:
    radial-gradient(ellipse 48% 36% at 50% 38%,
      color-mix(in srgb, var(--xiaoshe-stage) 12%, transparent),
      color-mix(in srgb, var(--xiaoshe-stage) 38%, transparent) 74%,
      color-mix(in srgb, var(--xiaoshe-stage) 62%, transparent) 100%),
    linear-gradient(180deg,
      color-mix(in srgb, var(--xiaoshe-stage) 2%, transparent),
      color-mix(in srgb, var(--xiaoshe-stage) 16%, transparent) 74%,
      color-mix(in srgb, var(--xiaoshe-stage) 48%, transparent)),
    radial-gradient(660px 330px at 51% 48%, color-mix(in srgb, var(--xiaoshe-jade) 6%, transparent), transparent 72%),
    var(--xiaoshe-stage);
  background-position: center, center, center, center;
  pointer-events: none;
}

body[data-xiaoshe-shell] [data-phase='hero'] [data-xiaoshe-ribbon-field] {
  position: absolute;
  inset: calc(-8% + 56px) -15% calc(-12% - 56px);
  z-index: 0;
  display: block;
  width: auto;
  height: auto;
  overflow: visible;
  pointer-events: none;
}

body[data-xiaoshe-shell] [data-phase='hero'] [data-conversation-scroll] > :not([data-xiaoshe-ribbon-field]) {
  position: relative;
  z-index: 1;
}

/* The host's blurred blue hero ellipse extends below its own scrollport and
   creates a real (but contentless) vertical range. Xiaoshe already paints its
   stage atmosphere on the scrollport, so remove only that exact decorative
   host asset instead of clipping the composer or disabling useful overflow. */
body[data-xiaoshe-shell] [data-phase='hero'] [data-composer-seat] svg[aria-hidden='true'][viewBox='0 0 1051 468'] {
  display: none;
}

body[data-xiaoshe-shell] [data-composer-seat] {
  --dsh-composer-card-max-width: 760px;
}

body[data-xiaoshe-shell] [data-phase='hero'] [data-composer-card] {
  border-color: var(--xiaoshe-line-strong) !important;
  background: color-mix(in srgb, var(--xiaoshe-card) 97%, var(--xiaoshe-jade) 3%);
  box-shadow: 0 18px 48px rgba(31, 48, 39, 0.12), 0 3px 10px rgba(31, 48, 39, 0.05);
  transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}

body[data-xiaoshe-shell] [data-phase='hero'] [data-composer-card]::after {
  display: none !important;
}

body[data-xiaoshe-shell] [data-phase='hero'] [data-composer-card]:hover {
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 46%, var(--xiaoshe-line-strong)) !important;
  box-shadow: 0 22px 56px rgba(31, 48, 39, 0.15), 0 4px 12px rgba(31, 48, 39, 0.06);
  transform: translateY(-1px);
}

body[data-xiaoshe-shell] [data-composer-card]:focus-within {
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 58%, var(--xiaoshe-line-strong)) !important;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--xiaoshe-jade) 11%, transparent), var(--dsw-shadow-lv2);
}

body[data-xiaoshe-shell] [data-composer-seat] textarea {
  caret-color: var(--xiaoshe-jade-deep) !important;
}

body[data-xiaoshe-shell] [data-composer-seat] button,
body[data-xiaoshe-shell] [data-composer-seat] select {
  transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease, transform 140ms ease;
}

/* Conversation chrome is deliberately quieter than the content. These
   attributes are attached to host controls at runtime so Xiaoshe can retain
   upstream behavior while replacing DSH's visual and product vocabulary. */
body[data-xiaoshe-shell] [data-xiaoshe-conversation-tabs] {
  gap: 22px !important;
  border-bottom-color: color-mix(in srgb, var(--xiaoshe-line) 82%, transparent) !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-conversation-tabs] button {
  min-height: 42px !important;
  padding: 0 1px !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  letter-spacing: 0.04em;
}

body[data-xiaoshe-shell] [data-xiaoshe-conversation-tabs] button[aria-selected='true'] {
  color: var(--xiaoshe-jade-deep) !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-task-record] {
  min-height: 38px !important;
  padding: 0 15px !important;
  border: 1px solid color-mix(in srgb, var(--xiaoshe-line-strong) 82%, transparent) !important;
  border-radius: 9px !important;
  background: color-mix(in srgb, var(--xiaoshe-card) 94%, transparent) !important;
  box-shadow: none !important;
  color: var(--xiaoshe-ink-soft) !important;
  font-family: var(--xiaoshe-font-sans) !important;
  font-weight: 560 !important;
  letter-spacing: 0.04em;
}

body[data-xiaoshe-shell] [data-xiaoshe-task-record]:hover {
  border-color: color-mix(in srgb, var(--xiaoshe-champagne) 48%, var(--xiaoshe-line-strong)) !important;
  color: var(--xiaoshe-ink) !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-auto-orchestration],
body[data-xiaoshe-shell] [data-xiaoshe-model-control],
body[data-xiaoshe-shell] [data-xiaoshe-permission-control] {
  border-radius: 8px !important;
  background: transparent !important;
  box-shadow: none !important;
  color: var(--xiaoshe-ink-soft) !important;
  letter-spacing: 0.015em;
}

body[data-xiaoshe-shell] [data-xiaoshe-auto-orchestration]:hover,
body[data-xiaoshe-shell] [data-xiaoshe-model-control]:hover,
body[data-xiaoshe-shell] [data-xiaoshe-permission-control]:hover {
  background: color-mix(in srgb, var(--xiaoshe-jade) 7%, transparent) !important;
  color: var(--xiaoshe-ink) !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-tool-card] {
  box-shadow: 0 8px 24px color-mix(in srgb, var(--xiaoshe-jade) 7%, transparent);
}

body[data-xiaoshe-shell] [data-xiaoshe-tool-card][data-state='running'] {
  border-color: color-mix(in srgb, var(--xiaoshe-champagne) 45%, var(--xiaoshe-line-strong)) !important;
}

body[data-xiaoshe-shell] [data-xiaoshe-tool-card][data-state='completed'] {
  border-color: color-mix(in srgb, var(--xiaoshe-jade) 42%, var(--xiaoshe-line-strong)) !important;
}

@media (min-width: 1181px) {
  body[data-xiaoshe-shell]:has([data-xiaoshe-inspector-host][data-rail-collapsed='true']) [data-slot='root'] > div {
    padding-right: 52px;
  }
  body[data-xiaoshe-shell]:has([data-xiaoshe-inspector-host][data-rail-collapsed='true']) [data-xiaoshe-stage-header] {
    right: 52px;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-rail-collapsed='true'] [data-xiaoshe-inspector] {
    width: 52px;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-rail-collapsed='true'] [data-xiaoshe-inspector-head] {
    min-height: 58px;
    justify-content: center;
    padding: 12px 10px;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-rail-collapsed='true'] :is(
    [data-xiaoshe-inspector-title],
    [data-xiaoshe-inspector-live],
    [data-xiaoshe-inspector-tabs],
    [data-xiaoshe-inspector-body]
  ) {
    display: none;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-rail-collapsed='true'] [data-xiaoshe-inspector-actions] {
    width: 100%;
    justify-content: center;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-rail-collapsed='true'] [data-xiaoshe-inspector-resizer] {
    display: none;
  }
}

@media (max-width: 1180px) {
  body[data-xiaoshe-shell] [data-slot='root'] > div {
    padding-right: 0;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector] {
    width: min(300px, 88vw);
    z-index: 2;
    box-shadow: var(--dsw-shadow-lv3);
    transform: translateX(105%);
    transition: transform 180ms ease;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-resizer],
  body[data-xiaoshe-shell] [data-xiaoshe-active-mark] {
    display: none;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-stage-header] {
    right: 0;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-host][data-open='true'] [data-xiaoshe-inspector] {
    transform: translateX(0);
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-toggle] {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    height: 34px;
    padding: 0 10px;
    border-radius: 10px;
    pointer-events: auto;
    box-shadow: var(--dsw-shadow-lv2);
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-close] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-collapse] {
    display: none;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-inspector-tabs] {
    margin-right: 48px;
  }
}

@media (max-width: 760px) {
  body[data-xiaoshe-shell] [data-xiaoshe-stage-header] {
    height: 104px;
    padding: 16px 18px;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-stage-title] {
    margin-bottom: 6px;
    font-size: 26px;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-stage-state] {
    display: none;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-hero-word] {
    font-size: clamp(54px, 16vw, 70px);
  }
  body[data-xiaoshe-shell] [data-xiaoshe-hero-title] {
    width: min(330px, calc(100vw - 24px));
    min-height: 78px;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-hero-capabilities] {
    width: min(330px, calc(100vw - 24px));
    max-width: calc(100vw - 24px);
  }
  body[data-xiaoshe-shell] [data-phase='hero'] [data-composer-seat] {
    top: 70px;
  }
  body[data-xiaoshe-shell] [data-phase='hero'] div:has(> span > [data-slot='conversation.hero.brand.mark']) {
    top: -70px;
  }
  body[data-xiaoshe-shell] [data-composer-seat] {
    --dsh-composer-side-clearance: 10px;
  }
}

@media (max-height: 760px) {
  body[data-xiaoshe-shell] [data-phase='hero'] [data-composer-seat] {
    top: 56px;
  }
  body[data-xiaoshe-shell] [data-phase='hero'] div:has(> span > [data-slot='conversation.hero.brand.mark']) {
    top: -56px;
  }
}

@media (prefers-reduced-motion: reduce) {
  body[data-xiaoshe-shell] *,
  body[data-xiaoshe-shell] *::before,
  body[data-xiaoshe-shell] *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  body[data-xiaoshe-shell] [data-xiaoshe-hero-word] {
    animation-duration: 9s !important;
    animation-iteration-count: infinite !important;
  }
}
`

    function mountProductTheme() {
      var style = document.getElementById(XIAOSHE_THEME_ID)
      var created = style === null
      if (created) {
        style = document.createElement('style')
        style.id = XIAOSHE_THEME_ID
        style.setAttribute('data-xiaoshe-theme', 'product-shell-v1')
        style.textContent = XIAOSHE_THEME_CSS
        document.head.appendChild(style)
      }
      document.body.setAttribute('data-xiaoshe-shell', 'product-v1')
      var unmountRibbonMotion = XIAOSHE_RIBBON_BACKGROUND_ENABLED
        ? mountXiaosheRibbonMotion()
        : function () {}
      return function unmountProductTheme() {
        unmountRibbonMotion()
        document.body.removeAttribute('data-xiaoshe-shell')
        if (created) style?.remove()
      }
    }

    function brandTitle(value) {
      var current = typeof value === 'string' ? value.trim().replace(/\s*[—-]\s*DSH Local Build$/i, '').trim() : ''
      if (current === '' || /^DSH Local Build$/i.test(current)) return '小蛇'
      return current.indexOf('小蛇') === 0 ? current : `小蛇 · ${current}`
    }

    function mountXiaosheConversationChrome() {
      if (!document.body || typeof document.querySelectorAll !== 'function') return function () {}
      var changedLabels = []
      var applying = false

      function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim()
      }

      function replaceTextNodes(root, from, to) {
        var changed = false
        function visit(node) {
          if (!node) return
          if (node.nodeType === 3 && typeof node.nodeValue === 'string' && node.nodeValue.indexOf(from) >= 0) {
            node.nodeValue = node.nodeValue.replace(from, to)
            changed = true
            return
          }
          var children = node.childNodes
          if (!children) return
          for (var index = 0; index < children.length; index += 1) visit(children[index])
        }
        visit(root)
        return changed
      }

      function mark(node, name) {
        if (node && typeof node.setAttribute === 'function') node.setAttribute(name, '')
      }

      function rename(root, from, to) {
        if (!replaceTextNodes(root, from, to)) return false
        changedLabels.push({ root: root, from: from, to: to })
        return true
      }

      function update() {
        if (applying) return
        applying = true
        try {
          var buttons = Array.prototype.slice.call(document.querySelectorAll('button'))
          buttons.forEach(function (button) {
            var label = cleanText(button.textContent)
            if (label.indexOf('会话日志') >= 0 || label.indexOf('Session log') >= 0) {
              if (label.indexOf('会话日志') >= 0) rename(button, '会话日志', '任务记录')
              if (label.indexOf('Session log') >= 0) rename(button, 'Session log', '任务记录')
              mark(button, 'data-xiaoshe-task-record')
            } else if (label.indexOf('任务记录') >= 0) {
              mark(button, 'data-xiaoshe-task-record')
            }
            if (label.indexOf('创建能力方案') >= 0) rename(button, '创建能力方案', '自动编排')
            if (label.indexOf('自动（推荐）') >= 0) rename(button, '自动（推荐）', '自动编排')
            if (cleanText(button.textContent).indexOf('自动编排') >= 0) mark(button, 'data-xiaoshe-auto-orchestration')
            if (/^(只读|工作区写入|项目内执行|全面访问)/.test(label)) mark(button, 'data-xiaoshe-permission-control')
            var aria = typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') : ''
            if (aria && aria.indexOf('选择模型') >= 0) mark(button, 'data-xiaoshe-model-control')
          })

          Array.prototype.slice.call(document.querySelectorAll('span')).forEach(function (labelNode) {
            var label = cleanText(labelNode.textContent)
            if (label === '创建能力方案') rename(labelNode, '创建能力方案', '自动编排')
            if (cleanText(labelNode.textContent) === '自动编排') {
              mark(labelNode, 'data-xiaoshe-auto-orchestration')
            }
          })

          var tablists = Array.prototype.slice.call(document.querySelectorAll("[role='tablist']"))
          tablists.forEach(function (tablist) {
            var text = cleanText(tablist.textContent)
            if (text.indexOf('轨迹') >= 0) rename(tablist, '轨迹', '行动')
            text = cleanText(tablist.textContent)
            if (text.indexOf('对话') >= 0 && text.indexOf('行动') >= 0) mark(tablist, 'data-xiaoshe-conversation-tabs')
          })
        } finally {
          applying = false
        }
      }

      update()
      var observer = typeof MutationObserver === 'function' ? new MutationObserver(update) : null
      observer?.observe(document.body, { childList: true, subtree: true, characterData: true })
      return function () {
        observer?.disconnect()
        changedLabels.forEach(function (entry) { replaceTextNodes(entry.root, entry.to, entry.from) })
        Array.prototype.slice.call(document.querySelectorAll('[data-xiaoshe-task-record], [data-xiaoshe-conversation-tabs], [data-xiaoshe-auto-orchestration], [data-xiaoshe-model-control], [data-xiaoshe-permission-control]')).forEach(function (node) {
          node.removeAttribute('data-xiaoshe-task-record')
          node.removeAttribute('data-xiaoshe-conversation-tabs')
          node.removeAttribute('data-xiaoshe-auto-orchestration')
          node.removeAttribute('data-xiaoshe-model-control')
          node.removeAttribute('data-xiaoshe-permission-control')
        })
      }
    }

    function requestJson(path, options) {
      return fetch(path, options).then((response) => response.json()
        .catch(() => ({}))
        .then((body) => {
          if (!response.ok) {
            var error = new Error(body.error || `请求失败（${response.status}）`)
            error.status = response.status
            error.body = body
            throw error
          }
          return body
        }))
    }

    var DESKTOP_TOOL_LABELS = {
      screen_observe: '观察屏幕',
      screen_zoom: '放大屏幕',
      screen_verify: '验证界面',
      screen_list_windows: '列出窗口',
      screen_click: '点击桌面',
      screen_type: '输入文本',
      screen_press: '发送按键',
      screen_focus_window: '聚焦窗口',
    }

    function genericView(value) {
      return value && typeof value === 'object' && value.card === 'generic' ? value : null
    }

    function viewText(view) {
      if (!Array.isArray(view?.content)) return ''
      return view.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    }

    // DSH's generic fallback currently renders raw Tool IN/OUT instead of the
    // presentResult view. Desktop tools need the opposite security posture:
    // render only their presenter-owned title/content, never raw arguments
    // (screen_type arguments may contain private text).
    function DesktopToolCard(react) {
      var h = react.createElement
      var useState = react.useState

      return function XiaosheDesktopToolCard(props) {
        var state = useState(false)
        var open = state[0]
        var setOpen = state[1]
        var block = props?.block && typeof props.block === 'object' ? props.block : {}
        var settled = block.kind === 'tool-result'
        var callView = genericView(block.callView)
        var resultView = settled ? genericView(block.resultView) : null
        var failed = settled && block.isError === true
        var label = DESKTOP_TOOL_LABELS[props?.toolName] || '桌面工具'
        var title = failed
          ? `${label}失败`
          : typeof resultView?.title === 'string' && resultView.title.trim() !== ''
            ? resultView.title
            : typeof callView?.title === 'string' && callView.title.trim() !== ''
              ? callView.title
              : label
        var content = failed
          ? '未执行或未完成桌面动作。请在轨迹中查看错误。'
          : viewText(resultView)
        var summary = content === ''
          ? settled ? '已完成' : '执行中…'
          : content.split('\n', 1)[0]

        return h(
          'div',
          {
            'data-xiaoshe-tool-card': props?.toolName || '',
            'data-state': failed ? 'error' : settled ? 'completed' : 'running',
            style: {
              margin: '6px 0',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: '10px',
              background: 'var(--dsw-alias-bg-layer-2)',
              overflow: 'hidden',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-expanded': open,
              onClick: () => setOpen(!open),
              style: {
                width: '100%',
                minHeight: '44px',
                padding: '9px 12px',
                border: 0,
                background: 'transparent',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                display: 'grid',
                gridTemplateColumns: '8px minmax(0, 1fr) auto',
                columnGap: '10px',
                alignItems: 'center',
              },
            },
            h('span', {
              'aria-hidden': true,
              style: {
                width: '7px',
                height: '7px',
                borderRadius: '999px',
                background: failed
                  ? 'var(--dsw-alias-red-default, #ef6b6b)'
                  : settled
                    ? 'var(--dsw-alias-green-default, #67c995)'
                    : 'var(--dsw-alias-yellow-default, #e3bc5b)',
              },
            }),
            h(
              'span',
              { style: { minWidth: 0 } },
              h('span', { style: { display: 'block', fontSize: '13px', fontWeight: 600 } }, title),
              h(
                'span',
                {
                  style: {
                    display: 'block',
                    marginTop: '2px',
                    color: 'var(--dsw-alias-label-tertiary)',
                    fontSize: '12px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                summary,
              ),
            ),
            h('span', { 'aria-hidden': true, style: { color: 'var(--dsw-alias-label-tertiary)' } }, open ? '⌃' : '⌄'),
          ),
          open && content !== ''
            ? h(
                'pre',
                {
                  style: {
                    margin: 0,
                    padding: '10px 12px 12px 30px',
                    borderTop: '1px solid var(--dsw-alias-border-l2)',
                    color: 'var(--dsw-alias-label-secondary)',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: '12px',
                    lineHeight: 1.65,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  },
                },
                content,
              )
            : null,
        )
      }
    }

    function BrandMark(react) {
      var h = react.createElement
      return function XiaosheBrandMark(props) {
        var size = Number.isFinite(props?.size) ? props.size : 24
        return h(
          'span',
          {
            className: props?.className,
            role: 'img',
            'aria-label': '小蛇',
            'data-xiaoshe-brand-mark': '',
            style: {
              width: `${size}px`,
              height: `${size}px`,
              display: 'block',
              WebkitMaskImage: `url(${XIAOSHE_MARK_URL})`,
              maskImage: `url(${XIAOSHE_MARK_URL})`,
              WebkitMaskRepeat: 'no-repeat',
              maskRepeat: 'no-repeat',
              WebkitMaskPosition: 'center',
              maskPosition: 'center',
              WebkitMaskSize: 'contain',
              maskSize: 'contain',
            },
          },
        )
      }
    }

    function BrandName(react) {
      var h = react.createElement
      return function XiaosheBrandName() {
        return h(
          'span',
          { 'data-xiaoshe-brand-name': '' },
          h('span', { 'data-xiaoshe-brand-title': '' }, '小蛇'),
          h('span', { 'data-xiaoshe-brand-subtitle': '', translate: 'no', lang: 'en' }, 'DESKTOP · AGENT'),
        )
      }
    }

    function ApprovedOutlineMark(react) {
      var h = react.createElement
      return h(
        'svg',
        {
          'data-xiaoshe-hero-outline-mark': '',
          width: '300',
          height: '300',
          viewBox: '0 0 300 300',
          fill: 'none',
          'aria-hidden': true,
        },
        h(
          'defs',
          null,
          h(
            'filter',
            {
              id: 'xiaoshe-hero-alpha-outline',
              x: '-5',
              y: '-5',
              width: '310',
              height: '310',
              filterUnits: 'userSpaceOnUse',
              primitiveUnits: 'userSpaceOnUse',
              colorInterpolationFilters: 'sRGB',
            },
            h('feMorphology', {
              in: 'SourceAlpha',
              operator: 'dilate',
              radius: '0.7',
              result: 'outer',
            }),
            h('feMorphology', {
              in: 'SourceAlpha',
              operator: 'erode',
              radius: '0.7',
              result: 'inner',
            }),
            h('feComposite', {
              in: 'outer',
              in2: 'inner',
              operator: 'out',
              result: 'edge',
            }),
            h('feFlood', {
              // Convert the approved snake.svg alpha into a contour; this
              // layer never owns or recreates a logo path.
              floodColor: '#2e8b6a',
              result: 'line-color',
            }),
            h('feComposite', {
              in: 'line-color',
              in2: 'edge',
              operator: 'in',
            }),
          ),
        ),
        h('image', {
          href: XIAOSHE_MARK_URL,
          x: '0',
          y: '0',
          width: '300',
          height: '300',
          preserveAspectRatio: 'xMidYMid meet',
          filter: 'url(#xiaoshe-hero-alpha-outline)',
        }),
      )
    }

    function PanelIcon(react) {
      var h = react.createElement
      return h(
        'svg',
        {
          'data-xiaoshe-panel-icon': '',
          width: '16',
          height: '16',
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
        },
        h('path', {
          fillRule: 'evenodd',
          clipRule: 'evenodd',
          d: 'M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM5.54303 1.88715V14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715ZM4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873V1.91166Z',
          fill: 'currentColor',
        }),
      )
    }

    function HeroBrand(react) {
      var h = react.createElement

      return function XiaosheHeroBrand(props) {
        return h(
          'span',
          { 'data-xiaoshe-hero-brand': '' },
          h('span', { 'data-xiaoshe-hero-kicker': '', translate: 'no' }, '小蛇待命 · DESKTOP AGENT'),
          h(
            'span',
            { 'data-xiaoshe-hero-title': '' },
            h('span', { 'data-xiaoshe-hero-word': '' }, '小蛇'),
          ),
          h('span', { 'data-xiaoshe-hero-description': '' }, '看懂你的屏幕，接手电脑里的任务；关键动作先问你，做完再验证。'),
          h(
            'span',
            { 'data-xiaoshe-hero-capabilities': '', 'aria-label': '小蛇特点' },
            ...['看得见桌面', '真能动手做', '关键操作可控'].map((label) => h(
              'span',
              { key: label, 'data-xiaoshe-hero-capability': '' },
              label,
            )),
          ),
        )
      }
    }

    function ProductInspector(react) {
      var h = react.createElement
      var useEffect = react.useEffect
      var useRef = typeof react.useRef === 'function'
        ? react.useRef
        : (initial) => ({ current: initial })
      var useState = react.useState

      function clampInspectorWidth(value) {
        if (value === null || value === undefined || value === '') return 300
        var width = Number(value)
        return Number.isFinite(width) ? Math.max(260, Math.min(420, Math.round(width))) : 300
      }

      function count(selector) {
        return document.querySelectorAll?.(selector)?.length || 0
      }

      function nodeText(node, fallback) {
        var value = typeof node?.textContent === 'string'
          ? node.textContent.replace(/\s+/g, ' ').trim()
          : ''
        return value === '' ? fallback : value
      }

      function modelLabel() {
        var button = document.querySelector?.("button[aria-label^='选择模型']")
        var label = button?.getAttribute?.('aria-label') || ''
        var match = label.match(/^选择模型[，,]\s*当前\s*(.+?)(?:[，,]\s*推理等级.*)?$/)
        return match?.[1] || nodeText(button, '模型待选择')
      }

      function toolCounts() {
        var rows = Array.from(document.querySelectorAll?.('[data-tool][data-state]') || [])
        if (rows.length === 0) {
          rows = Array.from(document.querySelectorAll?.('[data-xiaoshe-tool-card][data-state]') || [])
        }
        var result = { running: 0, completed: 0, failed: 0, stopped: 0 }
        for (var row of rows) {
          var state = row.getAttribute?.('data-state') || ''
          if (state === 'running') result.running += 1
          else if (state === 'ok' || state === 'completed') result.completed += 1
          else if (state === 'error') result.failed += 1
          else if (state === 'stopped') result.stopped += 1
        }
        return result
      }

      function uiSnapshot() {
        var phaseKey = document.querySelector?.("[data-phase='active']")
          ? 'active'
          : document.querySelector?.("[data-phase='settling']") ? 'settling' : 'hero'
        var runtimeNode = document.querySelector?.('[data-session-runtime-state]')
        var runtimeState = runtimeNode?.getAttribute?.('data-session-runtime-state') || 'idle'
        var runtimeLabels = {
          'awaiting-approval': '等待审批',
          'tool-running': '工具执行中',
          'waiting-model': '等待模型',
          'model-running': '模型运行中',
          stopped: '已停止',
          idle: '空闲',
        }
        var phase = phaseKey === 'settling'
          ? '正在载入会话'
          : runtimeLabels[runtimeState] || runtimeLabels.idle
        var workspaceButton = document.querySelector?.("button[aria-label='选择工作区']")
        var presetButton = document.querySelector?.("[data-slot='conversation.hero.agentPreset'] button")
        var frame = document.querySelector?.("[data-slot='root'] > div")
        var sidebarColumn = frame?.firstElementChild
        var sidebarWidthValue = sidebarColumn?.getBoundingClientRect?.().width
        var sidebarWidth = Number.isFinite(sidebarWidthValue) && sidebarWidthValue > 0
          ? Math.round(sidebarWidthValue)
          : 248
        var tools = toolCounts()
        return {
          phaseKey: phaseKey,
          phase: phase,
          runtimeState: runtimeState,
          sidebarWidth: sidebarWidth,
          workspace: nodeText(workspaceButton, phaseKey === 'hero' ? '选择工作区' : '随当前会话'),
          workspaceLabel: '',
          preset: nodeText(presetButton, '标准模式'),
          model: modelLabel(),
          running: tools.running,
          completed: tools.completed,
          failed: tools.failed,
          stopped: tools.stopped,
          todoPending: count("[data-testid='todo-panel'] [data-status='pending']"),
          todoRunning: count("[data-testid='todo-panel'] [data-status='in_progress']"),
          todoCompleted: count("[data-testid='todo-panel'] [data-status='completed']"),
          approvals: count('[data-approval-key]'),
          queued: count('[data-queue-dock]'),
          messages: count('[data-chat-anchor-key]'),
          contextInjections: count('[data-context-injection-body]'),
        }
      }

      function emptyMemorySnapshot() {
        return {
          api_version: 1,
          revision: 0,
          counts: { active: 0, global: 0, project: 0, forgotten: 0, superseded: 0 },
          entries: [],
          audit: [],
        }
      }

      function projectKey(value) {
        var key = typeof value === 'string' ? value.trim() : ''
        if (key === '' || key === '选择工作区' || key === '随当前会话') return ''
        return key
      }

      function memoryQueryPath(project) {
        return project === ''
          ? '/xiaoshe/memory?scope=global&include_inactive=true'
          : '/xiaoshe/memory?scope=all&include_inactive=true&project=' + encodeURIComponent(project)
      }

      function memoryDate(value) {
        var date = new Date(value)
        if (!Number.isFinite(date.getTime())) return '时间未知'
        return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
      }

      function panelCard(title, children) {
        return h(
          'section',
          { 'data-xiaoshe-panel-card': '', 'data-xiaoshe-panel-section': '' },
          h('h3', null, title),
          children,
        )
      }

      function panelRow(label, value) {
        return h(
          'div',
          { 'data-xiaoshe-panel-row': '' },
          h('span', null, label),
          h('span', null, value),
        )
      }

      function metric(label, value) {
        return h(
          'div',
          { 'data-xiaoshe-panel-metric': '' },
          h('strong', null, String(value)),
          h('span', null, label),
        )
      }

      return function XiaosheProductInspector(props) {
        var currentSession = typeof props?.useSessions === 'function'
          ? props.useSessions((state) => state.current === undefined ? undefined : state.byId[state.current])
          : undefined
        var workspaceState = typeof props?.useWorkspaces === 'function'
          ? props.useWorkspaces((state) => state)
          : undefined
        var currentWorkspace = workspaceState?.items?.find((workspace) =>
          currentSession?.id !== undefined && workspace.sessionIds?.includes(currentSession.id))
        var runtimeProject = currentWorkspace?.path || currentSession?.cwd || ''
        var runtimeWorkspaceLabel = currentWorkspace?.title || ''

        var tabState = useState('status')
        var tab = tabState[0]
        var setTab = tabState[1]
        var drawerState = useState(false)
        var drawerOpen = drawerState[0]
        var setDrawerOpen = drawerState[1]
        var railState = useState(() => {
          try {
            return globalThis.localStorage?.getItem('xiaoshe.inspector.collapsed') === 'true'
          } catch (_error) {
            return false
          }
        })
        var railCollapsed = railState[0]
        var setRailCollapsed = railState[1]
        var inspectorWidthState = useState(() => {
          try {
            return clampInspectorWidth(globalThis.localStorage?.getItem('xiaoshe.inspector.width'))
          } catch (_error) {
            return 300
          }
        })
        var inspectorWidth = inspectorWidthState[0]
        var setInspectorWidth = inspectorWidthState[1]
        var inspectorResize = useRef(null)
        var statusState = useState(null)
        var status = statusState[0]
        var setStatus = statusState[1]
        var uiState = useState(uiSnapshot)
        var observedUi = uiState[0]
        var setUi = uiState[1]
        var errorState = useState('')
        var error = errorState[0]
        var setError = errorState[1]
        var memoryState = useState(emptyMemorySnapshot)
        var memory = memoryState[0]
        var setMemory = memoryState[1]
        var memoryScopeState = useState('project')
        var memoryScope = memoryScopeState[0]
        var setMemoryScope = memoryScopeState[1]
        var memoryDraftState = useState('')
        var memoryDraft = memoryDraftState[0]
        var setMemoryDraft = memoryDraftState[1]
        var memoryEditingState = useState(null)
        var memoryEditing = memoryEditingState[0]
        var setMemoryEditing = memoryEditingState[1]
        var memoryBusyState = useState('')
        var memoryBusy = memoryBusyState[0]
        var setMemoryBusy = memoryBusyState[1]
        var memoryErrorState = useState('')
        var memoryError = memoryErrorState[0]
        var setMemoryError = memoryErrorState[1]

        function productSnapshot() {
          var next = uiSnapshot()
          return runtimeProject === '' ? next : {
            ...next,
            workspace: runtimeProject,
            workspaceLabel: runtimeWorkspaceLabel,
          }
        }

        var ui = runtimeProject === '' ? observedUi : {
          ...observedUi,
          workspace: runtimeProject,
          workspaceLabel: runtimeWorkspaceLabel,
        }
        var activeProject = projectKey(runtimeProject || ui.workspace)
        var effectiveMemoryScope = memoryScope === 'project' && activeProject === '' ? 'global' : memoryScope

        function refreshMemory(nextUi) {
          var project = projectKey(runtimeProject || nextUi?.workspace)
          return requestJson(memoryQueryPath(project))
            .then((next) => { setMemory(next); setMemoryError(''); return next })
            .catch((cause) => { setMemoryError(cause.message); throw cause })
        }

        function refresh() {
          var nextUi = productSnapshot()
          setUi(nextUi)
          var desktop = requestJson('/xiaoshe/desktop/status')
            .then((next) => { setStatus(next); setError('') })
            .catch((cause) => setError(cause.message))
          var memories = refreshMemory(nextUi).catch(() => undefined)
          return Promise.all([desktop, memories])
        }

        function toggleRail() {
          setRailCollapsed((current) => {
            var next = !current
            try {
              globalThis.localStorage?.setItem('xiaoshe.inspector.collapsed', String(next))
            } catch (_error) {
              // Private and hardened browsers may reject storage. The current
              // view remains usable even when the preference cannot persist.
            }
            return next
          })
        }

        function persistInspectorWidth(width) {
          try {
            globalThis.localStorage?.setItem('xiaoshe.inspector.width', String(clampInspectorWidth(width)))
          } catch (_error) {
            // Keep the current layout usable when browser storage is blocked.
          }
        }

        function beginInspectorResize(event) {
          if (railCollapsed) return
          event.preventDefault()
          event.currentTarget.setPointerCapture?.(event.pointerId)
          inspectorResize.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: inspectorWidth,
            width: inspectorWidth,
          }
          document.body.setAttribute('data-xiaoshe-resizing', 'inspector')
        }

        function moveInspectorResize(event) {
          var drag = inspectorResize.current
          if (drag === null || drag.pointerId !== event.pointerId) return
          var next = clampInspectorWidth(drag.startWidth + drag.startX - event.clientX)
          drag.width = next
          setInspectorWidth(next)
        }

        function endInspectorResize(event) {
          var drag = inspectorResize.current
          if (drag === null || drag.pointerId !== event.pointerId) return
          event.currentTarget.releasePointerCapture?.(event.pointerId)
          inspectorResize.current = null
          document.body.removeAttribute('data-xiaoshe-resizing')
          persistInspectorWidth(drag.width)
        }

        function adjustInspectorWidth(event) {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          var next = clampInspectorWidth(inspectorWidth + (event.key === 'ArrowLeft' ? 12 : -12))
          setInspectorWidth(next)
          persistInspectorWidth(next)
        }

        useEffect(() => {
          document.body.style.setProperty('--xiaoshe-inspector-width', `${inspectorWidth}px`)
          return () => document.body.style.removeProperty('--xiaoshe-inspector-width')
        }, [inspectorWidth])

        useEffect(() => () => {
          document.body.removeAttribute('data-xiaoshe-resizing')
        }, [])

        function beginMemoryEdit(entry) {
          setMemoryEditing(entry)
          setMemoryScope(entry.scope)
          setMemoryDraft(entry.text)
          setMemoryError('')
        }

        function cancelMemoryEdit() {
          setMemoryEditing(null)
          setMemoryDraft('')
          setMemoryError('')
        }

        async function submitMemory(event) {
          event.preventDefault()
          var text = typeof memoryDraft === 'string' ? memoryDraft.trim() : ''
          if (text === '') {
            setMemoryError('请输入要记住的内容。')
            return
          }
          var scope = memoryEditing?.scope || effectiveMemoryScope
          var project = scope === 'project'
            ? projectKey(memoryEditing?.project || activeProject)
            : ''
          if (scope === 'project' && project === '') {
            setMemoryError('请先选择一个工作区，再写入当前项目记忆。')
            return
          }
          setMemoryBusy('save')
          setMemoryError('')
          try {
            await requestJson('/xiaoshe/memory', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'remember',
                expected_revision: memory.revision,
                scope: scope,
                ...(project === '' ? {} : { project: project }),
                text: text,
                ...(memoryEditing?.id === undefined ? {} : { replaces_id: memoryEditing.id }),
              }),
            })
            setMemoryDraft('')
            setMemoryEditing(null)
            await refreshMemory(ui)
          } catch (cause) {
            if (cause?.status === 409) {
              await refreshMemory(ui).catch(() => undefined)
              setMemoryError('记忆刚刚在别处发生变化，已刷新，请重新确认后保存。')
            } else {
              setMemoryError(cause.message)
            }
          } finally {
            setMemoryBusy('')
          }
        }

        async function changeMemoryState(entry, state) {
          setMemoryBusy(entry.id)
          setMemoryError('')
          try {
            await requestJson('/xiaoshe/memory', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'set_state',
                expected_revision: memory.revision,
                id: entry.id,
                state: state,
              }),
            })
            if (memoryEditing?.id === entry.id) cancelMemoryEdit()
            await refreshMemory(ui)
          } catch (cause) {
            if (cause?.status === 409) {
              await refreshMemory(ui).catch(() => undefined)
              setMemoryError('记忆刚刚在别处发生变化，已刷新。')
            } else {
              setMemoryError(cause.message)
            }
          } finally {
            setMemoryBusy('')
          }
        }

        function memoryItem(entry) {
          var inactive = entry.state === 'forgotten'
          return h(
            'article',
            {
              key: entry.id,
              'data-xiaoshe-memory-item': '',
              'data-state': entry.state,
            },
            h('p', { 'data-xiaoshe-memory-text': '' }, entry.text),
            h(
              'div',
              { 'data-xiaoshe-memory-meta': '' },
              h('span', null, `v${entry.version || 1} · ${memoryDate(entry.updated_at)}`),
              h(
                'div',
                { 'data-xiaoshe-memory-item-actions': '' },
                inactive
                  ? h('button', {
                      type: 'button',
                      disabled: memoryBusy !== '',
                      onClick: () => changeMemoryState(entry, 'active'),
                    }, '恢复')
                  : h(
                      react.Fragment,
                      null,
                      h('button', {
                        type: 'button',
                        disabled: memoryBusy !== '',
                        onClick: () => beginMemoryEdit(entry),
                      }, '编辑'),
                      h('button', {
                        type: 'button',
                        disabled: memoryBusy !== '',
                        onClick: () => changeMemoryState(entry, 'forgotten'),
                      }, '遗忘'),
                    ),
              ),
            ),
          )
        }

        function memoryGroup(title, entries, emptyCopy) {
          return panelCard(
            `${title} · ${entries.length}`,
            entries.length === 0
              ? h('p', { 'data-xiaoshe-memory-empty': '' }, emptyCopy)
              : h('div', { 'data-xiaoshe-memory-list': '' }, ...entries.map(memoryItem)),
          )
        }

        useEffect(() => {
          var active = true
          function update() {
            if (!active) return
            setUi(productSnapshot())
          }
          refresh()
          var observer = typeof MutationObserver === 'function'
            ? new MutationObserver(update)
            : null
          observer?.observe(document.body, { childList: true, subtree: true, attributes: true })
          var resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(update)
            : null
          var frame = document.querySelector?.("[data-slot='root'] > div")
          var sidebarColumn = frame?.firstElementChild
          if (sidebarColumn !== undefined && sidebarColumn !== null) resizeObserver?.observe(sidebarColumn)
          var timer = setInterval(refresh, 15000)
          return () => {
            active = false
            observer?.disconnect()
            resizeObserver?.disconnect()
            clearInterval(timer)
          }
        }, [runtimeProject])

        var bridgeReady = status?.bridge?.state === 'ready'
        var actions = status?.actions
        var probeState = status?.last_probe?.state || 'unknown'
        var todoTotal = (ui.todoPending || 0) + (ui.todoRunning || 0) + (ui.todoCompleted || 0)
        var actionLabel = actions?.enabled ? '已开启 · 每次审批' : status ? '已关闭' : '检测中'
        var connectionLabel = bridgeReady ? '已连接' : status ? '需检查' : '连接中'
        var entries = Array.isArray(memory?.entries) ? memory.entries : []
        var globalEntries = entries.filter((entry) => entry.scope === 'global' && entry.state === 'active')
        var projectEntries = entries.filter((entry) => entry.scope === 'project'
          && entry.state === 'active' && entry.project === activeProject)
        var forgottenEntries = entries.filter((entry) => entry.state === 'forgotten')
        var body

        if (tab === 'memory') {
          body = h(
            react.Fragment,
            null,
            panelCard(
              memoryEditing === null ? '写入记忆' : '修改记忆',
              h(
                'form',
                { 'data-xiaoshe-memory-form': '', onSubmit: submitMemory },
                h(
                  'div',
                  { 'data-xiaoshe-memory-scope': '', 'aria-label': '记忆范围' },
                  h('button', {
                    type: 'button',
                    'aria-pressed': effectiveMemoryScope === 'global',
                    disabled: memoryEditing !== null,
                    onClick: () => setMemoryScope('global'),
                  }, '长期'),
                  h('button', {
                    type: 'button',
                    'aria-pressed': effectiveMemoryScope === 'project',
                    disabled: memoryEditing !== null || activeProject === '',
                    title: activeProject === '' ? '选择工作区后可用' : activeProject,
                    onClick: () => setMemoryScope('project'),
                  }, '当前项目'),
                ),
                h('textarea', {
                  value: memoryDraft,
                  maxLength: 4000,
                  placeholder: effectiveMemoryScope === 'project'
                    ? '只在当前项目中需要长期保留的事实…'
                    : '跨项目都适用的偏好或长期事实…',
                  'aria-label': '记忆内容',
                  onChange: (event) => setMemoryDraft(event.target.value),
                }),
                h(
                  'div',
                  { 'data-xiaoshe-memory-actions': '' },
                  memoryEditing === null ? null : h('button', {
                    type: 'button',
                    'data-xiaoshe-panel-button': '',
                    disabled: memoryBusy !== '',
                    onClick: cancelMemoryEdit,
                  }, '取消'),
                  h('button', {
                    type: 'submit',
                    'data-xiaoshe-panel-button': '',
                    disabled: memoryBusy !== '' || String(memoryDraft).trim() === '',
                  }, memoryBusy === 'save' ? '保存中…' : memoryEditing === null ? '记住' : '保存修改'),
                ),
              ),
            ),
            memoryError
              ? h('p', { role: 'alert', 'data-xiaoshe-panel-note': '', style: { marginTop: '12px' } }, memoryError)
              : null,
            memoryGroup('长期', globalEntries, '还没有跨项目长期保留的记忆。'),
            memoryGroup('当前项目', projectEntries, activeProject === ''
              ? '选择工作区后，这里会显示与该项目精确绑定的记忆。'
              : '当前项目还没有单独记住的内容。'),
            memoryGroup('已遗忘', forgottenEntries, '没有可恢复的已遗忘记忆。'),
            (memory?.counts?.superseded || 0) > 0
              ? h('p', { 'data-xiaoshe-panel-note': '', style: { paddingTop: '12px' } },
                  `另有 ${memory.counts.superseded} 个旧版本保留在审计历史中。`)
              : null,
          )
        } else if (tab === 'system') {
          body = h(
            react.Fragment,
            null,
            panelCard(
              '已接通能力',
              h(
                react.Fragment,
                null,
                panelRow('桥接服务', bridgeReady ? '可用' : status ? '异常' : '检测中'),
                panelRow('运行平台', status?.bridge?.platform || '检测中'),
                panelRow('产品版本', status?.version || '检测中'),
                panelRow('桥接协议', status?.bridge?.protocol || '检测中'),
                panelRow('视觉理解', status?.modlens_available ? 'ModLens 可用' : '未注册'),
                panelRow('桌面动作', actionLabel),
                panelRow('屏幕权限', probeState === 'available' ? '已授权' : probeState === 'denied' ? '未授权' : '待检测'),
              ),
            ),
            panelCard(
              '行动边界',
              h(
                react.Fragment,
                null,
                h('p', { 'data-xiaoshe-panel-note': '', style: { marginBottom: '12px' } },
                  '读取可直接执行；写文件、运行命令和真实桌面动作仍服从小蛇审批策略与部署上限。'),
                h('button', {
                  type: 'button',
                  'data-xiaoshe-panel-button': '',
                  onClick: refresh,
                }, '刷新系统状态'),
              ),
            ),
          )
        } else {
          body = h(
            react.Fragment,
            null,
            panelCard(
              '当前回合',
              h(
                react.Fragment,
                null,
                h('p', { 'data-xiaoshe-panel-lead': '' }, ui.phase),
                h('p', { 'data-xiaoshe-panel-note': '', style: { marginBottom: '13px' } },
                  ui.runtimeState === 'idle'
                    ? '工作台保持安静；任务开始后这里会聚合实际执行信号。'
                    : '数字来自当前会话的真实行动记录，不用模拟进度填充。'),
                h(
                  'div',
                  { 'data-xiaoshe-panel-metrics': '' },
                  metric('执行中', ui.running || 0),
                  metric('已完成', ui.completed || 0),
                  metric('失败', ui.failed || 0),
                  metric('待审批', ui.approvals || 0),
                ),
              ),
            ),
            panelCard(
              '行动脉络',
              todoTotal === 0
                ? h('p', { 'data-xiaoshe-panel-note': '' }, ui.runtimeState === 'idle'
                  ? '接到任务后，计划与执行状态会在中间任务流中持续更新。'
                  : '当前没有结构化任务清单；行动记录仍按实际执行更新。')
                : h(
                    react.Fragment,
                    null,
                    panelRow('进行中', String(ui.todoRunning || 0)),
                    panelRow('待处理', String(ui.todoPending || 0)),
                    panelRow('已完成', String(ui.todoCompleted || 0)),
                  ),
            ),
            panelCard(
              '当前环境',
              h(
                react.Fragment,
                null,
                panelRow('工作区', ui.workspaceLabel || ui.workspace || '选择工作区'),
                panelRow('会话模式', ui.preset || '标准模式'),
                panelRow('模型', ui.model || '模型待选择'),
                panelRow('消息节点', String(ui.messages || 0)),
                panelRow('上下文注入', String(ui.contextInjections || 0)),
                panelRow('桌面桥接', connectionLabel),
                panelRow('动作能力', actionLabel),
              ),
            ),
          )
        }

        return h(
          'div',
          {
            'data-xiaoshe-inspector-host': '',
            'data-phase': ui.phaseKey,
            'data-open': drawerOpen ? 'true' : 'false',
            'data-rail-collapsed': railCollapsed ? 'true' : 'false',
            style: {
              '--xiaoshe-sidebar-width': `${ui.sidebarWidth || 248}px`,
              '--xiaoshe-inspector-width': `${inspectorWidth}px`,
            },
          },
          ui.phaseKey === 'active' && ui.messages > 0
            ? h(
                'span',
                { 'data-xiaoshe-active-mark': '', 'aria-hidden': true },
                ApprovedOutlineMark(react),
              )
            : null,
          h(
            'header',
            {
              'data-xiaoshe-stage-header': '',
              'data-visible': ui.phaseKey === 'hero' ? 'true' : 'false',
              'aria-hidden': ui.phaseKey === 'hero' ? undefined : true,
            },
            h(
              'div',
              { 'data-xiaoshe-stage-heading': '' },
              h('h1', { 'data-xiaoshe-stage-title': '' }, '新会话'),
              h(
                'div',
                { 'data-xiaoshe-stage-meta': '' },
                h('span', { 'data-xiaoshe-stage-dot': '', 'aria-hidden': true }),
                h('span', null, ui.workspaceLabel || ui.workspace || '选择工作区'),
                h('span', { 'data-xiaoshe-stage-divider': '', 'aria-hidden': true }, '·'),
                h('span', null, ui.model || '模型待选择'),
              ),
            ),
            h(
              'div',
              { 'data-xiaoshe-stage-state': '' },
              h('span', { 'data-xiaoshe-stage-dot': '', 'aria-hidden': true }),
              h('span', null, connectionLabel),
              h('span', { 'data-xiaoshe-stage-divider': '', 'aria-hidden': true }, '·'),
              h('span', null, '权限按当前策略执行'),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              'data-xiaoshe-inspector-toggle': '',
              'aria-label': '打开小蛇状态栏',
              'aria-expanded': drawerOpen,
              onClick: () => setDrawerOpen(true),
            },
            '状态',
          ),
          h('div', {
            'data-xiaoshe-inspector-resizer': '',
            role: 'separator',
            'aria-label': '调整工作台宽度',
            'aria-orientation': 'vertical',
            'aria-valuemin': 260,
            'aria-valuemax': 420,
            'aria-valuenow': inspectorWidth,
            tabIndex: railCollapsed ? -1 : 0,
            onPointerDown: beginInspectorResize,
            onPointerMove: moveInspectorResize,
            onPointerUp: endInspectorResize,
            onPointerCancel: endInspectorResize,
            onKeyDown: adjustInspectorWidth,
          }),
          h(
            'aside',
            { 'data-xiaoshe-inspector': '', 'aria-label': '小蛇运行、记忆与边界' },
            h(
              'button',
              {
                type: 'button',
                'data-xiaoshe-inspector-close': '',
                'aria-label': '关闭小蛇状态栏',
                onClick: () => setDrawerOpen(false),
              },
              '×',
            ),
            h(
              'div',
              { 'data-xiaoshe-inspector-head': '' },
              h('span', { 'data-xiaoshe-inspector-title': '' }, '小蛇工作台'),
              h(
                'div',
                { 'data-xiaoshe-inspector-actions': '' },
                h(
                  'span',
                  {
                    'data-xiaoshe-inspector-live': '',
                    'data-state': bridgeReady ? 'ready' : status ? 'error' : 'loading',
                  },
                  bridgeReady ? '已连接' : status ? '需检查' : '连接中',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-xiaoshe-inspector-collapse': '',
                    'aria-label': railCollapsed ? '展开工作台' : '收起工作台',
                    'aria-expanded': !railCollapsed,
                    'aria-controls': 'xiaoshe-inspector-body',
                    title: railCollapsed ? '展开工作台' : '收起工作台',
                    onClick: toggleRail,
                  },
                  PanelIcon(react),
                ),
              ),
            ),
            h(
              'div',
              { 'data-xiaoshe-inspector-tabs': '', role: 'tablist', 'aria-label': '小蛇检查器' },
              ...[
                ['status', '运行'],
                ['memory', '记忆'],
                ['system', '边界'],
              ].map(([key, label]) => h(
                'button',
                {
                  key: key,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab === key,
                  onClick: () => setTab(key),
                },
                label,
              )),
            ),
            h('div', { id: 'xiaoshe-inspector-body', 'data-xiaoshe-inspector-body': '', role: 'tabpanel' }, body, error
              ? h('p', { role: 'alert', 'data-xiaoshe-panel-note': '', style: { marginTop: '12px' } }, error)
              : null),
          ),
        )
      }
    }

    function StatusCard(react) {
      var h = react.createElement
      var useEffect = react.useEffect
      var useState = react.useState

      function badge(text, good) {
        return h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: '24px',
              padding: '0 9px',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-l2)',
              background: good ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-3)',
              color: good ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
              fontSize: '12px',
            },
          },
          text,
        )
      }

      function row(label, value) {
        return h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', lineHeight: 1.6 } },
          h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, label),
          h('span', { style: { textAlign: 'right' } }, value),
        )
      }

      return function XiaosheStatusCard() {
        var openState = useState(true)
        var open = openState[0]
        var setOpen = openState[1]
        var statusState = useState(null)
        var status = statusState[0]
        var setStatus = statusState[1]
        var previewState = useState(null)
        var preview = previewState[0]
        var setPreview = previewState[1]
        var busyState = useState('')
        var busy = busyState[0]
        var setBusy = busyState[1]
        var errorState = useState('')
        var error = errorState[0]
        var setError = errorState[1]

        function refresh() {
          return requestJson('/xiaoshe/desktop/status').then(setStatus)
        }

        useEffect(() => {
          var active = true
          requestJson('/xiaoshe/desktop/status')
            .then((next) => { if (active) setStatus(next) })
            .catch((cause) => { if (active) setError(cause.message) })
          return () => { active = false }
        }, [])

        function toggleActions(event) {
          var enabled = event.target.checked === true
          setBusy('actions')
          setError('')
          requestJson('/xiaoshe/desktop/actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: enabled }),
          })
            .then(refresh)
            .catch((cause) => setError(cause.message))
            .finally(() => setBusy(''))
        }

        function selectResponseStyle(responseStyle) {
          var previous = status
          setBusy('response-style')
          setError('')
          setStatus({ ...(status || {}), response_style: responseStyle })
          requestJson('/xiaoshe/preferences', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ response_style: responseStyle }),
          })
            .then(refresh)
            .catch((cause) => {
              setStatus(previous)
              setError(`表达方式保存失败：${cause.message}`)
            })
            .finally(() => setBusy(''))
        }

        function probe() {
          setBusy('probe')
          setError('')
          requestJson('/xiaoshe/desktop/probe', { method: 'POST' })
            .then((result) => {
              setPreview(result)
              return refresh()
            })
            .catch((cause) => {
              setPreview(null)
              setError(cause.message)
              return refresh().catch(() => {})
            })
            .finally(() => setBusy(''))
        }

        var body = null
        if (open) {
          var bridgeReady = status?.bridge?.state === 'ready'
          var modlensReady = status?.modlens_available === true
          var probeState = status?.last_probe?.state || 'unknown'
          var actions = status?.actions
          var responseStyle = status?.response_style === 'friendly' ? 'friendly' : 'pragmatic'
          var modeOptions = [
            { value: 'friendly', label: '亲和', description: '温暖、协作、贴心' },
            { value: 'pragmatic', label: '务实', description: '简洁、专注、直接' },
          ]
          body = h(
            'div',
            { 'data-xiaoshe-settings-body': '', style: { padding: '0 16px 16px' } },
            h(
              'section',
              { 'data-xiaoshe-settings-summaries': '', style: { display: 'grid', gap: '8px', marginBottom: '16px' } },
              h(
                'div',
                { 'data-xiaoshe-settings-summary': '', style: { padding: '11px 12px', borderRadius: '9px', border: '1px solid var(--dsw-alias-border-l2)' } },
                h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '会话与项目'),
                h('div', { style: { marginTop: '3px', fontSize: '12px', lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)' } }, '新会话可以先作为临时对话开始；需要项目时再移入，完整历史会保留并切换到目标工作目录。'),
              ),
              h(
                'div',
                { 'data-xiaoshe-settings-summary': '', style: { padding: '11px 12px', borderRadius: '9px', border: '1px solid var(--dsw-alias-border-l2)' } },
                h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '长期记忆'),
                h('div', { style: { marginTop: '3px', fontSize: '12px', lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)' } }, '按条保存、编辑、遗忘和恢复；在右侧“小蛇工作台 → 记忆”中管理，不使用虚假的总开关。'),
              ),
              h(
                'div',
                { 'data-xiaoshe-settings-summary': '', style: { padding: '11px 12px', borderRadius: '9px', border: '1px solid var(--dsw-alias-border-l2)' } },
                h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '行动边界'),
                h('div', { style: { marginTop: '3px', fontSize: '12px', lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)' } }, '只读用于查看；逐项确认适合日常工作；自主执行减少确认，但仍受系统安全边界约束。'),
              ),
            ),
            h(
              'section',
              { 'data-xiaoshe-response-style': '', style: { marginBottom: '16px' } },
              h('div', { style: { marginBottom: '8px', fontSize: '13px', fontWeight: 600 } }, '表达方式'),
              h(
                'div',
                {
                  role: 'radiogroup',
                  'aria-label': '小蛇表达方式',
                  style: {
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: '4px',
                    padding: '4px',
                    borderRadius: '10px',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-layer-3)',
                  },
                },
                modeOptions.map((option) => {
                  var selected = responseStyle === option.value
                  return h(
                    'button',
                    {
                      key: option.value,
                      type: 'button',
                      role: 'radio',
                      'aria-checked': selected,
                      disabled: busy !== '',
                      onClick: () => selectResponseStyle(option.value),
                      style: {
                        minHeight: '54px',
                        padding: '8px 10px',
                        borderRadius: '7px',
                        border: selected ? '1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent)' : '1px solid transparent',
                        background: selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                        color: 'inherit',
                        textAlign: 'left',
                        cursor: busy === '' ? 'pointer' : 'wait',
                      },
                    },
                    h('span', { style: { display: 'block', fontSize: '13px', fontWeight: selected ? 650 : 500 } }, option.label),
                    h('span', { style: { display: 'block', marginTop: '2px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, option.description),
                  )
                }),
              ),
            ),
            h(
              'div',
              { 'data-xiaoshe-runtime-badges': '', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' } },
              badge(bridgeReady ? '桥接可用' : '桥接异常', bridgeReady),
              badge(modlensReady ? '视觉可用' : '视觉未注册', modlensReady),
              badge(
                probeState === 'available' ? '屏幕已授权' : probeState === 'denied' ? '屏幕未授权' : '屏幕待检测',
                probeState === 'available',
              ),
            ),
            h(
              'div',
              { 'data-xiaoshe-runtime-status': '', style: { display: 'grid', gap: '7px', fontSize: '13px', marginBottom: '14px' } },
              row('运行心跳', bridgeReady ? '在线' : status ? '异常' : '检测中'),
              row('运行平台', status?.bridge?.platform || '未知'),
              row('桌面动作', actions?.enabled ? '已开启（每次仍需审批）' : '已关闭'),
              row('持久设置', actions?.persistent ? '已保存到小蛇设置' : '仅本次运行'),
              row('上次检测', status?.last_probe?.message || '尚未检测'),
            ),
            h(
              'p',
              {
                style: {
                  margin: '-2px 0 14px',
                  fontSize: '12px',
                  lineHeight: 1.6,
                  color: 'var(--dsw-alias-label-tertiary)',
                },
              },
              '运行心跳只表示后台执行器在线，不会代替你主动发消息，也不会模拟关怀。',
            ),
            h(
              'label',
              {
                'data-xiaoshe-settings-switch': '',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '16px',
                  padding: '11px 0',
                  borderTop: '1px solid var(--dsw-alias-border-l2)',
                },
              },
              h(
                'span',
                null,
                h('span', { style: { display: 'block', fontSize: '13px', fontWeight: 600 } }, '允许桌面动作'),
                h(
                  'span',
                  { style: { display: 'block', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
                  actions?.deployment_allowed
                    ? '关闭后点击、输入和按键工具会从模型工具表移除。'
                    : '部署策略已锁定为关闭，界面不能绕过。',
                ),
              ),
              h('input', {
                type: 'checkbox',
                checked: actions?.enabled === true,
                disabled: busy !== '' || actions?.deployment_allowed !== true,
                onChange: toggleActions,
                'aria-label': '允许桌面动作',
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                'data-xiaoshe-settings-probe': '',
                disabled: busy !== '',
                onClick: probe,
                style: {
                  width: '100%',
                  minHeight: '36px',
                  borderRadius: '9px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  color: 'inherit',
                  cursor: busy === '' ? 'pointer' : 'wait',
                },
              },
              busy === 'probe' ? '正在检测真实屏幕…' : '检测屏幕权限并生成预览',
            ),
            error
              ? h(
                  'div',
                  {
                    role: 'alert',
                    style: {
                      marginTop: '10px',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      color: 'var(--dsw-alias-label-primary)',
                      fontSize: '12px',
                      lineHeight: 1.55,
                    },
                  },
                  error,
                )
              : null,
            preview?.preview_url
              ? h(
                  'figure',
                  { style: { margin: '12px 0 0' } },
                  h('img', {
                    src: preview.preview_url,
                    alt: '刚刚检测到的桌面截图',
                    style: {
                      display: 'block',
                      width: '100%',
                      maxHeight: '260px',
                      objectFit: 'contain',
                      borderRadius: '8px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                    },
                  }),
                  h(
                    'figcaption',
                    { style: { marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
                    `一次性私有预览 · 读取到 ${preview.element_count || 0} 个元素`,
                  ),
                )
              : null,
          )
        }

        return h(
          'div',
          {
            'data-xiaoshe-settings-card': '',
            style: {
              border: '1px solid var(--dsw-alias-border-l2)',
              background: open ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-3)',
              borderRadius: '12px',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'data-xiaoshe-settings-trigger': '',
              'aria-expanded': open,
              onClick: () => setOpen(!open),
              style: {
                width: '100%',
                border: 0,
                background: 'none',
                color: 'inherit',
                textAlign: 'left',
                padding: '14px 16px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                gap: '12px',
              },
            },
            h(
              'span',
              null,
              h('span', { style: { display: 'block', fontSize: '14px', fontWeight: 600 } }, '运行与偏好'),
              h(
                'span',
                { style: { display: 'block', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } },
                '表达方式、运行能力、会话归属与行动边界。',
              ),
            ),
            h('span', { 'aria-hidden': true, style: { transform: open ? 'rotate(180deg)' : 'none' } }, '⌄'),
          ),
          body,
        )
      }
    }

    function mountBrand(ctx, react) {
      var Mark = BrandMark(react)
      var Name = BrandName(react)
      var Hero = HeroBrand(react)
      ctx.slots.inject('sidebar.brand.mark', () =>
        ctx.slots.inject('sidebar.brand.name', () =>
          ctx.slots.inject('conversation.hero.brand.mark', function* () {
            yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: -100 }, Mark)
            yield ctx.slots.register({ name: 'sidebar.brand.name', priority: -100 }, Name)
            yield ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -100 }, Hero)
          })))
    }

    function mountProductInspector(ctx, react) {
      var Inspector = ProductInspector(react)
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({
          name: 'shell.overlay',
          id: 'xiaoshe-inspector',
          key: 'xiaoshe-inspector',
          order: 40,
        }, Inspector)
      })
    }

    function mountSettingsCard(ctx, react) {
      var Card = StatusCard(react)
      ctx.slots.inject('settings.general.item', function* () {
        yield ctx.slots.register({
          name: 'settings.general.item',
          id: 'xiaoshe-desktop',
          key: 'xiaoshe-desktop',
          order: 20,
        }, Card)
      })
    }

    function mountDesktopToolCards(ctx, react) {
      var Card = DesktopToolCard(react)
      ctx.slots.inject('tool.call.toolview', function* () {
        for (var toolName of Object.keys(DESKTOP_TOOL_LABELS)) {
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key: toolName,
          }, Card)
        }
      })
    }

    function apply(ctx) {
      var react
      try {
        react = require('react')
      } catch (error) {
        console.error(`[xiaoshe] browser UI skipped: ${error}`)
        return
      }
      // React is the host contract for every injected seat. Only attach the
      // visual shell after that contract is available, so a partial host load
      // cannot leave a theme attribute/style behind without a cleanup owner.
      var unmountTheme = mountProductTheme()
      var unmountConversationChrome = mountXiaosheConversationChrome()

      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots'], (scope) => {
          try {
            mountBrand(scope, react)
            mountProductInspector(scope, react)
            mountDesktopToolCards(scope, react)
          } catch (error) {
            console.error(`[xiaoshe] product UI slots skipped: ${error}`)
          }
          fetch('/xiaoshe/desktop/status')
            .then((response) => {
              if (response.status === 404) return
              mountSettingsCard(scope, react)
            })
            .catch(() => {})
        })
      }

      var originalTitle = document.title
      var brandIconId = 'xiaoshe-browser-favicon'
      var brandIconHref = XIAOSHE_MARK_URL
      var originalIcons = []
      var applyingBrowserBrand = false
      function brandExistingIcons() {
        var icons = Array.prototype.slice.call(document.querySelectorAll("link[rel~='icon']"))
        icons.forEach(function (icon) {
          if (icon.id === brandIconId) return
          if (!originalIcons.some(function (entry) { return entry.node === icon })) {
            originalIcons.push({
              node: icon,
              href: icon.getAttribute('href'),
              type: icon.getAttribute('type'),
            })
          }
          // Chromium may keep using the first icon candidate even when a later
          // link is appended. Repoint every host-owned candidate so the tab can
          // no longer fall back to DSH's whale favicon.
          icon.setAttribute('href', brandIconHref)
          icon.setAttribute('type', 'image/svg+xml')
        })
      }
      function applyBrowserBrand() {
        if (applyingBrowserBrand) return
        applyingBrowserBrand = true
        try {
          var next = brandTitle(document.title)
          if (next !== document.title) document.title = next
          brandExistingIcons()
          var icon = document.getElementById(brandIconId)
          if (!icon) {
            icon = document.createElement('link')
            icon.id = brandIconId
            icon.setAttribute('rel', 'icon')
            icon.setAttribute('type', 'image/svg+xml')
            icon.setAttribute('href', brandIconHref)
            document.head.appendChild(icon)
          }
        } finally {
          // A transient host-head failure must not permanently disable future
          // MutationObserver retries.
          applyingBrowserBrand = false
        }
      }
      applyBrowserBrand()
      var observer = typeof MutationObserver === 'function'
        ? new MutationObserver(applyBrowserBrand)
        : null
      observer?.observe(document.head, { childList: true, subtree: true, characterData: true })

      if (typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            unmountConversationChrome()
            unmountTheme()
          },
          'xiaoshe: product visual shell',
        )
        ctx.effect(
          () => () => {
            observer?.disconnect()
            document.getElementById(brandIconId)?.remove()
            originalIcons.forEach(function (entry) {
              if (entry.href === null) entry.node.removeAttribute('href')
              else entry.node.setAttribute('href', entry.href)
              if (entry.type === null) entry.node.removeAttribute('type')
              else entry.node.setAttribute('type', entry.type)
            })
            if (document.title.indexOf('小蛇') === 0) document.title = originalTitle
          },
          'xiaoshe: browser brand title and icon',
        )
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
