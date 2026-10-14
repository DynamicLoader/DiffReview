const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-review-vscode-'));
  const git = args => execFileSync('git', args, { cwd: folder, stdio: 'pipe' });
  git(['init', '-q']); git(['config', 'user.name', 'Diff Review Test']); git(['config', 'user.email', 'test@example.invalid']);
  await fs.writeFile(path.join(folder, 'helper.ts'), 'export function greet(name: string): string { return "Hello " + name; }\n');
  await fs.writeFile(path.join(folder, 'main.ts'), 'import { greet } from "./helper";\nconst answer = greet("world");\nconsole.log(answer);\n');
  await fs.writeFile(path.join(folder, 'gone.ts'), '// removed file\n');
  await fs.writeFile(path.join(folder, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' }, include: ['*.ts'] }));
  git(['add', '--all']); git(['commit', '-qm', 'baseline']);
  await fs.writeFile(path.join(folder, 'main.ts'), 'import { greet } from "./helper";\nconst answer = greet("workspace");\nconsole.log(answer);\n');
  await fs.unlink(path.join(folder, 'gone.ts'));
  await fs.writeFile(path.join(folder, 'new.ts'), 'export const added = true;\n');
  const root = path.resolve(__dirname, '..');
  const result = path.join(root, 'integration-results.json');
  process.env.TAR_OPTIONS = '--no-same-owner';
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode('1.96.4');
  await runTests({
    vscodeExecutablePath, extensionDevelopmentPath: root, extensionTestsPath: path.join(root, 'test/integration.cjs'),
    extensionTestsEnv: { DIFF_REVIEW_TEST_RESULT: result },
    launchArgs: [folder, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--user-data-dir=' + path.join(folder, '.vscode-test-user'),
      '--extensions-dir=' + path.join(folder, '.vscode-test-extensions')]
  });
  await fs.rm(folder, { recursive: true, force: true });
}
main().catch(e => { console.error(e); process.exit(1); });
