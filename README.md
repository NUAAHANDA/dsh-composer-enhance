# dsh-composer-enhance

A single four-point star in the DeepSeek Harness composer that rewrites your draft in place into a clearer prompt, with a one-click back button.

输入框右侧一个四角星，点一下就用当前模型把草稿在输入框内改写成更清楚的提示词，并留一个一键撤回的返回按钮。

## What it does

While the composer has text, one star appears in its tool row. Clicking it sends the draft to the Host, which calls the model and writes the result straight back into the input box — still one editable paragraph, not a document. A back button appears beside the star as long as that rewrite is what the box holds; one click restores the text you had.

输入框有内容时，工具栏出现一个四角星。点击后草稿交给 Host 调模型，结果直接写回输入框，仍是一段可直接编辑的话，不会变成带标题和列表的文档。只要框里还是这次改写的结果，星形旁就有一个返回按钮，点一下就恢复原文。

- The rewrite follows the model chosen above the input box; the profile default model is the fallback.
- The rewrite runs with the lowest reasoning effort the chosen model advertises, so an answer comes back instead of the budget being spent on thinking.
- Output is normalized: fences, list markers, numbering and "改写后：" style labels are stripped and the lines are joined into one paragraph.
- If you edit the draft while a rewrite is running, the result is dropped rather than overwriting your newer text.
- Failures (no model configured, provider error, timeout, an answer that got truncated by a token limit) are reported beside the star, and the star stays usable.

- 改写使用输入框上方选中的模型，未选则用 profile 默认模型。
- 改写固定用该模型声明的最低思考档，避免推理吃掉全部输出预算而拿不到正文。
- 输出会做归一化：去掉代码围栏、列表符号、序号和「改写后：」这类前缀，多行合并成一段。
- 改写期间你手动改了草稿，结果会被丢弃，不覆盖你更新的文字。
- 没有可用模型、模型报错、超时、输出被 token 上限截断，都会在星形旁给出原因，星形仍可继续用。

## Cost and privacy

Each rewrite is one extra model request on the model you already picked; nothing is sent anywhere except that provider. The draft travels from the browser to the Host's own route (`POST /composer-enhance/enhance`) on the same origin, behind the composition's connection trust fence — the browser holds no credential and never talks to a provider directly. Rewritten text goes nowhere; it is only written back into your input box.

每次改写消耗一次你已选模型的调用，除该提供方外不发送到别处。草稿经同源的 Host 路由 `POST /composer-enhance/enhance` 传输，受组合的 connection 信任栅栏保护，浏览器不持有凭据、也不直连模型提供方。改写结果不会被发往任何地方，只写回输入框。

## Install

```sh
dsh plugin --profile <profile> add dsh-composer-enhance
```

Or install from a local checkout: in DSH open **Plugins** → **Add plugin** and pick this directory. Turn it off in the same list; nothing else changes when it is disabled.

本地目录安装：在 DSH 打开 **插件** → **添加插件**，选择本目录即可。停用也在同一列表里，停用后不残留任何东西。

Requires DeepSeek Harness 0.2.2 or newer. No peer dependencies, no build step.

需要 DeepSeek Harness 0.2.2 及以上；无额外依赖，无构建步骤。

## Manifest

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": false,
              "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
}
```

The Host half registers one POST route; the browser half registers one seat in `conversation.input.right`.

Host 半边注册一条 POST 路由；浏览器半边在 `conversation.input.right` 注册一个座位。

## Tests

```sh
npm test
```

`host.test.mjs` drives the route with mocked Cordis context, request and response objects (trust fence, method and content-type refusals, malformed bodies, no-model 503, empty and error finishes, effort validation, output normalization). `smoke.mjs` loads the client bundle through a fake module loader and renders the seat in every state: empty draft, busy composer, busy rewrite, failure note, and the back button.

`host.test.mjs` 用模拟的 Cordis 上下文、请求和响应驱动路由（信任栅栏、方法与 content-type 拒绝、畸形请求体、无模型 503、空结果与报错收尾、思考档校验、输出归一化）。`smoke.mjs` 通过假模块加载器加载客户端 bundle，并渲染座位的每个状态：空草稿、提交中、改写中、失败提示、返回按钮。

Both run offline in Node with no browser and no network.

两个测试都在 Node 里离线运行，不需要浏览器和网络。

## License

MIT
