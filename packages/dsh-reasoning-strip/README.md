# @logictan/dsh-reasoning-strip

在**适配器边界**剥掉助手历史里的推理块（chain-of-thought），对**所有 provider** 生效。

## 它解决什么

DSH 无损记录助手的每一轮：`reasoning` 内容块保存 provider 自己的思维链，`source.replayState` 保存描述它的原生回放元数据。下一轮请求会把两者原样回放。当 provider 把推理当作一等回放字段时，它会把自己先前的思考当作新上下文重新读入 —— 表现就是退化的「Okay. / Now. / Tool call.」续写循环。

本插件在适配器看到请求之前的最后一刻移除推理块，以及描述它的那条回放块。会话日志、对话记录和界面**照常保留推理**，变的只是发往上游的内容。

## 为什么接缝是 `forAdapter`

这是唯一能改写 `messages` 的接缝：

- `llm/stream` 瀑布**不行**。`cordis` 的 `waterfall` 闭包捕获了参数列表，`next(replacement)` 会被静默丢弃；而且循环构造的请求本身是深度冻结的。
- `prepared.stream` **不行**。`LlmRuntime.prepareCall` 返回 `Object.freeze` 的对象，属性无法替换。

`forAdapter` 位于两者之下，因此 `llm/stream` 瀑布（以及依赖 `isAgentLoopRequest` 的循环请求不变量与所有消费者）仍然看到未被改动、带标记的请求，而每个适配器（包括不走 `prepareCall` 的）都看到已剥离的历史。`callConfigEquals` 不比较 `messages`，因此预备调用守卫不会被触发。

## 安装

本包随聚合包 `@logictan/dsh-plugins-all` 一起安装，无需单独操作。安装后自动生效，没有任何开关。

## 构建与测试

```bash
pnpm install
pnpm --filter @logictan/dsh-reasoning-strip build
pnpm --filter @logictan/dsh-reasoning-strip test
```

## 许可证

MIT
