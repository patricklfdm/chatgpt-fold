# 本次交付的验证记录

版本：0.1.2。验证环境：Linux、Node.js v24.22.1、Linkedom 0.18.15、Chromium 153.0.8010.0。

这份记录区分策略与 DOM 检查、真实 Chromium 中的合成页面回归，以及尚未执行的真实扩展和线上页面验收。

## 页面证据与适配范围

使用者提供的只读结构报告确认，选中的回答位于顶层 `conversation` 文档，旧作者 / turn / Markdown 类等已检查标记均为 0；祖先包含 `data-chatgpt-search-message-ids` 与 `data-talvt-turn-state`。这排除了“选中回答位于 iframe 或 Shadow DOM”对这条回答的解释，也说明旧选择器不足以覆盖该页面。

探针有意不导出 unit key 等原始值，因此报告没有证明新 unit key 或助手正文属性不存在。0.1.2 依据上述线索和[架构说明中的作者实测资料](ARCHITECTURE.md#页面结构与识别边界)加入新页面家族规则。下面的自动测试只验证规则在合成结构上的行为，尚未直接在使用者当前会话验证新版识别结果。

## 已执行并通过

### 扩展文件检查

命令：`node scripts/check.cjs`（等同于 `npm run check`）。

检查 Manifest V3、版本一致性、仅 `storage` 权限、仅 `https://chatgpt.com/*` 内容脚本匹配、清单引用文件存在、生产 JavaScript 语法、无动态代码执行和无扩展网络调用，以及弹窗不使用内联事件处理器。

结果：**通过**。

### 策略自动测试

命令：`node --test tests/policy.test.cjs`（等同于 `npm test`）。

结果：**5 项通过，0 项失败**。

- 损坏或超范围配置仍受展开上限约束。
- 手动打开旧回答时，按照优先级收起其他普通回答。
- 生成、选择等临时保护不会被普通回答数量上限打断。
- 手动收起意图在临时保护结束后继续有效。
- 摘要截断保留完整 Unicode 字符，文字不作为 HTML 执行。

### DOM 适配器回归

命令：`node tests/adapter-dom.cjs`（等同于 `npm run test:dom`）。测试使用 Linkedom **0.18.15**，从独立测试依赖目录加载，没有添加扩展运行时依赖。

结果：**20 组通过，0 组失败**。

合成 HTML 检查涵盖角色优先级、非 `article` 助手 turn、通用内容不误识别、用户角色冲突、嵌套去重、角色属性移除与删除节点后的祖先扫描范围、直接文本保护，以及诊断字段与敏感值隔离。0.1.2 扩展了现代助手单元、消息标识与正文的补充识别、混合轮次用户保护、单独标识不推断作者、冲突身份与多段正文的分组边界、现代属性移除后的祖先发现和 schema 2 诊断等场景。

这些测试执行 `adapter.js` 和 `scanRoot()`，未执行 Chrome 的 CSS 布局、控制器 `MutationObserver` 时序、扩展注入或真实 ChatGPT 页面。因此，它们不能替代下面的浏览器和线上验收。

## 合成页面浏览器回归：注入模式通过

执行入口：`node tests/browser-smoke.cjs --mode=injected`，通过 `CHROME_PATH` 指定本地 Chromium 可执行文件。也可使用 `npm run test:browser -- --mode=injected`。

结果：**27 组通过，0 组失败，退出码 0**。运行环境为 Chromium **153.0.8010.0** 与 Playwright，页面为工程自带的合成聊天内容。

该模式执行实际页面脚本、CSS 和浏览器 `MutationObserver`，覆盖折叠 / 展开、动态内容、保护条件、清理与诊断。Chrome 扩展 API 由测试脚本模拟，所以这些通过结果不验证真实扩展权限、隔离环境注入或 Chrome 扩展消息管道。

保留 0.1.1 的 21 组回归，包含非 `article` 容器、祖先重扫、暂停 / 禁用重扫、诊断隐私与 `body` 替换。0.1.2 新增 6 组浏览器回归：

- 仅使用现代标记的对话初始化、展开上限、原节点 / 原生事件保留和用户提问可见性。
- 消息标识与助手正文的补充识别及分组。
- 现代用户标记、混合容器和冲突角色的保护。
- 仅属性变化时的自动重新识别；测试不通过状态查询帮助恢复。
- 隐藏工作区的 class / style / hidden / aria-hidden / role / 时间线标记切换，以及 `display:contents`、屏幕外和可见 `inert` 内容的处理。
- 输入区内英文 / 中文 Stop、隐藏或无关 Stop 的排除，以及 composer 标记单独变化。

完整测试未出现页面脚本错误或持续的自触发 mutation 循环。这仍不构成所有真实站点交互或长时间内存表现的证明。

在具备 Chromium 的电脑上，可以复跑注入模式：

```bash
npm install --no-save playwright
npx playwright install chromium
npm run test:browser -- --mode=injected
```

**默认真实扩展模式本次未运行。** 该模式使用独立临时 profile 加载未打包的 MV3 扩展，并完全拦截测试页面请求。去掉 `--mode=injected` 即可选择它；它与注入模式都会标注验证范围，不会访问用户真实会话。缺少依赖或浏览器时，入口仍返回 **NOT RUN / 退出码 2**，不会将未执行当成通过。

## 尚未验证

- 真实 Chrome MV3 扩展加载、权限与隔离环境消息交互。
- 已登录 ChatGPT 当前生产页面的 DOM 和生成状态兼容性。
- 新增现代识别规则在使用者这段实际会话上的命中与交互结果；报告已经明确旧标记缺失，但没有导出全部新属性值。
- 原站所有代码、引用、附件、思考区和工具卡片交互。
- 某一真实长会话的内存降幅、峰值和连续浏览表现。

初版通过 `display: none` 隐藏内容，保留原始 DOM 和原站状态。这里没有提供实测内存节省百分比。真实会话验收方法见 [TESTING.md](TESTING.md)。
