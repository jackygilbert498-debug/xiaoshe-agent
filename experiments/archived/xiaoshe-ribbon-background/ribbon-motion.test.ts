// Archived with the dormant ribbon prototype; not part of the active shell suite.
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Registration {
  readonly factory: (require: (id: string) => unknown) => {
    apply(ctx: Record<string, unknown>): void
  }
}

class TestNode {
  readonly children: TestNode[] = []
  readonly attributes = new Map<string, string>()
  readonly style: Record<string, string> = {}
  parentElement: TestNode | null = null
  textContent = ''
  id = ''
  isConnected = true

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  appendChild(node: TestNode): TestNode {
    node.parentElement = this
    this.children.push(node)
    return node
  }

  insertBefore(node: TestNode, before: TestNode | undefined): TestNode {
    node.parentElement = this
    const index = before === undefined ? -1 : this.children.indexOf(before)
    if (index < 0) this.children.push(node)
    else this.children.splice(index, 0, node)
    return node
  }

  remove(): void {
    if (this.parentElement !== null) {
      const index = this.parentElement.children.indexOf(this)
      if (index >= 0) this.parentElement.children.splice(index, 1)
    }
    this.parentElement = null
    this.isConnected = false
  }

  get firstChild(): TestNode | undefined {
    return this.children[0]
  }
}

function descendants(node: TestNode): TestNode[] {
  return [node, ...node.children.flatMap(descendants)]
}

function pathPoints(value: string): Array<{ x: number; y: number }> {
  return Array.from(value.matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g), match => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }))
}

function totalTurningAngle(points: Array<{ x: number; y: number }>): number {
  let total = 0
  for (let index = 1; index < points.length - 1; index += 1) {
    const incoming = Math.atan2(
      points[index].y - points[index - 1].y,
      points[index].x - points[index - 1].x,
    )
    const outgoing = Math.atan2(
      points[index + 1].y - points[index].y,
      points[index + 1].x - points[index].x,
    )
    let delta = outgoing - incoming
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI
    total += Math.abs(delta)
  }
  return total
}

function laneWidths(
  upper: Array<{ x: number; y: number }>,
  lower: Array<{ x: number; y: number }>,
): number[] {
  return upper.map((point, index) => Math.hypot(
    point.x - lower[index].x,
    point.y - lower[index].y,
  ))
}

async function mountRibbon(reducedMotion = false) {
  const clientPath = fileURLToPath(new URL('../../../client.js', import.meta.url))
  const source = await readFile(clientPath, 'utf8')
  let registration: Registration | undefined
  let nextFrame = 1
  const frames = new Map<number, (time: number) => void>()
  const stage = new TestNode('main')
  const head = new TestNode('head')
  const body = new TestNode('body')
  const idNodes = new Map<string, TestNode>()

  const document = {
    title: 'DSH Local Build',
    head: {
      appendChild(node: TestNode) {
        head.appendChild(node)
        if (node.id !== '') idNodes.set(node.id, node)
      },
    },
    body,
    querySelector(selector: string) {
      return selector === "[data-phase='hero'] [data-conversation-scroll]" ? stage : null
    },
    querySelectorAll() { return [] },
    getElementById(id: string) { return idNodes.get(id) ?? null },
    createElement(name: string) { return new TestNode(name) },
    createElementNS(_namespace: string, name: string) { return new TestNode(name) },
  }

  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value: Registration) { registration = value } } },
    document,
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }),
    performance: { now: () => 1_000 },
    matchMedia: () => ({
      matches: reducedMotion,
      addEventListener() {},
      removeEventListener() {},
    }),
    requestAnimationFrame(callback: (time: number) => void) {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame(id: number) { frames.delete(id) },
    console,
  })

  if (registration === undefined) throw new Error('client bundle did not register')
  const client = registration.factory(id => id === 'react' ? {} : undefined)
  client.apply({})

  const svg = stage.children.find(node => node.getAttribute('data-xiaoshe-ribbon-field') === '')
  if (svg === undefined) throw new Error('ribbon field did not mount in the hero stage')
  const ribbonNodes = descendants(svg)
  const centerPath = ribbonNodes.find(node => node.getAttribute('data-xiaoshe-ribbon-lane') === '0')
  const upperEdgePath = ribbonNodes.find(node => node.getAttribute('data-xiaoshe-ribbon-lane') === '-1')
  const lowerEdgePath = ribbonNodes.find(node => node.getAttribute('data-xiaoshe-ribbon-lane') === '1')
  if (centerPath === undefined || upperEdgePath === undefined || lowerEdgePath === undefined) {
    throw new Error('complete ribbon lane bundle did not mount')
  }

  return { body, frames, stage, svg, centerPath, upperEdgePath, lowerEdgePath }
}

