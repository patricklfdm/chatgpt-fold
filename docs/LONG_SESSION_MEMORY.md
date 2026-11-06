# 长对话：记录新增回答和翻阅时的进程内存

这项实验只回答两个问题：**使用过程中，目标 Chrome 进程最高采到多少内存？回到同一条已完成回答的末尾后，读数是否持续抬升？** 不用在网页 Console 粘贴脚本，也不需要重装扩展。

## 在自己的电脑上跑一次

适用于 **Windows 或 Linux 桌面、Node.js 20+**。在运行 Chrome 的那台电脑用 VS Code 打开仓库；Windows 用户请用原生 Windows 终端，不要在 WSL、远程服务器或开发容器里读取桌面 Chrome 的 PID。记录器没有第三方 npm 依赖。

1. 打开要观察的 ChatGPT 对话，保持平常使用的折叠设置。等生成结束，停在**最新回答末尾**。测量期间使用同一会话、同一窗口尺寸和相同设置。
2. 打开 **Chrome 自己的任务管理器**：Windows / Linux 通常按 **Shift+Esc**，也可从 Chrome 菜单的「更多工具 → 任务管理器」打开。右键表头，显示「**进程 ID / Process ID**」。找到这个 ChatGPT **标签页**对应的行，记下数字；不要选 Browser、GPU、Extension、Subframe 行。程序只接受数字，无需复制标题或整行。
3. 在**仓库根目录的终端**运行下面的命令，按提示输入 PID 并回车，然后切回 Chrome。最初约 15 秒留在末尾，不发送、不翻页。终端提示「新增回答」后进入第一组。

```sh
npm run study:memory
```

默认三组，每组在终端只标记两次：

| 做什么 | 在终端输入什么 |
| --- | --- |
| 正常聊天，建议每组新增 2 条已完成的助手回答。最后一条生成结束，停在末尾 | **本组**实际新增的回答数，例如 `2`，回车；切回 Chrome，在末尾静置约 15 秒 |
| 见到「翻阅」提示后向上翻约 3 屏，再返回**刚才同一条回答的末尾**。期间不发新消息，尽量不额外展开组件 | **直接回车**；切回 Chrome，再静置约 15 秒 |

不必为了测试发送固定话术。每组可以新增不同数量（1–99），但不要输入整个会话的总数。等终端提示进入下一阶段再继续；如果方便，可以把终端放在旁边看提示。窗口大小从开始到结束保持一致即可。

完成三组后，采样会先停止。再看一次 Chrome 任务管理器中**同一标签行**的 PID，把**现在看到的数字**输入终端；无法确认则直接回车。程序打印本次结果路径，**只需提供本次的 `summary.json`**。

- 需要提前结束：输入 `q` 回车，再按提示复核 PID。已有完整组仍可分析。
- 已知发生刷新、切换会话、标签页重载或迁移到另一进程：输入 `x` 回车终止，不把两段拼接。中途换过又换回原进程，仅靠首尾 PID 相同也无法自动排除。
- 记录最长 1 小时；停止后最多另等 2 分钟复核。目标退出、身份变化或访问失败时保留已有记录，不会自动改采其他 Chrome 进程。不需要提权；无法取数时用下方手工方法。

## 读 `summary.json`

默认每秒尝试读取一次。基线 `baseline`、每组翻阅前 `pre` 和返回后 `post` 的安静窗口都是**向前**取样：标记后预留 3 秒切回浏览器，再取接下来 12 秒。程序不知道网页是否真的停止生成或回到末尾，这些条件由操作者确认。窗口的最小值、中位数、最大值和样本数可用于检查波动；中位数不等于稳定性证明。

