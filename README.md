# Local Diff Review

在 VS Code 里评审本地 Git 修改：选择基线、逐文件检查、写行评论，再把意见导出给 LLM。

## 功能

- **任意 Git 基线**：对比分支、commit、标签或 `HEAD~N` 与当前工作区，包含未保存的编辑。
- **原生 diff**：临时预览标签；右侧直接编辑真实文件，继续使用已有语言扩展。
- **行评论**：支持左右两侧、单行或多行选区；可编辑、解决、重开和删除。
- **逐文件评审**：左侧勾选已评审文件，展开文件查看评论；勾选不触发 Git 扫描。
- **文件列表**：主要显示文件名，悬浮查看绝对路径；同名文件在名称后附带完整仓库内路径。
- **本地持久化**：按基线保存评审进度；代码变化后重新定位评论，无法确认时标记过期。
- **导出给 LLM**：一键复制，或导出 Markdown / JSON，附带路径、代码片段与基线信息。

无需账户，不调用模型，也不上传代码或评论。

## 快速开始

要求 **VS Code 1.96+**、Git，以及至少有一个 commit 的仓库。

1. 从扩展面板的 **Install from VSIX…** 安装本地构建的安装包。
2. 执行 **Local Diff Review: Start Review / Select Baseline**，选择基线。
3. 在侧栏点击文件查看 diff，选中代码后右键 **Add Review Comment**，或点击行号旁的 **+**。
4. 勾选完成评审的文件，展开文件处理评论；通过 **Copy Review for LLM** 或 **Export Review** 导出意见。

基线固定为 commit SHA，不随分支移动；用 **Resume Review** 恢复已有评审。自动候选仅列出本地分支、它们 tracking 的远端分支及近期 commit；其他 ref 可手动输入。

## 说明

- 评审存储在 VS Code 工作区状态中，不写入代码；目前不支持导入导出的 JSON。
- 外部修改未显示时，点击 **Refresh Changes**；过期评论可用 **Attach Comment to Current Selection** 重新定位。
- 右侧遵循原有保存与格式化设置；左侧为只读基线。二进制文件不支持行评论。
- 配置项：`localdiffreview.contextLines`、`localdiffreview.includeResolvedInExport`、`localdiffreview.gitPath`。

BSD-3-Clause，见 `LICENSE`。
