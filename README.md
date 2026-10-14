# Diff Review

本地 Git diff 评审插件：任意 Git 基线 → 当前工作区，原生双栏、行评论、持久化草稿、导出给 LLM。

## 安装与使用

要求 **VS Code 1.96+**、Git，以及已有至少一个 commit 的仓库。

1. 在扩展面板的 `…` 菜单选择 **Install from VSIX… / 从 VSIX 安装**，选择 `diff-review-0.1.7.vsix`。
2. 打开 Git 仓库，执行 **Diff Review: Start Review / Select Baseline**。自动候选包含本地分支、这些分支正在 tracking 的远端分支，以及近期 commit；不枚举其他远端分支或标签。也可手动输入标签名、`HEAD~3`、SHA 等 Git ref。
3. 点击左侧 **Diff Review** 图标，点击文件打开原生 diff。
4. 在左右侧选中一行或多行代码，右键选择 **Add Review Comment**；也可点行号边栏的 **+**。两种方式都会打开原生多行输入框，写完点 **Save Comment**，不提交则点 **Discard**。
5. 在行评论顶部编辑、删除、解决意见。在文件树展开文件即可查看所有意见。
6. 执行 **Copy Review for LLM**，直接粘贴给 LLM；或用 **Export Review** 保存 Markdown / JSON。

基线选择后固定为 commit SHA；分支移动不会悄悄改变本轮 base。再次选择同一仓库、同一 SHA 会继续已有评审。用 **Resume Review** 切换其他已保存的基线。

若窗口较窄、你的 VS Code 设置使 diff 显示为单栏，在 diff 的 `… → Diff View` 菜单选 **Side by Side**。也可设置：

```json
{
  "diffEditor.renderSideBySide": true,
  "diffEditor.useInlineViewWhenSpaceIsLimited": false
}
```

## 语言功能

右侧直接使用工作区实际文件 URI，包含未保存编辑；已有语言扩展继续处理同一个文档。C++ 请保留原来的 clangd / C++ 扩展与项目配置，插件自身无需另启语言服务器。

左侧为只读虚拟文档，保留文件扩展名以使用语言语法高亮。左侧不提供基线版本的跨文件语义分析。

新增文件的 base 为空；删除文件的 current 为空。重命名由 Git 检测，base 使用旧路径。二进制文件不支持文本行评论。

## 评论与代码变化

- 评论保存路径、左右侧、行范围、原代码片段、附近上下文和内容哈希。
- 插入行或移动原片段时，可重新找到评论位置。
- 片段改变时标记 **outdated**；多个位置无法区分时标记 **ambiguous**。这些意见仍在文件树和导出中，但不会贴到推测的位置。
- 修复定位：在同一文件、同一侧选中目标代码，然后右键文件树中的意见，执行 **Attach Comment to Current Selection**。
- 代码还原后，原锚点可重新有效。
- 当前文件在评审过程中被重命名时，原路径上的意见可能变为过期；首版不自动迁移到新文件名。

意见保存在 VS Code 的**工作区扩展状态**中，不插入代码、不向仓库自动写配置。重启后可恢复；这些状态不是用于跨机器同步的仓库文件。Markdown / JSON 导出是独立文件，首版尚未提供 JSON 导入。

评论区支持多行创建与编辑；选区评论会锚定选中的完整代码行。过期意见的快捷编辑仍使用单行输入框。

## 导出

Markdown 包含 base SHA、当前 HEAD、左右侧、行号、定位状态、原始代码片段和评审意见。代码已变化时提醒 LLM 核对原片段。默认只导出未解决意见；JSON 保留全部意见和结构化锚点。

插件没有内置模型调用、账户登录或网络发送。复制/导出后由你选择交给哪个 LLM。

## 配置

| 设置 | 默认 | 用途 |
|---|---|---|
| `diffReview.contextLines` | 3 | 锚点和导出上下文行数 |
| `diffReview.includeResolvedInExport` | false | Markdown / 复制时包含已解决意见 |
| `diffReview.gitPath` | git | Git 可执行文件路径 |

刷新由编辑、保存、窗口重新获得焦点触发；仓库外部变化可点 **Refresh Changes** 手动更新。多根工作区可选择仓库；Remote SSH / Dev Container 场景按工作区扩展运行，但需要进一步实机验证。VS Code Web 与虚拟文件系统工作区不支持。

## 开发

```sh
npm ci
npm test
npm run check
npm run package
```

也可在 VS Code 打开源码目录，按 F5 启动 Extension Development Host。

Linux 扩展宿主测试：

```sh
xvfb-run -a npm run test:integration
```

安装系统依赖及测试下载由你的本地环境处理。测试使用 VS Code 1.96.4。可用 `VSCODE_EXECUTABLE_PATH` 指定已有 VS Code 二进制。

代码无运行时 npm 依赖；仅依赖 VS Code API、Node.js 和系统 Git。源码为 TypeScript，VSIX 包含已编译 JavaScript。

## 实现

| 文件 | 作用 |
|---|---|
| `src/extension.ts` | 命令、原生 diff、评论区、文件树、工作区状态 |
| `src/git.ts` | Git 基线解析、内容读取、变更列表 |
| `src/model.ts` | 数据模型、评论锚点匹配 |
| `src/export.ts` | Markdown / JSON 评审输出 |

MIT License。
