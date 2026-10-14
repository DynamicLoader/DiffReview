# 验证记录

## 已通过

- Node.js 24.19.0；TypeScript 严格类型检查，针对 VS Code 1.96 公共 API 编译。
- `npm test`：19 项测试通过。
- 真实 Git 仓库：固定 commit 基线、staged / unstaged、重命名、删除、未跟踪文件、提交后仍读取原 base、特殊文件名、Git 参数传递。
- 锚点：插入/移动、撤销、片段变化、重复片段保守判断、上下文消歧、CRLF / LF。
- 扩展工作流：真实 Git/文件系统，**VS Code UI API 边界使用 mock**。覆盖右侧真实文件 URI、左侧虚拟基线、新增/删除文件、两侧评论、原生评论接口的数据处理、多行保存/取消、未保存缓冲区、解决状态、代码重新定位、剪贴板与 Markdown/JSON 导出、工作区状态恢复。
- `vsce package`：成功生成通用 VSIX，包内无运行时 npm 依赖。

## 未完成的验证

云环境能够下载并启动 VS Code 1.96.4 二进制，但限制系统/Unix socket，未能完成图形扩展宿主测试。**未将 UI mock 测试视为真实 VS Code 界面或 LSP 实测。**

`test/integration.cjs` 和 `scripts/integration.cjs` 提供真实宿主测试入口，可在本地运行。该测试包含 TypeScript 跨文件定义/悬浮、diff 文档身份、评论接口、未保存编辑和状态恢复。

C++ clangd、Remote SSH / Dev Container、Windows/macOS 和原生评论按钮交互仍需实机验收。

## 建议实机验收顺序

1. 安装 VSIX，打开原本 clangd 正常工作的项目。
2. 选择 `HEAD` 或其他 base，打开一个修改过的 C++ 文件；确认右侧 hover/F12 保持正常。
3. 在左右侧分别点 + 写多行意见，编辑/解决；重启后恢复。
4. 在被评论的代码上方插入几行，确认评论跟随；修改原片段，确认意见在树中变为 outdated。
5. 导出评审意见，核对路径、左右侧、代码片段和定位状态。

双栏布局遵循 VS Code 设置；窗口较窄时请在 diff 菜单选择 Side by Side，或按 README 设置关闭自动单栏。
