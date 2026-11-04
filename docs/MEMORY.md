# 可重复的内存与更新开销基准

`tests/memory-benchmark.cjs` 在独立 Chromium 中生成固定的合成对话，比较不加载扩展、当前折叠实现，以及可选的旧版本。它帮助检查两件事：折叠改变了哪些浏览器指标；持续更新与历史节点卸载后，扩展自身的记录和工作量是否受到控制。

**这不是实际 ChatGPT 标签页的总内存测量，也不是不会崩溃的证明。** 测试没有登录、真实聊天数据、React、图片解码、工具面板或原站的数据缓存。页面使用真实 DOM、CSS、MutationObserver 和定时器，但 Chrome 扩展 API 由测试替身提供；脚本和样式通过测试注入，其固定开销与真实内容脚本的隔离环境不同，没有验证真实 MV3 注入。

## 运行

需要 Node.js 20+、Playwright 和本地 Chromium；这些仅用于开发验证，安装扩展不需要它们。

```bash
npm install --no-save playwright
npx playwright install chromium
npm run bench:memory -- --quick --output artifacts/memory/smoke.json
```

正式对照默认运行 3 次独立重复：

```bash
npm run bench:memory -- --output artifacts/memory/current.json
```

也可以加载旧版本内容脚本，与当前版本在同一次运行中比较。下面的提交是已合并的 0.1.5：

```bash
git worktree add --detach ../chatgpt-fold-v015 7d69c4187dec9184730f0398bd7c6d864e20ed5f
npm run bench:memory -- --compare ../chatgpt-fold-v015 --output artifacts/memory/v015-comparison.json
```

`--output` 必须指定一个尚不存在的 `.json` 文件，避免意外覆盖上一次结果。`artifacts/` 已在 `.gitignore` 中；原始测量不是扩展运行文件。脚本逐个场景写入结果，只有所有场景完成后才设置 `complete: true`；中途失败会保留 `complete: false` 和 `error`，不能当作完整验证。

`--help` 列出全部参数。可通过 `--counts 100,300,600`、`--window 20`、`--turns 1200`、`--updates 24`、`--repeats 3` 调整工作量。`--quick` 将默认值缩小为 20/60 条已挂载回答、累计 100 条、每阶段 4 次更新、1 次重复；适合检查工具能否运行，不能替代长期趋势测量。显式参数覆盖对应默认值。

浏览器可通过 `CHROME_PATH` 或 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定。Playwright 可通过 `CGF_PLAYWRIGHT_MODULE` 或 `CODEX_PRIMARY_RUNTIME_NODE_MODULES` 查找。缺少浏览器或 Playwright 时输出 `NOT RUN` 并返回退出码 2，不会误报通过。场景异常、浏览器崩溃或结构断言失败返回退出码 1。

## 三类场景

| JSON 中的场景名 | 默认工作量 | 回答的问题 |
| --- | --- | --- |
| `all-mounted` | 分别保留 100、300、600 条完整回答 DOM | 折叠会如何影响布局对象、JS 堆、嵌入器 GC 堆；扩展控件自身增加多少节点 |
| `fixed-window-no-data-cache` | 同时保留 20 条，逐批生成并移除旧节点，累计到 1200 条 | 站点确实移除旧节点时，扩展记录、队列和断开节点是否随之清理 |
| `paced-updates` | 最大 `--counts` 对话规模；末条回答有明确生成标记；分别进行 24 次文字更新、24 次普通标记替换 | 普通生成内容是否仍引发整个历史的身份识别、发现与状态扫描 |

每条合成回答包含 4 段文字和 18 行代码，每行有 4 个着色 `span`。各版本使用相同数据、1100×900 视口和折叠配置：默认最近 1 条、最多展开 1 条。

固定窗口的每批追加少于窗口大小，保留原来的末尾锚点，然后移除最早节点。测试只保留累计条数这个数字，**不保留被移除回答的数据数组、HTML、节点或历史消息表**。它检验扩展在此条件下的行为；真实站点若保留自己的全部对话数据，结果可能不同。

