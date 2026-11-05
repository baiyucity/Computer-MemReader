# Memreader

[中文](#中文) · [English](#english) · [AI 辅助清理 / AI-assisted cleanup](#ai-assisted-cleanup)

## 中文

Memreader 是一个在 Windows 本机运行的磁盘空间分析工具，用来查看 C 盘、D 盘或指定文件夹的存储占用，比较两次扫描之间的空间变化。扫描只读文件系统元数据，不读取文件内容，也不移动或删除被扫描的文件。

- 扫描整盘或文件夹，查看进度并随时停止。用矩形树图、环形图和条形图浏览占用，逐层查找大文件和目录。
- 按磁盘恢复上次保存的目录，或打开某次扫描的历史快照。子目录扫描不会覆盖整盘基准；停止的扫描不会替换已保存结果。
- 对同一路径做两次扫描，在「空间变化」里查看增长与减少，展开目录寻找变化来源。
- 查看 Windows 安装记录中的应用占用估算，也可单独测量有可靠安装路径的应用目录。

### 从源码运行

需要 Windows、Node.js 24 和 pnpm 11。在项目目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

首次使用可以先扫描一个小文件夹。只想试用界面时，运行 `pnpm dev:web`；浏览器预览仅使用示例数据，不会扫描电脑。

| 命令 | 用途 |
| --- | --- |
| `pnpm test` | 运行扫描、记录、对比和图表等自动化测试 |
| `pnpm build` | 检查类型并生成生产构建 |
| `pnpm test:native` | 先运行 `pnpm build`，再在临时目录中验证桌面功能 |
| `pnpm pack` | 生成便携目录 `release/win-unpacked/` |
| `pnpm dist` | 在 `release/` 生成 Windows NSIS 安装包 |

打包需要 Windows 的 .NET Framework 4 编译器。使用便携版时，运行 `release/win-unpacked/Memreader.exe`；移动到别处请复制整个目录，以保留 Electron 运行所需的文件。

### 怎样读懂空间变化

先扫描一个目录或磁盘，隔一段时间再扫同一路径，然后打开「空间变化」并选择两条记录。默认与上一次同路径的扫描比较；也可以选择更早的记录。趋势只反映手动扫描的时间点。变化按层展示，汇总时不要把父目录和子目录的变化加在一起。

目录大小按可读取文件的逻辑字节数统计，可能与 Windows 报告的实际已用空间不同。受保护目录、符号链接和其他重解析点会跳过；未确认的项目不能判定为新增或删除。文件明细的保留数量有限，未保留的文件仍计入目录大小。移动或重命名可能表现为一增一减；扫描结果无法确认是哪个程序造成了变化，也不能保证能腾出同等的磁盘空间。

### 本地数据与备份

扫描快照保存在当前 Windows 用户的应用数据目录下，通常为 `%APPDATA%\Memreader\snapshots-v1\`。可在「扫描记录 → 查看本地记录」打开实际位置。记录不会因为重启或再次扫描而自动清除。需要备份时，先退出应用，再将整个 `snapshots-v1` 文件夹复制到代码仓库之外的私有位置。

快照和导出的 JSON 可能包含完整路径、文件名、扫描时间、大小、磁盘卷标和卷标识符；应用占用报告还可能包含安装信息。它们不包含被扫描的文件内容，仍可能暴露用户名或项目名称。请把快照、报告和个人设置留在仓库之外，避免提交到 Git 或附在公开 Issue 中。

## English

Memreader is a local Windows disk space explorer. It shows what takes up storage on a drive or in a folder and compares how that usage changes between scans. It reads filesystem metadata without opening file contents, moving files, or deleting them.

- Scan a drive or folder with progress and cancellation. Drill down with treemap, donut, or bar charts to find large files and directories.
- Reopen saved directories per drive or inspect a historical snapshot. A folder scan leaves the full-drive baseline intact, and canceling a scan preserves saved results.
- Scan the same path twice and open **Space Changes** to review growth and reductions one directory at a time.
- See app size estimates from Windows installation records and measure individual install folders when a reliable path is available.

### Run from source

You need Windows, Node.js 24, and pnpm 11. From the project directory:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Start with a small folder to get familiar with the charts. To try the interface, run `pnpm dev:web`. The browser preview uses sample data and does not scan your computer.

| Command | Purpose |
| --- | --- |
| `pnpm test` | Run automated tests for scans, snapshots, comparisons, charts, and related features |
| `pnpm build` | Type-check and produce a production build |
| `pnpm test:native` | After `pnpm build`, verify the desktop features using a temporary directory |
| `pnpm pack` | Build the portable `release/win-unpacked/` directory |
| `pnpm dist` | Build a Windows NSIS installer in `release/` |

Packaging requires the Windows .NET Framework 4 compiler. To launch the portable build, run `release/win-unpacked/Memreader.exe`. If you move it, copy the whole directory so the Electron runtime files stay with the executable.

### Interpret space changes

Scan a folder or drive, scan the same path again later, and open **Space Changes**. The comparison defaults to the previous scan of that path; you can choose an older one instead. Trends show manual scan times. Changes are grouped by directory level, so don't add parent and child totals together.

Directory sizes reflect the logical bytes of readable files and may differ from the used space Windows reports. The scanner skips protected directories, symbolic links, and other reparse points. An unconfirmed entry doesn't establish that a file was added or deleted. The scanner retains a limited number of individual file entries; omitted files still count toward directory totals. Moves and renames can show up as a decrease in one place and an increase in another. The scans cannot establish which app caused a change or guarantee how much disk space a deletion will free.

### Local data and backups

Scan snapshots live under the current Windows user's app data directory, usually `%APPDATA%\Memreader\snapshots-v1\`. Open **Scan History → View local records** (`扫描记录 → 查看本地记录`) to find the actual location. Restarting or scanning again does not automatically clear your history. To back it up, close the app and copy the entire `snapshots-v1` folder to a private location outside the code repository.

Snapshots and exported JSON may contain full paths, filenames, scan times, sizes, volume labels, and volume IDs. App usage reports may also include installation information. These records do not contain the contents of scanned files, but can still reveal usernames or project names. Keep snapshots, reports, and personal settings out of Git and public issues.

## 许可证 / License

Memreader 以 [MIT 许可证](LICENSE)发布。 / Memreader is released under the [MIT License](LICENSE).

<a id="ai-assisted-cleanup"></a>

## AI 辅助清理 / AI-assisted cleanup

**中文：** 推荐把 Memreader 和 AI 工具一起用。对同一路径扫描两次后，从「查看本地记录」找到前后两份快照 JSON（不是 `index-v1.json`）。让本地运行的 AI 直接以只读方式读取这两份快照，分析空间变化。只想分析当前状态时，也可以提供界面导出的 JSON 报告。使用云端工具时，先复制并脱敏，只给它需要的目录、大小和变化；用一致的代号替换用户名、文件名和敏感路径，让同一路径在两次记录里仍能对上。先备份，再人工确认每个候选项。卸载软件优先用 Windows 的卸载功能，清理缓存优先用应用自带的工具。

> 请只读分析这两份同一路径的扫描快照，按增长量列出主要变化，并给出值得人工检查的清理候选。对每项说明证据、可能释放的空间、风险和核实步骤；不要把目录总量当成可释放容量，不要把缺失明细当成删除。保留系统文件、应用数据和个人文件，除非我另行确认。不要执行命令或删除文件。

**English:** Pair Memreader with an AI tool to review what you might clean up. After scanning the same path twice, find the before and after JSON snapshots in **View local records**; use the two snapshot files rather than `index-v1.json`. Give an AI tool running locally read-only access to those files so it can compare the scans directly. A JSON report exported from the interface can also help review current usage. For a cloud tool, first make a redacted copy and share only the directory details, sizes, and changes needed for the task. Use consistent aliases for usernames, filenames, and sensitive paths so the same location still matches across scans. Back up anything you may need and review every suggestion yourself. Use Windows to uninstall apps and the app's own settings to clear caches where available.

> Read these two snapshots of the same path and rank the largest increases. Suggest cleanup candidates for manual review. For each one, explain the evidence, potential savings, risk, and how I can verify it. Don't treat total directory size as space I can reclaim or missing entries as deletions. Leave system files, app data, and personal files alone unless I explicitly confirm otherwise. Do not run commands or delete anything.
