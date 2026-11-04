# 本次交付的验证记录

版本：0.1.0。验证环境：Linux、Node.js v24.22.1。

这份记录区分已执行的检查、已经编写但尚未运行的浏览器用例，以及仍需真实页面验收的内容。

## 已执行并通过

### 扩展文件检查

命令：`node scripts/check.cjs`（等同于 `npm run check`）。

检查 Manifest V3、版本一致性、仅 `storage` 权限、仅 `https://chatgpt.com/*` 内容脚本匹配、清单引用文件存在、生产 JavaScript 语法、无动态代码执行和无扩展网络调用，以及弹窗不使用内联事件处理器。

### 策略自动测试

命令：`node --test tests/policy.test.cjs`（等同于 `npm test`）。

结果：**5 项通过，0 项失败**。

- 损坏或超范围配置仍受展开上限约束。
- 手动打开旧回答时，按照优先级收起其他普通回答。
- 生成、选择等临时保护不会被普通回答数量上限打断。
- 手动收起意图在临时保护结束后继续有效。
- 摘要截断保留完整 Unicode 字符，文字不作为 HTML 执行。

## 浏览器测试：尚未运行断言

工程包含 `tests/browser-smoke.cjs` 和合成聊天页面，共编写 15 项浏览器集成用例。测试脚本及 fixture 脚本已做语法检查；这 15 项浏览器断言尚未执行。

当前环境有 Playwright 包，但没有 Chromium / Chrome 二进制。尝试正常下载 Chromium 时，下载内容无法作为 ZIP 解压，安装失败。浏览器测试入口返回 **NOT RUN / 退出码 2**；没有把跳过记录为通过。

在具备 Chromium 的电脑上，可以运行：

```bash
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

默认模式在独立临时 profile 中加载真实 unpacked 扩展，使用完全拦截的合成页面。显式指定 `--mode=injected` 时改用模拟 Chrome API；两种模式都会标注自己的验证范围，不会访问用户真实会话。

## 尚未验证

- 已登录 ChatGPT 当前生产页面的 DOM 和生成状态兼容性。
- 原站所有代码、引用、附件、思考区和工具卡片交互。
- 某一真实长会话的内存降幅、峰值和连续浏览表现。

初版通过 `display: none` 隐藏内容，保留原始 DOM 和原站状态。这里没有提供实测内存节省百分比。真实会话验收方法见 [TESTING.md](TESTING.md)。