更新阶段只在现有回答内部修改文字节点，或替换普通 `span` / `code`，不改变消息身份、作者角色、可见性、生成标记或回答边界。每次更新后等待 180 毫秒，长于扩展的 120 毫秒批次间隔，让每次更新都有独立处理机会。它针对普通内容更新的开销，不代表身份、结构或保护状态变化也应该跳过完整检查。

各重复轮换运行顺序，降低固定先后顺序的影响。每个模式 / 场景使用新的浏览器进程；固定窗口的各检查点在同一页面中连续运行。源码在开始时读入，之后所有重复使用同一份快照，避免执行过程中修改仓库导致前后混用。JSON 记录内容脚本、样式和清单的 SHA-256，以及仅供定位的 Git HEAD；工作目录存在未提交修改时，应以文件哈希识别实际测试内容。

## 如何采样

每个内存检查点先等待批次完成，滚动到尾部并完成布局，再等待两个动画帧。脚本只读取普通数值，不调用控制器的 `status()`、`rescan()`、`flush()` 或诊断方法，避免测量动作本身触发修复。

随后分别记录：

1. `documentCounts`：当前 DOM 与扩展集合的计数。
2. `beforeGC`：尚未主动收集垃圾的浏览器指标。
3. 连续两次 `HeapProfiler.collectGarbage`，再等待 120 毫秒。
4. `afterGC`：主动收集后的同类指标。

主动 GC 是为了提高不同检查点之间的可比性；它不等于普通使用时会立即发生的回收，也不表示 Chrome 已把对应内存归还操作系统。不要只用 `afterGC` 宣称点击收起后的即时收益。

测试不在页面控制台输出 DOM 对象，不保存 ElementHandle，也不保留跨检查点的消息节点。所有网络请求由合成页面路由拦截，无法读取当前账号或真实对话。

## 字段和边界

| 字段 | 来源与含义 | 不应据此推断 |
| --- | --- | --- |
| `performance.JSHeapUsedSize` / `JSHeapTotalSize` | `Performance.getMetrics` 的 JS 堆指标，单位字节 | DOM、布局、图片、GPU、整个标签页或整个浏览器的总占用 |
| `performance.LayoutObjects` | 同一 CDP 指标集中的布局对象数量 | 同样数量必定对应固定的字节数 |
| `dom.documents` / `dom.nodes` / `dom.jsEventListeners` | `Memory.getDOMCounters` 的计数 | `nodes` 全部都是当前仍连接在文档中的节点 |
| `runtimeHeap.usedSize` / `totalSize` | `Runtime.getHeapUsage` 的 JS 堆使用量 / 容量 | 与前一组 JS 指标相加得到更多内存；它们是不同调用时点的相关指标 |
| `runtimeHeap.embedderHeapUsedSize` | 浏览器嵌入器由 GC 管理的堆使用量，单位字节；实验性字段 | 全部原生内存、RSS、显存、标签页总内存 |
| `runtimeHeap.backingStorageSize` | 协议报告的 ArrayBuffer / 外部字符串后备存储量 | 与其他项一定不重叠、能简单相加得到总占用 |
| `documentCounts.connectedElements` | 当前文档中的元素数量 | 包含文本节点的完整 DOM 节点总数 |
| `records` / `disconnectedRecords` / `queuedScanRoots` / `queuedRecordUpdates` | 扩展当前持有的回答和待处理集合数量；旧版本没有的字段为 `null` | 每条记录占用固定字节数，或原站没有其他节点引用 |
| `openIntents` | 扩展保留的少量展开选择数量 | 当前 DOM 中已展开回答的精确数量；临时保护和卸载可能让两者不同 |
| `workCounts` | 新版本固定大小的累计工作计数；旧版本为 `null` | 页面总 CPU 时间或历史消息数量 |

