/**
 * Offline smoke test for the composer-enhance client bundle: loads it through a
 * fake module loader, then renders the seat in every state the user described.
 *
 * React is replaced by a tiny hooks harness that replays a fixed hook order,
 * so the component's own state machine (busy / undo) can be driven directly.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert'

const file = process.argv[2]
let spec = null

const sandbox = {
  window: { __ModuleLoader__: { load: (s) => { spec = s } } },
  document: {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { appendChild() {} },
  },
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ text: 'x' }) }),
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file })

assert.ok(spec !== null, 'the bundle never called __ModuleLoader__.load')
assert.equal(spec.id, 'dsh-composer-enhance')

/**
 * Build the bundle's exports over a controllable hooks store.
 * @param slots - one entry per useState in render order, giving [value, setter].
 */
function load(slots = []) {
  let index = 0
  const setters = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const slot = slots[index++] ?? initial
      const pair = [slot, (next) => { pair[0] = typeof next === 'function' ? next(pair[0]) : next }]
      setters.push(pair[1])
      return pair
    },
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const exports = spec.factory((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: (x) => x }
    throw new Error('unexpected require: ' + name)
  })
  return { exports, setters }
}

const { exports: mod } = load()
assert.deepEqual(Object.keys(mod).sort(), ['PromptEnhance', 'apply', 'inject'])
assert.deepEqual(mod.inject, ['slots'])

const actions = { written: [], setDraft(text) { this.written.push(text) } }
/** Render with a given draft; `slots` carries [busy, error, undo] once the caller drives them. */
const render = (draft, options = {}) => {
  const { exports } = load(options.slots)
  return exports.PromptEnhance({
    // An explicit `undefined` means "this Session exposes no input face", so the
    // default must not swallow it.
    inputActions: 'inputActions' in options ? options.inputActions : actions,
    sessionId: 's1',
    useInput: (sel) => sel({ draft, phase: options.phase ?? 'plain' }),
  })
}

// Requirement 1: no text, no button.
assert.equal(render(''), null)
assert.equal(render('   \n  '), null)
// A composer that is busy submitting is not a moment to offer a rewrite.
assert.equal(render('帮我写个周报', { phase: 'sending' }), null)
// Without the input face there is nothing to write back into.
assert.equal(render('帮我写个周报', { inputActions: undefined }), null)

// A filled draft shows the star alone: one button, no back arrow yet.
const fresh = render('帮我写个周报')
assert.equal(fresh.type, 'span')
const freshLive = fresh.children.filter((c) => c !== null)
assert.equal(freshLive.length, 1, 'a fresh draft shows the star only')
const star = freshLive[0]
assert.equal(star.type, 'button')
assert.equal(star.props['aria-label'], '增强提示词')
assert.equal(star.props.title, '增强提示词（在输入框内直接改写）')
assert.equal(star.props.disabled, false)
// The star must not steal the editor's caret.
assert.equal(typeof star.props.onMouseDown, 'function')
// It draws exactly one path: a four-point star, nothing else.
assert.equal(star.children.length, 1)
const starGlyph = star.children[0]
assert.equal(typeof starGlyph.type, 'function', 'the star is its own icon component')
const starSvg = starGlyph.type(starGlyph.props)
assert.equal(starSvg.type, 'svg')
assert.equal(starSvg.children.length, 1)
assert.equal(starSvg.children[0].type, 'path')
assert.ok(starSvg.children[0].props.d.includes('c'))

// Requirement 3: after a rewrite the back button appears beside the star.
const undone = render('改好以后的草稿', { slots: [false, '', { before: '帮我写个周报', after: '改好以后的草稿' }] })
const undoneLive = undone.children.filter((c) => c !== null)
assert.equal(undoneLive.length, 2, 'a rewrite in the box adds the back button')
const back = undoneLive[1]
assert.equal(back.type, 'button')
assert.equal(back.props['aria-label'], '返回上一版')
assert.equal(back.props.title, '返回上一版（撤销这次改写）')
assert.equal(typeof back.props.onClick, 'function')
// The arrow is drawn as its own icon: one shaft, one hook, stroked not filled.
const backSvg = back.children[0].type(back.children[0].props)
assert.equal(backSvg.type, 'svg')
assert.equal(backSvg.children.length, 2)

// The back button belongs only to the text this plugin wrote: editing away from
// it, or a newer undo record, must not offer a revert that would clobber edits.
assert.equal(
  render('我又手动改了几个字', { slots: [false, '', { before: '帮我写个周报', after: '改好以后的草稿' }] })
    .children.filter((c) => c !== null).length,
  1,
)

// While the rewrite runs the star is disabled and spins; no back button yet.
const busy = render('帮我写个周报', { slots: [true, '', null] })
const busyLive = busy.children.filter((c) => c !== null)
assert.equal(busyLive.length, 1)
assert.equal(busyLive[0].props.disabled, true)
assert.equal(busyLive[0].props['aria-busy'], true)
assert.ok(busyLive[0].props.style.animation.includes('dsh-composer-enhance-turn'))

// A failure is reported beside the star, and the star stays usable.
const failed = render('帮我写个周报', { slots: [false, '模型调用失败：额度不足', null] })
const failedLive = failed.children.filter((c) => c !== null)
assert.equal(failedLive.length, 2)
assert.equal(failedLive[1].props.disabled, false)
const note = failedLive[0].type(failedLive[0].props)
assert.equal(note.props.role, 'status')
assert.equal(note.children[0], '模型调用失败：额度不足')

// The note renders nothing while there is no error: no reserved gap either.
const quiet = render('帮我写个周报')
assert.equal(quiet.children[0], null)

// A failure is still reported after the draft it was about is gone.
const cleared = render('', { slots: [false, '模型调用失败：额度不足', null] })
const clearedNote = cleared.type(cleared.props)
assert.equal(clearedNote.props.role, 'status')

// The slot registration and its disposable style effect.
let disposer = null
const ctx = {
  effect: (fn) => { disposer = fn(); return disposer },
  slots: {
    inject: (key, fn) => { assert.equal(key, 'conversation.input.right'); return fn() },
    register: (opts, component) => {
      assert.deepEqual(opts, { name: 'conversation.input.right', id: 'composer-enhance', order: 10 })
      assert.equal(component, mod.PromptEnhance)
      return () => {}
    },
  },
}
mod.apply(ctx)
assert.equal(typeof disposer, 'function')

console.log('client smoke tests passed')
