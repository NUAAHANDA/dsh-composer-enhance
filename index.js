/**
 * Host half of the composer-enhance plugin.
 *
 * Serves one POST route that the composer's four-point-star button calls. The
 * route owns the model call: the browser holds no credential and never talks to
 * a provider.
 *
 * Security has one home: every request passes the composition's `connection`
 * trust fence (Host/Origin plus the browser session cookie) before any model
 * call is spent.
 *
 * @module dsh-composer-enhance
 */

/** Cordis function-plugin name. */
const name = 'composer-enhance'

/** The route carrier, the trust fence, and the model runtime. */
export const inject = ['webServer', 'connection', 'llm']

/** POST route answering one enhancement request as JSON. */
const ROUTE = '/composer-enhance/enhance'

/** Drafts are small; anything larger is hostile or a bug. */
const MAX_BODY_BYTES = 1024 * 1024

/** Per-draft ceiling. */
const MAX_DRAFT_CHARS = 60000

/** Output ceiling; generous enough for a reasoning model that also answers. */
const MAX_TOKENS = 8192

/** End-to-end deadline for one enhancement. */
const TIMEOUT_MS = 120000

/**
 * The rewriting instruction. Every rule here exists because the composer must
 * receive one editable paragraph, not a document: the result is written back
 * into the input box in place, so headings, lists, fences, and wrapper quotes
 * would all be noise the user has to delete.
 */
const SYSTEM = [
  '你是一个提示词改写器。用户会给你一段草稿，你把它改写成一段更容易被大模型准确执行的提示词。',
  '',
  '改写要求：',
  '1. 只输出改写结果本身，一段话，连续行文。不要标题、不要列表、不要序号、不要 Markdown、不要代码块、不要用引号把整段包起来、不要任何解释或前后缀。',
  '2. 在不改变原意、不编造事实的前提下，补上草稿里隐含但没写出来的任务目标、必要背景、约束条件和期望的输出形式。',
  '3. 信息不足时不要臆造具体事实，改用限定范围的表述，例如“材料未提供时先列出需要补充的信息”。',
  '4. 保留原文中的专有名词、缩写、数字、日期、路径、命令和代码标识符原样不动。',
  '5. 原文是中文就用中文，原文是英文就用英文。',
  '6. 篇幅控制在原稿的 1 到 3 倍之间，不要为了长而长。',
].join('\n')

/** JSON response (no-store: every answer is a fresh model generation). */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate the wire body at the boundary.
 * @param text - raw JSON text.
 * @returns the draft and optional session id, or null when malformed.
 */
function parseBody(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const draft = typeof value.draft === 'string' ? value.draft : undefined
  if (draft === undefined || draft.trim() === '' || draft.length > MAX_DRAFT_CHARS) return null
  const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined
  return { draft, sessionId }
}

/**
 * Resolve the model route for one call.
 *
 * The composer's own Session model wins, so the button follows whatever the
 * user picked above the input box; the profile default is the fallback, and a
 * composition with neither answers 503 rather than guessing a provider.
 * @param ctx - the plugin context.
 * @param sessionId - Session whose composer asked, when the client supplied it.
 * @returns the provider/model pair, or undefined when none is configured.
 */
function resolveRoute(ctx, sessionId) {
  if (sessionId !== undefined) {
    const agent = ctx.get('agents')?.get?.(sessionId)
    const selection = agent?.model?.current?.()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  }
  const defaults = ctx.get('agentDefaultModel')
  const selection = defaults?.currentSelection?.()
  if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/**
 * Lowest advertised reasoning effort for the route.
 *
 * A rewrite is not a reasoning task, and a model that spends its whole output
 * budget thinking returns no text at all. The effort is validated against this
 * exact model before it is used, so an unknown value can never reach dispatch.
 * @param ctx - the plugin context.
 * @param route - provider and model.
 * @returns a supported effort id, or undefined to follow adapter defaults.
 */
async function lowestEffort(ctx, route) {
  try {
    const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
    const effort = info?.reasoning?.efforts?.[0]?.id
    return typeof effort === 'string' && effort !== '' ? effort : undefined
  } catch {
    return undefined
  }
}

/** Strip fences, list markers, and wrapper labels, then join into one paragraph. */
export function normalizeOutput(text) {
  let out = String(text).replace(/\r\n?/g, '\n').trim()
  out = out.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim()
  out = out.replace(/^(?:改写|优化|润色|增强)(?:后|结果)\s*[:：]\s*/, '')
  const lines = out.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => line.replace(/^(?:[-*•]|\d+[.)、])\s+/, ''))
    .filter(line => line !== '')
  return joinLines(lines).trim()
}

