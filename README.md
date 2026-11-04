# ChatGPT Fold

一个面向 ChatGPT 网页的轻量 Chrome 扩展。每条助手回答保留一行摘要，点击即可展开，再次点击可以收起。

**版本：0.1.0 · 初版**

本次交付的实际检查结果见 [VALIDATION.md](docs/VALIDATION.md)：静态检查和 5 项策略测试通过；因缺少可用 Chromium，浏览器集成断言尚未运行。

本项目优先限制同时参与渲染的回答数量。默认只展开最新 1 条普通回答，阅读旧回答时自动收起其他普通回答。

## 这个版本能做什么

- 为每条支持的助手回答添加摘要和展开 / 收起按钮。
- 默认保留最新 1 条回答展开；可以设置默认展开最近 0–5 条。
- 限制同时展开的普通回答数量，范围为 1–5 条。
- 识别新回答和单页应用内的对话切换，重新应用折叠规则。
- 暂时保留正在生成、正在编辑或包含已选中文字的回答；这些保护条件可以暂时超过展开上限。
- 在扩展弹窗中收起全部、展开最近回答，或临时恢复整个页面。
- 只在本地保存偏好设置，不保存聊天正文，不上传数据，不加载远程脚本。

默认展开数量不能超过展开上限；保存设置时会将配置调整到有效范围。展开上限为 1 时，手动打开一条旧回答会让其他不受保护的回答收起。

## 内存优化的边界

初版通过 `display: none` 隐藏原回答的内容容器。浏览器无需继续为隐藏正文保留正常的布局和绘制结果；能否以及能节省多少内存，需要在真实对话上测量。

**原回答 DOM、ChatGPT 的 JavaScript 对象和 React 状态仍然存在。** 这个版本不会卸载原站组件，也不会把聊天正文序列化成副本。折叠后的 DOM 节点数量不会因此大幅减少，JavaScript 堆也不保证下降。