describe('xiaoshe snake ribbon motion', () => {
  it('limits ribbon redraws to 24 frames per second without changing the motion cycle', async () => {
    const mounted = await mountRibbon()
    const initialPath = mounted.centerPath.getAttribute('d')
    const scheduled = Array.from(mounted.frames.values())[0]

    expect(scheduled).toBeTypeOf('function')
    scheduled(1_040)
    expect(mounted.centerPath.getAttribute('d')).toBe(initialPath)

    scheduled(1_042)
    expect(mounted.centerPath.getAttribute('d')).not.toBe(initialPath)
  })

  it('deforms one fixed center-column field and exchanges the same body sections across half a cycle', async () => {
    const mounted = await mountRibbon()
    const first = pathPoints(mounted.centerPath.getAttribute('d') ?? '')
    const scheduled = Array.from(mounted.frames.values())[0]

    expect(scheduled).toBeTypeOf('function')
    scheduled(6_500)
    const half = pathPoints(mounted.centerPath.getAttribute('d') ?? '')

    expect(first).toHaveLength(105)
    expect(half).toHaveLength(105)
    expect(mounted.stage.children).toContain(mounted.svg)
    expect(mounted.svg.getAttribute('transform')).toBeNull()
    expect(mounted.svg.getAttribute('viewBox')).toBe('0 0 1000 560')

    for (let index = 0; index < first.length; index += 1) {
      expect(half[index].x).toBeCloseTo(first[index].x, 1)
      expect(half[index].y + first[index].y).toBeCloseTo(760, 1)
    }

    expect(Math.abs(first[0].y - half[0].y)).toBeGreaterThan(120)
    expect(Math.abs(first.at(-1)!.y - half.at(-1)!.y)).toBeGreaterThan(120)
    expect(first[0].x).toBeLessThan(0)
    expect(first.at(-1)!.x).toBeGreaterThan(1000)
    expect(first.at(-1)!.x - first[0].x).toBeCloseTo(1080, 1)

    const firstMeanY = first.reduce((sum, point) => sum + point.y, 0) / first.length
    const halfMeanY = half.reduce((sum, point) => sum + point.y, 0) / half.length
    expect(firstMeanY).toBeCloseTo(380, 1)
    expect(halfMeanY).toBeCloseTo(380, 1)
  })

  it('keeps a static field and schedules no animation when reduced motion is requested', async () => {
    const mounted = await mountRibbon(true)

    expect(pathPoints(mounted.centerPath.getAttribute('d') ?? '')).toHaveLength(105)
    expect(mounted.frames.size).toBe(0)
  })

  it('draws a deep, continuously turning S-curve rather than a shallow ribbon', async () => {
    const mounted = await mountRibbon()
    const points = pathPoints(mounted.centerPath.getAttribute('d') ?? '')
    const verticalSpan = Math.max(...points.map(point => point.y))
      - Math.min(...points.map(point => point.y))
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length

    expect(verticalSpan).toBeGreaterThanOrEqual(498)
    expect(verticalSpan).toBeLessThanOrEqual(502.5)
    expect(meanY).toBeCloseTo(380, 1)
    expect(totalTurningAngle(points)).toBeGreaterThan(3.3)
  })

  it('keeps the widened bend field continuous in space and time', async () => {
    const mounted = await mountRibbon()
    const currentWidths = () => {
      const upper = pathPoints(mounted.upperEdgePath.getAttribute('d') ?? '')
      const lower = pathPoints(mounted.lowerEdgePath.getAttribute('d') ?? '')
      return laneWidths(upper, lower)
    }

    let previous = currentWidths()
    const bodyWidth = Math.min(...previous)
    const peakWidth = Math.max(...previous)
    const spatialJump = Math.max(...previous.slice(1).map((width, index) => (
      Math.abs(width - previous[index])
    )))

    expect(previous).toHaveLength(105)
    expect(peakWidth / bodyWidth).toBeGreaterThan(1.65)
    expect(peakWidth / bodyWidth).toBeLessThan(1.75)
    expect(spatialJump).toBeLessThan(2.6)

    const scheduled = Array.from(mounted.frames.values())[0]
    let largestFrameJump = 0
    for (let frame = 1; frame <= 264; frame += 1) {
      scheduled(1_000 + frame * (11_000 / 264))
      const next = currentWidths()
      largestFrameJump = Math.max(
        largestFrameJump,
        ...next.map((width, index) => Math.abs(width - previous[index])),
      )
      previous = next
    }

    expect(largestFrameJump).toBeLessThan(2.5)
  })

  it('renders every line layer through a progressively stronger fog filter', async () => {
    const mounted = await mountRibbon()
    const ribbonNodes = descendants(mounted.svg)
    const layers = mounted.svg.children.filter(node => node.tagName === 'g')
    const blurRadii = ribbonNodes
      .filter(node => node.tagName === 'feGaussianBlur')
      .map(node => Number(node.getAttribute('stdDeviation')))
      .sort((left, right) => left - right)
    const opacities = layers.map(layer => Number(layer.getAttribute('opacity')))

    expect(layers).toHaveLength(3)
    expect(layers.every(layer => layer.getAttribute('filter') !== null)).toBe(true)
    expect(blurRadii).toEqual([1, 20, 55])
    expect(opacities).toEqual([0.24, 0.42, 0.58])
    expect(mounted.svg.children.some(node => (
      node.getAttribute('data-xiaoshe-ribbon-gold') !== null
    ))).toBe(false)
  })

})