/** Join lines into one paragraph, inserting a space only between non-CJK neighbours. */
export function joinLines(lines) {
  let out = ''
  for (const line of lines) {
    if (out === '') {
      out = line
      continue
    }
    const previous = out[out.length - 1]
    const next = line[0]
    out += (isCjk(previous) || isCjk(next) ? '' : ' ') + line
  }
  return out
}

/** Whether one character belongs to a CJK script or full-width punctuation. */
function isCjk(character) {
  return /[\u3000-\u9fff\uff00-\uffef\u3040-\u30ff]/.test(character)
}

/**
 * Register the enhancement route behind the connection trust fence.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /** Answer an untrusted or unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      let text
      try {
        text = await readBoundedBody(req)
      } catch {
        sendJson(res, 400, { code: 'bad-request', message: '请求体读取失败。' })
        return
      }
      if (text === null) {
        sendJson(res, 413, { code: 'payload-too-large', message: '请求体过大。' })
        return
      }
      const request = parseBody(text)
      if (request === null) {
        sendJson(res, 400, { code: 'bad-request', message: '缺少要改写的草稿，或草稿超过长度上限。' })
        return
      }
      const route = resolveRoute(ctx, request.sessionId)
      if (route === undefined) {
        sendJson(res, 503, {
          code: 'no-model',
          message: '没有可用的模型：请先在输入框里选择一个模型，或在设置里指定默认模型。',
        })
        return
      }

      const abort = new AbortController()
      const timer = setTimeout(() => { abort.abort() }, TIMEOUT_MS)
      let assembled = ''
      let terminal
      let usage
      try {
        const effort = await lowestEffort(ctx, route)
        const options = {
          provider: route.provider,
          model: route.model,
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: `草稿：\n${request.draft}` }],
          }],
          system: SYSTEM,
          maxTokens: MAX_TOKENS,
          signal: abort.signal,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        }
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === 'text-delta') {
            assembled += chunk.text
            continue
          }
          if (chunk.type === 'usage') {
            usage = chunk.usage
            continue
          }
          if (chunk.type === 'finish') terminal = chunk
        }
      } catch (error) {
        clearTimeout(timer)
        const aborted = abort.signal.aborted
        sendJson(res, aborted ? 504 : 502, {
          code: aborted ? 'timeout' : 'model-failed',
          message: aborted
            ? `模型在 ${Math.round(TIMEOUT_MS / 1000)} 秒内没有返回结果，请重试。`
            : `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
        })
        return
      } finally {
        clearTimeout(timer)
      }

      const reason = terminal?.reason ?? { kind: 'stop' }
      const where = `${route.provider}/${route.model}`
      const cleaned = normalizeOutput(assembled)
      if (cleaned === '') {
        const detail = reason.kind === 'error' && reason.failure !== undefined ? `：${reason.failure.message}` : ''
        sendJson(res, 502, {
          code: 'empty-result',
          message: reason.kind === 'aborted'
            ? '改写已取消。'
            : reason.kind === 'max-tokens'
              ? `${where} 把输出预算全花在推理上，没有产出正文，换个模型或缩短草稿再试。`
              : `${where} 没有返回正文（finish=${reason.kind}）${detail}`,
        })
        return
      }

      sendJson(res, 200, {
        text: cleaned,
        model: where,
        truncated: reason.kind === 'max-tokens',
        ...usage === undefined || usage === null
          ? {}
          : {
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            },
          },
      })
    },
  }), 'composer-enhance: POST ' + ROUTE)
}