| 看哪里 | 怎么解释 |
| --- | --- |
| `reason`、`pidCheck`、`allRoundsFinished`、`allWindowsValid` | 完整三组的理想结果分别是 `completed`、`same`、`true`、`true`。`status: finished` 只表示记录已结束 |
| `overall.sampledPeakBytes`、`sampledPeakPhase`、`sampledPeakRound` | 从基线标记到最后一个返回窗口结束（或提前停止）期间，**实际采到**的最高主指标及所属阶段；不含最终 PID 复核等待，可能漏掉两次读取之间的尖峰 |
| `baseline.medianBytes`；每组 `pre.medianBytes`、`post.medianBytes` | 同一阶段的安静窗口主指标中位数；看 `valid`、`validSamples`、`maxGapMs` 及 `minBytes` / `maxBytes` 判断是否可比较 |
| `postMinusPreBytes` | 同一组、**相同内容和末尾**，翻阅后减翻阅前；正数表示该组返回后的读数更高 |
| `postMinusBaselineBytes`、`cumulativeNewTurns` | 本组返回后减最初基线，以及累计增加了几条回答。跨组已新增内容，比较的是不同消息处的会话增长，不是同一消息的泄漏量 |
| 每组 `append.sampledPeakBytes`、`scroll.sampledPeakBytes` | 新增回答阶段与翻阅阶段分别采到的峰值。各阶段的样本数和最大缺口一起看 |

内存字段单位为**字节**；终端显示的 MiB = 字节数 ÷ 1,048,576。正负差都可能出现。每窗默认至少 11 个有效正数，首尾及相邻有效读数之间没有超过 1.75 秒的覆盖缺口，窗口没有坏读数并完整结束，才标为有效。跨越采样阶段边界的读数不硬塞入其中一侧。报告仍可显示不完整窗口的局部读数，但不会据此计算正式差值。

若末次 PID 未核对或不同、读数失败，或对应配对窗口无效，正式差值为 `null`，并非零变化。提前 `q` 停止并复核成功时，只分析已完成且有效的配对组。不要把一个进程消失直接判定成 OOM，也不要从一次峰值或几组增长推出内存泄漏。本实验保持扩展处于同一设置，不能给出安装与不安装扩展之间的因果差异。不同轮次内容、原站缓存、进程共享、后台活动等仍会影响结果。

## Windows、Linux 和 Chrome 任务管理器的口径

