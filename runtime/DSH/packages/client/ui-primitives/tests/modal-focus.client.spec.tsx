// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '../src/Modal.tsx'

afterEach(cleanup)

it('isolates background focus, wraps Tab and restores the initiating control', () => {
  const view = render(<button>Initiator</button>)
  const trigger = screen.getByRole('button', { name: 'Initiator' })
  trigger.focus()
  const dialog = render(<Modal open title="Edit" closeLabel="Close" onClose={() => {}}>
    <input aria-label="Value" /><button>Save</button>
  </Modal>)
  expect(view.container.inert).toBe(true)
  expect(view.container.getAttribute('aria-hidden')).toBe('true')
  expect(document.activeElement).toBe(screen.getByRole('textbox'))
  screen.getByRole('button', { name: 'Save' }).focus()
  fireEvent.keyDown(document, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }))
  dialog.unmount()
  expect(view.container.inert).toBe(false)
  expect(view.container.hasAttribute('aria-hidden')).toBe(false)
  expect(document.activeElement).toBe(trigger)
})


it('parent rerenders preserve the current input and use the latest close callback', () => {
  const oldClose = vi.fn(), newClose = vi.fn()
  const content = <><input aria-label="First" /><input aria-label="Second" /></>
  const view = render(<Modal open title="Edit" closeLabel="Close" onClose={oldClose}>{content}</Modal>)
  const second = screen.getByRole('textbox', { name: 'Second' })
  second.focus()
  view.rerender(<Modal open title="Edit" closeLabel="Close" onClose={newClose}>{content}</Modal>)
  expect(document.activeElement).toBe(second)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(oldClose).not.toHaveBeenCalled()
  expect(newClose).toHaveBeenCalledOnce()
})
it('a nested dialog owns Escape without closing the inert parent', () => {
  const closeParent = vi.fn(), closeChild = vi.fn()
  render(<Modal open title="Parent" closeLabel="Close parent" onClose={closeParent} />)
  const child = render(<Modal open title="Child" closeLabel="Close child" onClose={closeChild} />)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(closeChild).toHaveBeenCalledOnce()
  expect(closeParent).not.toHaveBeenCalled()
  child.unmount()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(closeParent).toHaveBeenCalledOnce()
})

it('keeps React autoFocus on the safe action and restores its outside initiator', () => {
  render(<button>Launch</button>)
  const trigger = screen.getByRole('button', { name: 'Launch' })
  trigger.focus()
  const view = render(<Modal open title="Confirm" closeLabel="Close" onClose={() => {}}
    footer={<><button autoFocus>Cancel</button><button>Delete</button></>} />)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  view.unmount()
  expect(document.activeElement).toBe(trigger)
})
