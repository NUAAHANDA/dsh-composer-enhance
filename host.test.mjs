/**
 * Offline tests for the composer-enhance host route: drives the registered
 * handler with a mocked Cordis context, request, and response.
 */
import assert from 'node:assert'
import { apply, normalizeOutput, joinLines } from './index.js'

/** Minimal ServerResponse stand-in that records what the handler wrote. */
function fakeResponse() {
  const state = { statusCode: 200, headers: {}, body: '', ended: false }
  return {
    state,
    get statusCode() { return state.statusCode },
    set statusCode(value) { state.statusCode = value },
    setHeader(name, value) { state.headers[name] = value },
    end(body) { if (typeof body === 'string') state.body += body; state.ended = true },
  }
}

/** Minimal IncomingMessage stand-in over one JSON body. */
function fakeRequest(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const chunks = [Buffer.from(body, 'utf8')]
  return {
    method,
    headers: contentType === null ? {} : { 'content-type': contentType },
    resume() {},
    async *[Symbol.asyncIterator]() { yield* chunks },
  }
}

/** Build a plugin context that captures the route and answers the model with `chunks`. */
function mountRoute({ chunks, selection, models, rejection, effort } = {}) {
  let route = null
  const ctx = {
    connection: { requestRejection: () => rejection },
    webServer: { register: (spec) => { route = spec; return () => {} } },
    effect: (fn) => { fn(); return () => {} },
    llm: {
      stream: (options) => {
        ctx.lastOptions = options
        return (async function* () { yield* chunks ?? [] })()
      },
      resolveModelInfo: async () => ({ reasoning: { efforts: effort ?? [{ id: 'low' }] } }),
      listProviders: () => models ?? [],
    },
    get: (key) => key === 'agentDefaultModel' && selection !== undefined ? { currentSelection: () => selection } : undefined,
  }
  apply(ctx)
  assert.ok(route !== null, 'apply() registered no route')
  return { route, ctx }
}

/** Drive one request through the captured route. */
async function call(route, request) {
  const res = fakeResponse()
  await route.handler(request, res)
  return res.state
}

const text = (...parts) => parts.map(t => ({ type: 'text-delta', index: 0, text: t }))
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } })

// 1. A successful rewrite returns one normalized paragraph and the model identity.
{
  const { route, ctx } = mountRoute({
    chunks: [...text('改写结果：', '请把材料', '\n', '整理成一段话'), finish()],
    selection: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' },
  })
  const state = await call(route, fakeRequest(JSON.stringify({ draft: '整理材料' })))
  assert.equal(state.statusCode, 200)
  const payload = JSON.parse(state.body)
  assert.equal(payload.text, '请把材料整理成一段话')
  assert.equal(payload.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(payload.truncated, false)
  // The request carried exactly one user turn with a text block, plus the system instruction.
  assert.equal(ctx.lastOptions.messages.length, 1)
  assert.deepEqual(ctx.lastOptions.messages[0].content, [{ type: 'text', text: '草稿：\n整理材料' }])
  assert.ok(ctx.lastOptions.system.includes('一段话'))
  assert.equal(ctx.lastOptions.reasoningEffort, 'low')
  assert.ok(ctx.lastOptions.maxTokens > 0)
}

// 2. The trust fence answers before any model work is spent.
{
  const { route, ctx } = mountRoute({ chunks: [], rejection: 401 })
  const state = await call(route, fakeRequest(JSON.stringify({ draft: 'x' })))
  assert.equal(state.statusCode, 401)
  assert.equal(ctx.lastOptions, undefined, 'a rejected request still reached the model')
}

// 3. Wrong method and wrong content type are refused without a model call.
{
  const { route } = mountRoute({ chunks: [], selection: { provider: 'p', model: 'm' } })
  assert.equal((await call(route, fakeRequest('{}', { method: 'GET' }))).statusCode, 405)
  assert.equal((await call(route, fakeRequest('{}', { contentType: 'text/plain' }))).statusCode, 415)
}

// 4. An unusable body is a 400, not a crash.
for (const body of ['not json', '{}', JSON.stringify({ draft: '   ' }), JSON.stringify({ draft: 42 })]) {
  const { route } = mountRoute({ chunks: [], selection: { provider: 'p', model: 'm' } })
  assert.equal((await call(route, fakeRequest(body))).statusCode, 400, `body ${body} should be refused`)
}

// 5. No configured route answers 503 instead of guessing a provider.
{
  const { route } = mountRoute({ chunks: [] })
  const state = await call(route, fakeRequest(JSON.stringify({ draft: '整理材料' })))
  assert.equal(state.statusCode, 503)
  assert.equal(JSON.parse(state.body).code, 'no-model')
}

// 6. An empty answer is a failure, and a max-tokens stop explains itself.
{
  const { route } = mountRoute({ chunks: [finish('max-tokens')], selection: { provider: 'p', model: 'm' } })
  const state = await call(route, fakeRequest(JSON.stringify({ draft: '整理材料' })))
  assert.equal(state.statusCode, 502)
  assert.equal(JSON.parse(state.body).code, 'empty-result')
  assert.ok(JSON.parse(state.body).message.includes('推理'))
}

// 7. A provider failure surfaces its own message.
{
  const { route } = mountRoute({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'too many' } } }],
    selection: { provider: 'p', model: 'm' },
  })
  const state = await call(route, fakeRequest(JSON.stringify({ draft: '整理材料' })))
  assert.equal(state.statusCode, 502)
  assert.ok(JSON.parse(state.body).message.includes('too many'))
}

// 8. An unknown reasoning effort is never sent.
{
  const { route, ctx } = mountRoute({
    chunks: [...text('结果'), finish()],
    selection: { provider: 'p', model: 'm' },
    effort: [],
  })
  assert.equal((await call(route, fakeRequest(JSON.stringify({ draft: 'x' })))).statusCode, 200)
  assert.equal('reasoningEffort' in ctx.lastOptions, false)
}

// 9. Output normalization: fences, labels, bullets, and numbered steps fold away.
assert.equal(normalizeOutput('```\n改写结果：请整理成一段话\n```'), '请整理成一段话')
assert.equal(normalizeOutput('1. 甲\n2. 乙'), '甲乙')
assert.equal(joinLines(['Hello', 'world']), 'Hello world')
assert.equal(joinLines(['请检查 AOC', '值班记录']), '请检查 AOC值班记录')

console.log('host route tests passed')