记录的是**一个用户指定的 OS 进程**，不是直接读取 Chrome UI，也不是整个标签页独享的 RAM。不同标签可能共享 renderer，iframe 也可能使用其他 renderer；浏览器、GPU 等其他进程未计入，同一 PID 的多行不能重复加总。见 [Chromium 多进程架构](https://www.chromium.org/developers/design-documents/multi-process-architecture/)。

| 平台 | 主指标（报告 `metric`） | 辅助指标 |
| --- | --- | --- |
| Windows | `windows-private-bytes`：通过系统 Windows PowerShell / .NET 读取所选进程的 `PrivateMemorySize64`，对应 Private Bytes，即该进程的私有提交内存。它可以包含未驻留在 RAM 的页 | `WorkingSet64`，当前工作集，含驻留的私有和共享页 |
| Linux | `linux-anon-rss-plus-swap`：所选 PID 的 `/proc/.../status` 中 `RssAnon + VmSwap`，从 KiB 转成字节。它不是 Windows 的私有提交量 | `VmRSS`，含共享部分的驻留集；Linux 的这组进程计数本身也是近似读数 |

辅助工作集、主指标和 JS 堆**不能相加**为总内存，也不要直接做跨平台数值对比。Windows 采集器会刷新进程信息并校验创建时间；Linux 固定打开的进程目录，在读状态前后校验启动身份。它们都不能判断用户是否选中了正确的标签行。

指标的选取有固定版本来源：Chromium **156.0.8078.80** 的[任务管理器列映射](https://github.com/chromium/chromium/blob/156.0.8078.80/chrome/browser/ui/task_manager/task_manager_table_model.cc)和[取样实现](https://github.com/chromium/chromium/blob/156.0.8078.80/chrome/browser/task_manager/sampling/task_manager_impl.cc)使用进程的 `private_footprint_kb`。[平台换算](https://github.com/chromium/chromium/blob/156.0.8078.80/services/resource_coordinator/memory_instrumentation/queued_request_dispatcher.cc)在 Windows 使用 `private_bytes`，Linux 使用匿名驻留量与交换量之和；Windows 的[OS 取样](https://github.com/chromium/chromium/blob/156.0.8078.80/services/resource_coordinator/public/cpp/memory_instrumentation/os_metrics_win.cc)和[进程计数实现](https://github.com/chromium/chromium/blob/156.0.8078.80/base/process/process_metrics_win.cc)可追到 `PrivateUsage`。这些是取数口径的依据，**不是对用户实际 Chrome 构建、界面刷新时刻或舍入后的逐点相等保证**。

官方字段说明：[Microsoft PrivateMemorySize64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.privatememorysize64)、[WorkingSet64](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.workingset64)、[Win32 PrivateUsage / Commit Charge](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)、[Linux /proc 字段](https://docs.kernel.org/filesystems/proc.html)。

## 不运行脚本时的手工方法（包括 macOS）

macOS 暂无自动读取器；没有 Node.js 或受系统限制时也可按相同流程手记。打开 Chrome 任务管理器，显示 **Memory footprint、JavaScript memory（可选）、Process ID**。对同一标签行，分别在基线、每组生成完成的末尾、翻阅后回到同一末尾并静置后记下显示值和单位；另记使用中**亲眼看到**的最高值。如 JS memory 显示两个数，单独记录括号里的 live 数；看不到或没记就填「未测」。不要提供整页截图、标签标题或 PID 数字，只说明首尾是否同一进程即可。[Chrome 官方任务管理器内存说明](https://developer.chrome.com/docs/devtools/memory-problems#monitor-memory-use-in-realtime-with-the-chrome-task-manager)

手工数据可以按“阶段｜本组新增条数｜Memory footprint｜JS live（可选）”提供。几个手记点不是连续采样峰值，也不冒充 12 秒窗口中位数。Windows / Linux 自动记录时，同样可以用这一方法交叉核对量级；自动报告本身未读取 UI 列值或 JS 堆。

## 输出和数据范围

每次创建新的 `artifacts/long-session/run-*/` 目录。`trace.jsonl` 逐条记录相对开始经过的毫秒、阶段、回合数与 OS 计数；`summary.json` 保存阶段汇总并定期更新。异常中断后可能仅有部分 trace 或 `status: recording` 的上次摘要；不要当作完整结果。新运行不覆盖旧目录，日常提供摘要即可。

记录器不访问网页、消息、DOM、剪贴板、窗口标题、命令行或会话 API；不会自动发送消息、强制 GC 或上传文件，不在扩展中增加权限。PID 和进程身份仅用于本地读取与核验，不写入 trace 或摘要。无需修改 Chrome 启动参数；开发者的独立合成测试环境不等于用户设备的实测。

## 开发验证

- `npm run test:long-session`：15 项统计和终端流程测试，覆盖跨阶段样本、缺采、提前结束、复核不一致、异常退出和文件保留。
- `node tests/long-session-chromium.cjs`：在独立 Linux Chromium 153、实际 0.1.7 内容脚本、模拟 Chrome API 和合成会话上运行。48 → 50 → 52 条，两组各上翻约 4 屏再返回同一末条。缩短时序的 5 个窗口有效，得到 56 个真实进程采样点；[本次原始结果](benchmarks/long-session-linux-smoke.json)用于复核采集流程，不用于推算用户设备的占用。
- `node tests/windows-process-memory.cjs`：需在 Windows 运行，验证实际系统计数、拒绝非 Chrome、进程终止与清理。使用专属测试进程，不会连接用户的浏览器。Linux 环境不将这项检查记作通过。