因此，初版的目标是减少同时显示的内容和渲染负担，不能保证解决所有长对话崩溃，也没有预设的“节省百分比”。如果页面主要占用来自站点自身的数据和组件状态，收益可能有限。详见[架构说明](docs/ARCHITECTURE.md)和[内存验证方法](docs/TESTING.md#内存验证)。

当前还没有对已登录的真实 ChatGPT 页面完成兼容性验收。网页结构变化可能影响识别；已识别但不支持折叠的结构会保留原内容，弹窗报告对应数量。如果页面完全没有支持的角色标记，弹窗显示已识别 0 条，扩展不会猜测并隐藏其他内容。

## 安装：无需 npm，也无需构建

要求 Chrome 109 或更新版本。

1. 下载并解压整个工程。
2. 在 VS Code 中选择 **文件 → 打开文件夹**，打开 `chatgpt-fold`；也可以打开工程中的 `chatgpt-fold.code-workspace`。
3. 在 Chrome 地址栏输入 `chrome://extensions`。
4. 打开右上角的 **开发者模式**。
5. 点击 **加载已解压的扩展程序**，选择包含 `manifest.json` 的 `chatgpt-fold` 根目录。
6. 刷新已经打开的 [ChatGPT](https://chatgpt.com/) 标签页。
7. 建议将扩展固定到工具栏，方便打开设置和查看状态。

安装前先暂时停用其他隐藏 / 折叠 ChatGPT 对话的扩展，以便确认本扩展的实际效果。完成独立测试后，再决定是否一起使用。

加载失败时先确认选中的是包含 `manifest.json` 的目录，而不是 ZIP 文件或其上一级目录。Chrome 官方的[加载未打包扩展说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)提供了相同流程。

### 日常使用

- **阅读回答：** 点击回答上方的摘要栏展开，再次点击收起。
- **默认策略：** 最新 1 条普通回答展开，其他回答折叠为一行摘要。
- **修改策略：** 点击扩展图标，设置默认展开最近几条以及同时展开上限。
- **恢复查看：** 在弹窗中临时恢复本页；之后继续折叠，重新应用当前设置。
- **关闭扩展效果：** 在弹窗中关闭启用开关；已处理的回答恢复显示。

正在生成、编辑或包含文字选区的内容会受到保护。此时显示数量可能超过设置上限；保护解除后再由扩展重新评估。

### 搜索历史内容

Chrome 的原生 `Ctrl+F` / macOS `⌘F` 无法可靠搜索 `display: none` 隐藏的正文。

需要搜索整段对话时，先在扩展弹窗中选择 **临时恢复本页**，再使用浏览器搜索。查看完成后继续折叠。临时恢复期间会重新显示所有已识别正文，因此也会恢复相应渲染负担。

### 修改源码后更新扩展

1. 保存文件。
2. 打开 `chrome://extensions`，点击 ChatGPT Fold 卡片上的重新加载按钮。
3. 刷新 ChatGPT 页面，使新的内容脚本生效。

只重新加载扩展不会自动替换已经注入到旧标签页中的全部内容脚本。

## 设置与权限

| 项目 | 默认值 | 含义 |
| --- | --- | --- |
| 启用 | 开启 | 对支持的 ChatGPT 回答应用折叠 |
| 默认展开最近几条 | 1 | 范围 0–5，决定自动初始化 / 恢复策略 |
| 同时展开上限 | 1 | 范围 1–5，约束不受保护的回答 |
| 临时恢复本页 | 关闭 | 仅当前页面暂停折叠，便于搜索和排查 |

扩展仅声明 `storage` 权限，内容脚本仅匹配 `https://chatgpt.com/*`。不申请所有网站访问权限，不读取浏览历史，不调用模型接口，也不拦截 ChatGPT 的请求。

偏好保存在 `chrome.storage.local`。摘要用于当前页面显示，不作为聊天记录写入存储。更多信息见[隐私说明](PRIVACY.md)。

## 工程结构

```text
chatgpt-fold/
├── manifest.json              Chrome Manifest V3 清单
├── src/
│   ├── shared.js              默认值、配置校验和通用逻辑
│   ├── adapter.js             ChatGPT 页面结构识别
│   ├── content.js             折叠状态和页面观察
│   ├── content.css            页面内控件及折叠样式
│   ├── popup.html
│   ├── popup.css
│   └── popup.js               扩展弹窗
├── icons/                    扩展图标
├── scripts/check.cjs         语法与清单检查
├── tests/
│   ├── *.test.cjs             Node 自动测试
│   ├── browser-smoke.cjs      模拟页面浏览器测试
│   └── fixtures/chat.html     合成对话页面
├── docs/
│   ├── ARCHITECTURE.md
│   └── TESTING.md
├── PRIVACY.md
└── README.md
```

### 开发检查

直接安装扩展不需要 Node.js；运行开发检查需要本机安装 Node.js 20 或更新版本。

```bash
npm test
npm run check
```

这两项检查不需要安装第三方 npm 依赖。`npm test` 使用 Node 内置测试运行器，入口是 `node --test tests/policy.test.cjs`，不依赖终端的通配符展开。

可选的模拟页面浏览器测试使用 Playwright：

```bash
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

这项测试会下载开发用依赖和 Chromium；它不是运行扩展的必需步骤，也不能代替在真实 ChatGPT 页面上的手动验收。具体场景和验收清单见[测试说明](docs/TESTING.md)。

## 手动推送到 GitHub

在 GitHub 上创建一个新的空仓库，例如 `chatgpt-fold`。创建时不要预填 README、`.gitignore` 或 License，避免与本地已有文件产生初始化冲突。

在 VS Code 的终端进入工程根目录，执行：

```bash
git init -b main
git add .
git commit -m "Initial ChatGPT Fold MVP"
git remote add origin https://github.com/YOUR_USERNAME/chatgpt-fold.git
git push -u origin main
```

把 `YOUR_USERNAME` 换成你的 GitHub 用户名，仓库名也应与实际创建的名称一致。第一次推送时按 GitHub / Git Credential Manager 的提示登录。不要把访问令牌写进源码或提交到仓库。

以上命令适用于一个尚未初始化的本地工程；如果你已经初始化 Git 或设置过 `origin`，先用 `git status` 和 `git remote -v` 查看现有状态，再执行缺少的步骤。

后续修改后：

```bash
git add .
git commit -m "Describe the change"
git push
```

## 已知限制与后续方向

- 此版本只处理助手回答，保留用户问题原样，暂不实现视口虚拟化。
- 原回答内容仍由站点保有；无法保证 JavaScript 堆或 Chrome 进程总内存按折叠数量同比下降。
- 页面选择器、生成状态和编辑控件会随 ChatGPT 更新，需要实测和维护。
- 助手正文之外的独立思考区或工具卡片可能不在当前折叠范围内。
- 当前页面的临时展开状态不作为历史记录持久保存；重新加载页面后重新应用偏好。
- 原生搜索需要先恢复正文；某些富交互内容、嵌套滚动区域和其他扩展可能需要额外适配。

下一步应先在你的典型长对话中记录真实收益和兼容性结果，再决定是否继续做视口虚拟化。优先验证的指标是 Chrome 任务管理器内存、JavaScript 堆、DOM 数量和滚动响应，而不是仅凭页面变短判断优化成功。

## 参考与许可

- [Chrome：内容脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome：扩展入门与加载](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Chrome DevTools：排查内存问题](https://developer.chrome.com/docs/devtools/memory-problems)
- [web.dev：content-visibility 与渲染开销](https://web.dev/articles/content-visibility)

使用 [MIT License](LICENSE)。本项目为独立开发的浏览器扩展，与 OpenAI 没有官方关联。