可选指标缺失时记为 `null`，不是 0。`runtimeHeap.available` 仅表示该方法是否可调用，具体字段仍可能缺失。基准不采集 RSS / PSS、GPU 内存或 Chrome 任务管理器数据，也没有“低于某个 MB 就不会崩溃”的阈值。

`baseline` 没有加载扩展，控制器字段为 `null`；`controls` 和 `expanded` 统计的是扩展标记，因此为 0 不表示原回答被隐藏。

更新场景另外记录两组数据：

- `phases[].adapter.calls` 和 `elapsedMs`：固定数量的适配器入口计数器及该入口累计时间。包装发生在 `adapter.js` 加载后、`content.js` 捕获适配器前，每个阶段重新清零。只统计导出的调用边界，不统计其内部每一个辅助函数；不保存逐次事件或节点。只有更新场景启用，内存主场景不启用这些包装。
- `phases[].durationDeltaMs`：CDP 报告的 Task / Script / Layout / RecalcStyle 时长增量，单位毫秒。包括该合成页面与测试驱动的影响，不是精确隔离后的扩展 CPU 使用量。`elapsedMs` 是阶段经过的墙钟时间，包含 `requestedWaitMs`；不能用它把固定等待误读成扩展耗时。入口计时本身也有开销，跨版本比较应保持相同参数与环境。

## 如何判断结果

先检查 `complete: true`、实际源码哈希和浏览器版本，再比较同一配置下多次重复的中位数及范围。不要比较不同 Chrome 版本、不同内容规模或不同 GC 时点的单个数字后直接宣布改善百分比。

固定窗口场景会对正确性做断言：当前记录数等于已挂载回答数、没有断开节点记录、控件不重复、展开选择不超过配置、处理队列在稳定后为空。绝对堆大小、时间和节省比例不设自动通过线；它们应由多次结果和趋势解释。

常见的合理读法：

- 完整 DOM 仍保留时，折叠后布局对象下降，而 DOM 节点和 JS 堆可能因为控件与状态略增。这两者可以同时发生。
- 固定 20 条窗口累计处理更多回答后，记录数仍为 20，说明扩展没有把所有旧记录继续存入当前集合；是否还有其他引用泄漏，需要结合堆快照与长期走势继续查证。
- 普通更新阶段中，旧版本反复调用 `identity`、`collect`、`hasVisibleStop` 等，新版本降至 0 或接近 0，能说明这一条更新路径减少了重复扫描；不能直接换算为整个标签页节省多少 MB。
- 真实站点保留的数据增长时，限制扩展记录或 DOM 窗口仍可能无法限制站点 JS 堆。本基准没有模拟其内部数据结构，不应推断 ChatGPT 实际数据保留策略。

真实页面仍需使用相同浏览器、同一对话、相近滚动与生成步骤作对照，记录 Chrome 任务管理器的 Memory footprint、JavaScript memory、DOM 数量以及响应情况。不要为测量而一次性展开全部长历史；优先在可以稳定运行的内容规模比较，再逐步增加。

## 指标参考

- [Chrome DevTools：排查内存问题](https://developer.chrome.com/docs/devtools/memory-problems)
- [CDP：Performance.getMetrics](https://chromedevtools.github.io/devtools-protocol/tot/Performance/#method-getMetrics)
- [CDP：Memory.getDOMCounters](https://chromedevtools.github.io/devtools-protocol/tot/Memory/#method-getDOMCounters)
- [CDP：Runtime.getHeapUsage](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage)
- [CDP：HeapProfiler.collectGarbage](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-collectGarbage)

实际执行的版本、场景和结论写入 [VALIDATION.md](VALIDATION.md)；0.1.6 的完整三轮原始记录随仓库保存于 [benchmarks/v0.1.6.json](benchmarks/v0.1.6.json)。本文件说明如何复现及如何读数，不预先承诺后续环境的测试结果。
