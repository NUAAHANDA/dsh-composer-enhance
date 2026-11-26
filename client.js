/**
 * Browser half of the composer-enhance plugin.
 *
 * A single four-point star in the composer tool row, visible only while the
 * draft has content. One click rewrites the draft in place — the result replaces
 * the text in the input box, still one editable paragraph — and a back button
 * appears beside the star so the rewrite can be undone in one click.
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-enhance',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/composer-enhance/enhance'

    /** Four-point star: a diamond with concave sides, drawn as one path. */
    function StarIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'currentColor', focusable: 'false',
      }, h('path', {
        d: 'M12 2.2c.5 3.6 1.9 6.1 4.4 7.5 1.3.7 3 1.3 5.4 1.8-3.5.5-5.9 1.4-7.4 2.7-1.6 1.4-2.4 3.5-2.4 6.1-.5-3.6-1.9-6.1-4.4-7.5-1.3-.7-3-1.3-5.4-1.8 3.5-.5 5.9-1.4 7.4-2.7C11.2 6.9 12 4.8 12 2.2Z',
      }))
    }

    /** Return arrow: the way back to the text that existed before the rewrite. */
    function BackIcon({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.9,
        strokeLinecap: 'round', strokeLinejoin: 'round', focusable: 'false',
      }, h('path', { d: 'M9.5 5.5 4 10.5l5.5 5' }), h('path', { d: 'M4 10.5h9a6 6 0 0 1 0 12' }))
    }

    /** Shared chrome for the two icon buttons, matching the composer’s 28px chip row. */
    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '28px',
      height: '28px',
      padding: '0',
      border: 'none',
      borderRadius: 'var(--dsw-radius-sm, 6px)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      flex: '0 0 auto',
      lineHeight: '0',
    }

    /** Busy star keeps the same footprint so the row never jumps. */
    function starStyle(busy) {
      return {
        ...buttonStyle,
        color: busy ? 'var(--dsw-alias-label-caption)' : 'var(--dsw-alias-label-secondary)',
        animation: busy ? 'dsh-composer-enhance-turn 1.1s linear infinite' : undefined,
      }
    }

    /** The last failure, shown beside the star until it ages out. */
    function ErrorNote({ message }) {
      if (message === '') return null
      return h('span', {
        role: 'status',
        title: message,
        style: {
          maxWidth: '240px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          color: 'var(--dsw-alias-state-error-primary)',
          padding: '0 4px',
        },
      }, message)
    }

    /**
     * The composer seat: star, plus the back button the rewrite itself reveals.
     * @param props - session slot props (`sessionId`, `useInput`, `inputActions`).
     */
    function PromptEnhance(props) {
      const useInput = props.useInput
      const inputActions = props.inputActions
      const sessionId = props.sessionId

      const input = typeof useInput === 'function' ? useInput(state => state) : undefined
      const draft = input?.draft ?? ''
      const phase = input?.phase ?? 'plain'

      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      /** The rewrite awaiting a possible undo: the text before it and after it. */
      const [undo, setUndo] = React.useState(null)
      const draftRef = React.useRef(draft)
      draftRef.current = draft

      React.useEffect(() => {
        if (error === '') return undefined
        const timer = setTimeout(() => { setError('') }, 6000)
        return () => { clearTimeout(timer) }
      }, [error])

      const run = React.useCallback(async () => {
        const source = draftRef.current
        if (inputActions === undefined || busy || source.trim() === '') return
        setBusy(true)
        setError('')
        setUndo(null)
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(sessionId === undefined ? { draft: source } : { draft: source, sessionId }),
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload === null || typeof payload.text !== 'string' || payload.text === '') {
            const message = payload !== null && typeof payload.message === 'string'
              ? payload.message
              : `改写失败（HTTP ${response.status}）`
            setError(message)
            return
          }
          // A draft edited while the rewrite ran is the user's newer intent; never overwrite it.
          if (draftRef.current !== source) {
            setError('改写期间草稿已改动，结果没有写入。')
            return
          }
          inputActions.setDraft(payload.text)
          setUndo({ before: source, after: payload.text })
        } catch (failure) {
          setError(`改写请求失败：${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          setBusy(false)
        }
      }, [busy, inputActions, sessionId])

      const revert = React.useCallback(() => {
        if (inputActions === undefined || undo === null) return
        inputActions.setDraft(undo.before)
        setUndo(null)
        setError('')
      }, [inputActions, undo])

      // Requirement: no draft, no button. Busy composer phases stay out of the way.
      if (draft.trim() === '' || phase !== 'plain' || inputActions === undefined) {
        // A failure outlives the draft it was about, so it is still reported here.
        return error === '' ? null : h(ErrorNote, { message: error })
      }

      // The back button belongs to the rewrite that is still in the box.
      const canRevert = undo !== null && draft === undo.after && !busy

      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '2px', minWidth: '0' },
      },
      error === '' ? null : h(ErrorNote, { message: error }),
      h('button', {
        type: 'button',
        title: busy ? '正在改写…' : '增强提示词（在输入框内直接改写）',
        'aria-label': busy ? '正在改写' : '增强提示词',
        'aria-busy': busy,
        disabled: busy,
        style: starStyle(busy),
        // Keeping the editor’s focus: a click that steals it would drop the caret.
        onMouseDown: event => { event.preventDefault() },
        onClick: () => { void run() },
      }, h(StarIcon, { size: 16 })),
      canRevert ? h('button', {
        type: 'button',
        title: '返回上一版（撤销这次改写）',
        'aria-label': '返回上一版',
        style: { ...buttonStyle, color: 'var(--dsw-alias-label-caption)' },
        onMouseDown: event => { event.preventDefault() },
        onClick: revert,
      }, h(BackIcon, { size: 16 })) : null)
    }

    /** One keyframes rule for the busy star; removed with the plugin. */
    const STYLE_ID = 'dsh-composer-enhance-style'
    const STYLE_TEXT = '@keyframes dsh-composer-enhance-turn{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'

    const inject = ['slots']

    /**
     * Register the composer seat.
     * @param ctx - the plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE_TEXT
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'composer-enhance: keyframes')

      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'composer-enhance',
        order: 10,
      }, PromptEnhance))
    }

    return { inject, apply, PromptEnhance }
  },
})
