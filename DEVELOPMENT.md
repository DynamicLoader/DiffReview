# 开发与发布

## 本地开发

```sh
npm ci
npm test
npm run check
npm run package
```

安装包输出到 `deliverables/`。验证范围见 [TESTING.md](TESTING.md)。

## 自动发布到 VS Code Marketplace

`.github/workflows/publish.yml` 在推送 `v*` 标签时执行：校验版本 → 安装依赖 → 类型检查和测试 → 打包 → 保存 VSIX artifact → 发布到 Marketplace。仅接受与 `package.json` 完全匹配的稳定版本标签，例如 `v0.1.19`；`package-lock.json` 中的版本也必须一致。测试或打包失败会停止发布。

首次配置时，确认 Marketplace 中已有 publisher **DynamicLoader**，且使用的发布身份拥有该 publisher 的发布权限。可选择以下一种认证方式：

- **Microsoft Entra ID / OIDC（推荐）**：在仓库 **Settings → Environments** 创建 `marketplace` 环境，部署标签限制为 `v*`。为应用或托管身份配置 GitHub 联合凭据，issuer 为 `https://token.actions.githubusercontent.com`，audience 为 `api://AzureADTokenExchange`，subject 为 `repo:DynamicLoader/DiffReiew:environment:marketplace`（fork 或迁移仓库时替换仓库名）。将该身份添加到 Marketplace publisher 并授予 Contributor；在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 配置 `AZURE_CLIENT_ID` 和 `AZURE_TENANT_ID`。工作流通过 `azure/login` 登录，再用 `vsce publish --azure-credential` 发布。配置细节见 [Azure Login 的 OIDC 文档](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended)和 [VS Code 官方发布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)。
- **PAT**：在 Azure DevOps 创建具有 **Marketplace → Manage** 权限、覆盖 **All accessible organizations** 的 Personal Access Token；在上述仓库设置的 **Secrets** 中添加 `VSCE_PAT`，并保持 `AZURE_CLIENT_ID` 未设置。该 token 所属账户需要有 publisher 发布权限。微软已宣布全局 PAT 于 **2026-12-01** 停用，新配置建议使用 Entra ID，见 [官方说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token)。

发版示例（将版本号替换为本次版本）：

```sh
npm version 0.1.19 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Release 0.1.19"
git tag v0.1.19
git push origin HEAD
git push origin v0.1.19
```

发版前先提交本次功能修改和工作流。包名自动使用当前版本，输出为 `deliverables/local-diff-review-<version>.vsix`。也可在 Actions 中手动运行工作流，运行目标必须选择对应版本标签；同一 Marketplace 版本不可重复发布。

