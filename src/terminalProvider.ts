import * as vscode from 'vscode';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';
import { FileExplorerManager } from './fileExplorerManager';

export class TerminalProvider implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<void>();
    private sshClient: Client | null = null;
    private sshStream: any = null;
    private cmd = '';
    private hostname: string; // 新增字段

    private isMultiLine = false;
    private multiLineBuffer = '';
    private isEditorMode: boolean = false; // 是否处于编辑器模式
    private editorBuffer: string = ''; // 用于检测编辑器命令

    private cursorPosition = 0;

    // 简化后的行列跟踪系统 - 基于显示位置
    private currentLine: number = 0;          // 当前行号（0-based）
    private currentColumn: number = 0;        // 当前列号（0-based）
    private lineLengths: number[] = [0];      // 每行的显示长度
    private lineStartIndexes: number[] = [0]; // 每行在缓冲区中的起始索引
    private lineDisplayWidths: number[][] = [[]]; // 每行的显示宽度数组
    private isInsertMode = false;
    private systemType = ''; // 系统类型
    private terminalHeight: number = 24; //终端高度
    private terminalWidth: number = 80;  //终端宽度
    private currentWorkingDirectory: string = '~';
    private lastWorkingDirectory: string = '~';
    private fileExplorerManager: FileExplorerManager;

    // 实现 Pseudoterminal 接口
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    constructor(
        private connectionString: string,
        private privateKeyPath?: string,
        hostname?: string,
        systemType?: string, // 新增参数
        fileExplorerManager?: FileExplorerManager
    ) {
        this.hostname = hostname || this.getHost(); // 如果未提供，则从 connectionString 中提取
        this.systemType = systemType || ''; // 如果未提供，则默认为空字符串
        this.initWidthTracking(); // 添加这行
        // 如果没有传入fileExplorerManager，则使用getInstance()作为备选
        this.fileExplorerManager = fileExplorerManager || FileExplorerManager.getInstance();
    }

    open(): void {
        const [username, host] = this.connectionString.split('@');
        this.writeEmitter.fire(`\r\nConnecting to ${host}...\r\n`);
        // 连接 SSH
        this.connectSsh();
    }

    close(): void {
        this.sshStream?.end();  // 关闭数据流
        this.sshClient?.end();  // 终止 SSH 连接
        this.sshClient?.destroy(); // 强制销毁连接
        this.closeEmitter.fire(); // 确保触发关闭事件
    }

    dispose(): void {
        this.sshClient = null;
        this.sshStream = null;
    }

    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.terminalWidth = dimensions.columns;
        this.terminalHeight = dimensions.rows;

        // 通知远程终端尺寸变化
        if (this.sshStream) {
            this.sshStream.setWindow(
                this.terminalHeight,
                this.terminalWidth,
                0, 0
            );
        }
    }

    private processCommand(fullCommand: string): void {
        const lines = fullCommand.split(' ');
        const baseCommand = lines[0].trim();
        const args = lines.slice(1).filter(line => line.trim() !== '');

        // 解析 sudo 包裹的真实命令，仅用于编辑器判定，不影响实际发送
        let primaryCommand = baseCommand;
        if (baseCommand === 'sudo') {
            let i = 0;
            while (i < args.length) {
                const t = args[i];
                if (t === '--') { i++; break; }
                if (t === '-u' || t === '--user') { i += 2; continue; }
                if (t.startsWith('-')) { i++; continue; }
                break;
            }
            if (i < args.length) {
                primaryCommand = args[i];
            } else {
                primaryCommand = '';
            }
        }

        // 检测是否为文件操作命令
        const isFileOperationCommand = this.isFileOperationCommand(primaryCommand);

        // 检测 cd 命令并更新缓存目录
        if (baseCommand.startsWith('cd')) {
            this.handleCdCommand(args[0]);
            return;
        }

        if (primaryCommand.startsWith('rz')) {
            this.handleFileUpload(args);
        } else if (primaryCommand.startsWith('sz')) {
            this.handleFileDownload(args);
        } else if (baseCommand.startsWith('Ctrl-C')) {
            // 这里应该发送真正的终止信号
            if (this.sshStream) {
                this.sshStream.write('\x03'); // 发送Ctrl-C字符
            }
        } else if (this.isEditorCommand(primaryCommand)) {
            // vim/vi 等编辑器命令：开启实时模式并直接发送命令
            this.isEditorMode = true;
            if (this.sshStream) {
                this.sshStream.write(fullCommand + '\n');
            }
        } else {
            // 对于其他命令，通过SSH连接发送
            if (this.sshStream) {
                this.sshStream.write(fullCommand + '\n');

                // 如果是文件操作命令，在命令执行后触发文件树刷新
                if (isFileOperationCommand) {
                    // 解析命令参数中的路径
                    const paths = this.extractPathsFromCommand(primaryCommand, args);

                    // 增加延迟时间，确保命令有足够时间执行完成
                    const delayTime = ['mkdir', 'touch', 'cp', 'mv'].includes(primaryCommand) ? 1000 : 500;
                    setTimeout(() => {
                        // 刷新相关路径和当前工作目录
                        this.refreshFileExplorer(paths);
                    }, delayTime);
                }
            } else {
                this.writeEmitter.fire('\r\nSSH connection is not established.\r\n');
            }
        }
    }

    // 添加处理 cd 命令的方法
    private async handleCdCommand(path: string): Promise<void> {
        try {
            let targetPath = path;

            // 处理 cd ~
            if (path === '~') {
                targetPath = '$HOME';
            }
            // 处理 cd -
            else if (path === '-') {
                if (!this.lastWorkingDirectory) {
                    this.writeEmitter.fire('\r\nNo previous directory to switch to.\r\n');
                    return;
                } else if (this.lastWorkingDirectory === '~') {
                    targetPath = '$HOME';
                } else {
                    targetPath = this.lastWorkingDirectory;
                }
            }
            // 处理相对路径（不以 / 开头）
            else if (!path.startsWith('/')) {
                // 如果当前目录是 ~，直接拼接路径（远程 Shell 会自动解析 ~）
                if (this.currentWorkingDirectory === '~') {
                    targetPath = `$HOME/${path}`;
                } else {
                    // 否则拼接当前目录和相对路径
                    targetPath = `${this.currentWorkingDirectory}/${path}`;
                }
                // 规范化路径（移除多余的 ./ 或 ../）
                targetPath = targetPath.replace(/\/\.\//g, '/').replace(/\/[^\/]+\/\.\.\//g, '/');
            }

            // 通过 SSH 执行 cd 命令并获取新的当前目录
            const newDir = await this.getActualDirectoryAfterCd(targetPath);

            // 更新上一次的目录
            this.lastWorkingDirectory = this.currentWorkingDirectory;
            this.currentWorkingDirectory = newDir;

            // 发送 cd 命令到远程 shell
            if (this.sshStream) {
                this.sshStream.write(`cd ${targetPath}\n`);
            }
        } catch (error: any) {
            console.error('Failed to change directory:', error);
            this.writeEmitter.fire(`\r\nFailed to change directory: ${error.message}\r\n`);
        }
    }

    private commandHistory: string[] = [];
    private historyIndex: number = -1;

    private getPrevCommandFromHistory(): string | undefined {
        if (this.commandHistory.length === 0) return undefined;
        if (this.historyIndex === -1) {
            this.historyIndex = this.commandHistory.length - 1;
        } else {
            this.historyIndex = Math.max(this.historyIndex - 1, 0);
        }
        return this.commandHistory[this.historyIndex];
    }

    private getNextCommandFromHistory(): string | undefined {
        if (this.commandHistory.length === 0 || this.historyIndex < 0) return undefined;
        this.historyIndex = Math.min(this.historyIndex + 1, this.commandHistory.length);
        return this.historyIndex >= this.commandHistory.length ? '' : this.commandHistory[this.historyIndex];
    }

    private addToHistory(command: string): void {
        if (command.trim() && command !== this.commandHistory[this.commandHistory.length - 1]) {
            this.commandHistory.push(command);
            this.historyIndex = -1;
        }
    }

    private renderRemainingLine(): void {
        // 清除从光标到行尾的内容
        this.writeEmitter.fire('\x1b[K');
        if (this.isMultiLine) {
            // 输出剩余字符
            if (this.currentColumn < this.lineLengths[this.currentLine]) {
                this.writeEmitter.fire(this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn, this.lineStartIndexes[this.currentLine + 1]));
                // // 将光标移回原始位置
                // this.writeEmitter.fire(`\x1b[${this.lineLengths[this.currentLine] - this.currentColumn}D`);
                // 将光标移回原始位置，先计算剩余字符的显示宽度
                const remainingContentWidth = this.getDisplayWidthFrom(this.currentLine, this.currentColumn);
                this.writeEmitter.fire(`\x1b[${remainingContentWidth}D`);
            }
        } else {
            // 输出剩余字符
            if (this.cursorPosition < this.cmd.length) {
                // 输出剩余字符
                this.writeEmitter.fire(this.cmd.slice(this.cursorPosition));
                // 将光标移回原始位置，先计算剩余字符的显示宽度
                const remainingContentWidth = this.getDisplayWidthFrom(0, this.cursorPosition);
                this.writeEmitter.fire(`\x1b[${remainingContentWidth}D`);
            }
        }
    }

    private clearMultiLineDisplay(): void {
        if (this.isMultiLine) {
            // 计算需要清除的行数（除了第一行提示符）
            const linesToClear = this.lineLengths.length - 1;

            if (linesToClear > 0 && this.currentLine > 0) {
                // 移动到第一行并清除所有后续行
                this.writeEmitter.fire(`\x1b[${this.currentLine}A`); // 向上移动
                this.writeEmitter.fire('\x1b[0J'); // 清除从光标到屏幕末尾
            }

            // 回到行首
            this.writeEmitter.fire('\r');
            this.writeEmitter.fire(`\x1b[${this.calculatePromptVisibleLength()}C`);
        }
    }

    private getCurrentLineLength(): number {
        return this.getLineLength(this.currentLine);
    }

    // 新增方法：检测是否为编辑器命令
    private isEditorCommand(command: string): boolean {
        const editorCommands = [
            'vim', 'vi', 'nano', 'emacs', 'micro', 'neovim', 'nvim',
            'ed', 'ex', 'view', 'vimdiff', 'gvim', 'mvim'
        ];

        // 检查命令是否以编辑器命令开头
        for (const editorCmd of editorCommands) {
            if (command.startsWith(editorCmd + ' ') || command === editorCmd) {
                return true;
            }
        }

        return false;
    }

    // 检测编辑器退出命令的方法
    // 检测是否为文件操作命令
    private isFileOperationCommand(command: string): boolean {
        // 常见的文件操作命令列表
        const fileCommands = [
            'touch', 'mkdir', 'rm', 'rmdir', 'mv', 'cp', 'ln',
            'vim', 'vi', 'nano', 'emacs', 'micro', 'neovim', 'nvim',
            'echo', 'cat', 'dd', 'tee', 'truncate',
            'find', 'grep', 'sed', 'awk',
            'tar', 'zip', 'unzip', 'gzip', 'gunzip',
            'chmod', 'chown', 'chgrp',
            'rz'  // 添加rz命令到文件操作命令列表
        ];

        return fileCommands.includes(command);
    }

    // 从命令参数中提取路径
    private extractPathsFromCommand(command: string, args: string[]): string[] {
        const paths: string[] = [];

        // 跳过选项参数，提取实际的路径参数
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];

            // 跳过选项参数（以-开头的）
            if (arg.startsWith('-')) {
                // 检查是否是选项后的参数（如 -f file.txt）
                if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
                    // 对于某些命令，选项后可能是路径
                    if (['cp', 'mv', 'ln', 'chmod', 'chown', 'chgrp'].includes(command)) {
                        paths.push(args[i + 1]);
                        i++; // 跳过下一个参数
                    }
                }
                continue;
            }

            // 对于特定命令，跳过非路径参数
            if (['chmod', 'chown', 'chgrp'].includes(command) && i === 0) {
                // 对于chmod等命令，第一个参数通常是权限/所有者，不是路径
                continue;
            }

            // 对于echo命令，只有重定向到文件的情况才考虑
            if (command === 'echo' && !arg.includes('>')) {
                continue;
            }

            // 添加可能的路径
            paths.push(arg);
        }

        return paths;
    }

    private async refreshFileExplorer(pathsToRefresh?: string[]): Promise<void> {
        const treeDataProvider = this.fileExplorerManager.getTreeDataProvider();
        if (!treeDataProvider) return;

        // 如果没有指定路径，默认刷新当前工作目录
        const paths = pathsToRefresh && pathsToRefresh.length > 0 ? pathsToRefresh : [this.currentWorkingDirectory];
        const processedPaths = new Set<string>();

        for (const pathToRefresh of paths) {
            try {
                // 解析路径（支持~和相对路径）
                let actualPath = pathToRefresh;

                // 使用现有的getHomeDirectory方法获取家目录
                const homeDir = await this.getHomeDirectory();

                // 解析~为家目录
                if (actualPath.startsWith('~')) {
                    actualPath = actualPath.replace('~', homeDir);
                }

                // 确保路径是绝对路径
                if (!actualPath.startsWith('/')) {
                    // 如果是相对路径，基于当前工作目录解析
                    let baseDir = this.currentWorkingDirectory;
                    if (baseDir.startsWith('~')) {
                        baseDir = baseDir.replace('~', homeDir);
                    }
                    if (!baseDir.startsWith('/')) {
                        baseDir = homeDir;
                    }
                    actualPath = path.posix.join(baseDir, actualPath);
                }

                // 获取目录路径
                let dirPath = actualPath;

                // 获取父目录
                const parentPath = path.dirname(dirPath) === '.' ? '/' : path.dirname(dirPath);

                // 避免重复处理
                if (processedPaths.has(parentPath)) continue;
                processedPaths.add(parentPath);

                // 获取服务器节点
                const serverNode = treeDataProvider.getServer(this.connectionString);
                if (!serverNode) {
                    // 如果找不到服务器节点，降级为刷新整个树
                    treeDataProvider.refreshItem(undefined);
                    continue;
                }

                // 使用新的路径查找功能来查找并刷新父目录节点
                const parentNode = treeDataProvider.findNodeByPath(this.connectionString, parentPath);
                if (parentNode) {
                    // 如果找到父目录节点，刷新它
                    treeDataProvider.refreshItem(parentNode);
                } else if (parentPath === '/') {
                    // 如果是根目录且未找到节点，刷新服务器节点
                    treeDataProvider.refreshItem(serverNode);
                } else {
                    // 如果找不到父目录节点，尝试刷新服务器节点作为备选
                    console.log(`找不到路径 ${parentPath} 的节点，刷新服务器节点`);
                    treeDataProvider.refreshItem(serverNode);
                }

                // 如果当前路径不同于父路径，也刷新当前路径
                if (dirPath !== parentPath) {
                    const currentNode = treeDataProvider.findNodeByPath(this.connectionString, dirPath);
                    if (currentNode) {
                        treeDataProvider.refreshItem(currentNode);
                    }
                }
            } catch (error) {
                console.error('Error refreshing file explorer:', error);
                // 出错时降级为刷新整个树
                try {
                    treeDataProvider.refreshItem(undefined);
                } catch (refreshError) {
                    console.error('Failed to refresh entire tree:', refreshError);
                }
            }
        }
    }

    private detectEditorExitCommand(): boolean {
        const buffer = this.editorBuffer;

        // 使用正则表达式匹配各种换行符
        const exitPatterns = [
            /:q(\r\n|\r|\n)$/,     // :q 后跟任何换行符
            /:q!(\r\n|\r|\n)$/,    // :q! 后跟任何换行符
            /:wq(\r\n|\r|\n)$/,    // :wq 后跟任何换行符
            /:x(\r\n|\r|\n)$/,     // :x 后跟任何换行符
            /:wq!(\r\n|\r|\n)$/,   // :wq! 后跟任何换行符
            /:qa(\r\n|\r|\n)$/,    // :qa 后跟任何换行符
            /:qa!(\r\n|\r|\n)$/,   // :qa! 后跟任何换行符
            /ZZ$/,                 // ZZ 结尾
            /ZQ$/,                 // ZQ 结尾
            // 添加对micro编辑器退出的支持
            /\^Q/,                // Ctrl+Q (micro退出)
            /\^X/,                // Ctrl+X (micro退出)
            /^q$/,                 // micro也支持:q命令
            /\^C/                 // Ctrl+C 通常也可退出micro
        ];

        for (const pattern of exitPatterns) {
            if (pattern.test(buffer)) {
                return true;
            }
        }

        // 检测 Ctrl+C
        if (buffer.includes('\x03')) {
            return true;
        }

        return false;
    }

    // 初始化方法（在构造函数或reset时调用）
    private initWidthTracking(): void {
        this.lineDisplayWidths = [[]];
    }

    // 在指定位置插入字符并记录显示宽度
    private insertCharWithWidthTracking(line: number, column: number, char: string): number {
        const width = this.getCharDisplayWidth(char);

        // 确保行数组存在
        if (!this.lineDisplayWidths[line]) {
            this.lineDisplayWidths[line] = [];
        }

        // 在指定位置插入宽度记录
        this.lineDisplayWidths[line].splice(column, 0, width);

        return width;
    }

    // 删除指定位置的字符并返回其显示宽度
    private deleteCharWithWidthTracking(line: number, column: number): number {
        if (!this.lineDisplayWidths[line] || column >= this.lineDisplayWidths[line].length) {
            return 0;
        }

        const width = this.lineDisplayWidths[line][column];
        this.lineDisplayWidths[line].splice(column, 1);

        return width;
    }

    // 获取从指定位置开始的总显示宽度
    private getDisplayWidthFrom(line: number, column: number): number {
        if (!this.lineDisplayWidths[line]) return 0;

        let total = 0;
        for (let i = column; i < this.lineDisplayWidths[line].length; i++) {
            total += this.lineDisplayWidths[line][i];
        }
        return total;
    }

    // 获取到指定位置为止的总显示宽度
    private getDisplayWidthTo(line: number, column: number): number {
        if (!this.lineDisplayWidths[line]) return 0;

        let total = 0;
        for (let i = 0; i < column; i++) {
            total += this.lineDisplayWidths[line][i];
        }
        return total;
    }

    // 字符显示宽度检测方法
    private getCharDisplayWidth(char: string): number {
        // 中文字符的Unicode范围：基本汉字（0x4E00-0x9FFF）和扩展A（0x3400-0x4DBF）
        const code = char.charCodeAt(0);
        return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ? 2 : 1;
    }

    // 添加一个统一的重置方法
    private resetTerminalState(): void {
        this.isEditorMode = false;
        this.isMultiLine = false;
        this.multiLineBuffer = '';
        this.editorBuffer = '';
        this.cmd = '';
        this.currentLine = 0;
        this.currentColumn = 0;
        this.cursorPosition = 0;
        this.lineStartIndexes = [0];
        this.lineLengths = [0];
        this.initWidthTracking();
    }

    async handleInput(data: string): Promise<void> {
        console.log(`Received input: ${data}`);

        const code = data.charCodeAt(0);
        console.log(`Received input (code): ${code}`);

        const hexValue = Array.from(data).map(c => c.charCodeAt(0).toString(16)).join(', ');
        console.log(`Received input (hex): ${hexValue}`);
        // 如果处于编辑器模式，累积输入以检测退出命令
        if (this.isEditorMode) {
            this.editorBuffer += data;

            // 检测 vim/vi 退出命令
            if (this.detectEditorExitCommand()) {
                this.resetTerminalState();

                // 当从编辑器退出时，刷新文件资源管理器
                // 延迟刷新以确保文件操作已完成
                setTimeout(() => {
                    this.refreshFileExplorer();
                }, 500);
            }

            // 实时转发所有输入到 SSH
            if (this.sshStream) {
                this.sshStream.write(data);
            }
            return;
        }
        // 检测包围式粘贴模式
        if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
            // 提取实际的粘贴内容（去掉开始和结束标记）
            const pasteContent = data.slice(6, data.length - 6); // 移除 \x1b[200~ 和 \x1b[201~

            // 处理粘贴内容
            if (/\r\n|\r|\n/.test(pasteContent)) {
                const tmpdatas = pasteContent.split(/\r\n|\r|\n/);
                if (tmpdatas.length > 1) this.isMultiLine = true;
                await this.handleMultiLinePaste(tmpdatas);
            } else {
                this.insertTextAtCursor(pasteContent);
            }
            return;
        }

        // 检测续行符
        if (data.endsWith('\\') && data.length === 1) {
            this.isMultiLine = true;
            // 判断当前位置是不是第一次输入 \ 多行命令符
            if (this.lineLengths.length === 0) {
                // 如果是行尾
                this.multiLineBuffer += this.cmd + data.slice(0, -1);
                this.cmd = '';
                // 初始化行列跟踪系统
                this.currentLine++; // 第0行是原始命令，第1行是提示符行
                this.currentColumn = 0; // 逻辑列位置（从0开始，在"> "之后）
                this.cursorPosition = 0;
                this.lineStartIndexes[this.currentLine] = this.multiLineBuffer.length;
                this.lineLengths[this.currentLine] = 0;
                this.lineDisplayWidths[this.currentLine] = [];
                // 显示多行提示符
                this.writeEmitter.fire('\r\n> ');
                return;
            } else if (this.currentLine < this.lineLengths.length - 1) {
                if (this.currentColumn === this.getCurrentLineLength()) {
                    // 在当前行下面插入一个空行
                    this.insertEmptyLineAfter();
                } else {
                    // 将当前行当前列后面的字符添加到新行
                    this.splitLineAtCursor();
                }
                return;
            } else {
                if (this.currentColumn === this.getCurrentLineLength()) {
                    // 如果是最后一行的行尾，将后续的字符添加到当前行
                    this.multiLineBuffer += data.slice(0, -1);
                    this.cmd = '';
                    this.currentLine++;
                    this.currentColumn = 0;
                    this.cursorPosition = 0;
                    this.lineStartIndexes[this.currentLine] = this.multiLineBuffer.length;

                    this.lineLengths[this.currentLine] = 0;
                    this.lineDisplayWidths[this.currentLine] = [];
                    // 显示多行提示符
                    this.writeEmitter.fire('\r\n> ');
                    return;
                } else {
                    // 如果不是行尾，将后续的字符添加到新的行
                    this.splitLineAtCursor();
                    return;
                }
            }
        }

        // 修改多行模式处理逻辑
        if (this.isMultiLine) {
            // 首先检测特殊按键（方向键、退格键等），但排除INS键
            const isSpecialKey = (data.startsWith('\x1b') && !data.startsWith('\x1b[2~')) ||
                data.charCodeAt(0) === 127 ||
                data.charCodeAt(0) === 3 ||
                data.charCodeAt(0) === 8 ||
                data.charCodeAt(0) === 9 ||
                data.charCodeAt(0) === 12 ||
                data.charCodeAt(0) === 13;

            if (!isSpecialKey) {
                if (/\r\n|\r|\n/.test(data)) {
                    // 多行模式：插入新行
                    const tmpdatas = data.split(/\r\n|\r|\n/);
                    if (tmpdatas.length > 1) this.isMultiLine = true;
                    await this.handleMultiLinePaste(tmpdatas);
                    return;
                } else if (this.currentLine < this.lineLengths.length - 1) {
                    // 如果在行中，则插入
                    this.writeEmitter.fire(data);
                    // 计算每个字符的显示宽度
                    for (let i = 0; i < data.length; i++) {
                        const char = data.charAt(i);
                        this.insertCharWithWidthTracking(this.currentLine, this.currentColumn + i, char);
                    }
                    this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn) + data + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                    this.lineLengths[this.currentLine] += data.length;
                    this.currentColumn += data.length;
                    this.cursorPosition += data.length;
                    // 后续的每一行的起始位置都要加1
                    for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                        this.lineStartIndexes[i]++;
                    }
                    this.renderRemainingLine();
                    return;
                } else {
                    if (this.currentColumn === this.getCurrentLineLength()) {
                        this.writeEmitter.fire(data);
                        // 计算每个字符的显示宽度
                        for (let i = 0; i < data.length; i++) {
                            const char = data.charAt(i);
                            this.insertCharWithWidthTracking(this.currentLine, this.currentColumn + i, char);
                        }
                        this.multiLineBuffer += data;
                        this.currentColumn += data.length;
                        this.cursorPosition += data.length;
                        this.lineLengths[this.currentLine] = this.multiLineBuffer.length - this.lineStartIndexes[this.currentLine];
                        return;
                    } else {
                        // 将data 添加到当前行的当前列，且不影响当前列后面的内容
                        this.writeEmitter.fire(data);
                        // 计算每个字符的显示宽度
                        for (let i = 0; i < data.length; i++) {
                            const char = data.charAt(i);
                            this.insertCharWithWidthTracking(this.currentLine, this.currentColumn + i, char);
                        }
                        this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn) + data + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                        this.lineLengths[this.currentLine] += data.length;
                        this.currentColumn += data.length;
                        this.cursorPosition += data.length;
                        this.renderRemainingLine();
                        return;
                    }
                }
            }

            // 如果是特殊按键（包括INS键），不return，让流程继续到后面的switch语句处理
        }

        switch (code) {
            case 3: // Ctrl-C    
                // 1. 首先清除当前的多行显示
                if (this.isMultiLine) {
                    // 清除所有多行提示符和内容
                    this.clearMultiLineDisplay();
                }
                this.processCommand('Ctrl-C');
                this.resetTerminalState();
                break;
            case 13: // Enter 键
                if (this.isMultiLine) {
                    if (this.currentLine < this.lineLengths.length - 1) {
                        // 如果非最后一行，移动到最后一行
                        this.moveToPosition(this.lineLengths.length - 1, this.lineLengths[this.lineLengths.length - 1]);
                    }
                    this.writeEmitter.fire('\r\n');
                    this.processCommand(this.multiLineBuffer.trim());
                    this.addToHistory(this.multiLineBuffer.trim());
                } else {
                    this.writeEmitter.fire('\r\n');
                    this.processCommand(this.cmd);
                    this.addToHistory(this.cmd);
                }
                if (!this.isEditorMode)
                    this.resetTerminalState();
                break;
            case 127: // Backspace 键
                if (this.isMultiLine) {
                    if (this.multiLineBuffer.length > 0) {
                        // 判断是否在行中
                        if (this.currentColumn > 0 && this.currentColumn < this.getCurrentLineLength()) {
                            // 获取要删除字符的显示宽度
                            const charToDelete = this.multiLineBuffer[this.lineStartIndexes[this.currentLine] + this.currentColumn - 1];
                            const charWidth = this.getCharDisplayWidth(charToDelete);
                            // 如果在行中，删除字符
                            // this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn - 1) + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                            // 删除字符
                            this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn - 1) +
                                this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);

                            // 更新宽度跟踪
                            this.deleteCharWithWidthTracking(this.currentLine, this.currentColumn - 1);
                            this.currentColumn--;
                            this.lineLengths[this.currentLine]--;
                            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                                this.lineStartIndexes[i]--;
                            }
                            // this.writeEmitter.fire('\b \b');
                            // 使用实际显示宽度移动光标并清除
                            this.writeEmitter.fire(`\x1b[${charWidth}D`); // 向左移动
                            this.writeEmitter.fire(`\x1b[${charWidth}X`); // 清除字符
                            this.renderRemainingLine();
                        } else if (this.currentColumn === 0 && this.currentLine > 0 && this.lineLengths[this.currentLine] === 0) {
                            // 删除当前空行
                            this.clearCurrentLineAndReturn();
                        } else if (this.currentColumn === 0 && this.currentLine >= 0 && this.lineLengths[this.currentLine] !== 0) {
                            // 如果在行首，删除上一行行尾
                            // this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine - 1] + this.lineLengths[this.currentLine - 1]) + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine]);
                            // this.moveToPosition(this.currentLine - 1, this.lineLengths[this.currentLine - 1] - 1);
                            // this.currentColumn = this.lineLengths[this.currentLine];
                            // this.lineLengths[this.currentLine] = this.multiLineBuffer.length - this.lineStartIndexes[this.currentLine];
                            // this.lineStartIndexes[this.currentLine + 1] = this.multiLineBuffer.length;
                            // this.lineLengths[this.currentLine + 1] = 0;
                            // this.writeEmitter.fire('\b \b');
                            // this.renderRemainingLine();
                            // this.clearNextLineAndReturn();
                        } else {
                            // 将当前行当前列的前一个字符删除
                            const charToDelete = this.multiLineBuffer[this.lineStartIndexes[this.currentLine] + this.currentColumn - 1];
                            const charWidth = this.getCharDisplayWidth(charToDelete);
                            // 将当前行当前列的前一个字符 删除
                            this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn - 1) +
                                this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);

                            // 更新宽度跟踪
                            this.deleteCharWithWidthTracking(this.currentLine, this.currentColumn - 1);
                            this.currentColumn--;
                            this.lineLengths[this.currentLine]--;
                            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                                this.lineStartIndexes[i]--;
                            }
                            // this.writeEmitter.fire('\b \b');
                            // 使用实际显示宽度移动光标并清除
                            this.writeEmitter.fire(`\x1b[${charWidth}D`);
                            this.writeEmitter.fire(`\x1b[${charWidth}X`);
                            this.renderRemainingLine();
                        }

                    }
                } else {
                    if (this.cmd.length > 0 && this.cursorPosition > 0) {
                        // 获取要删除字符的显示宽度
                        const charToDelete = this.cmd[this.cursorPosition - 1];
                        const charWidth = this.getCharDisplayWidth(charToDelete);
                        this.cmd = this.cmd.slice(0, this.cursorPosition - 1) + this.cmd.slice(this.cursorPosition);
                        this.multiLineBuffer = this.cmd;

                        // 更新宽度跟踪
                        this.deleteCharWithWidthTracking(0, this.cursorPosition - 1);
                        this.cursorPosition--;
                        this.currentColumn--;
                        this.lineLengths[0]--;
                        // this.writeEmitter.fire('\b \b');

                        // 使用实际显示宽度移动光标并清除
                        this.writeEmitter.fire(`\x1b[${charWidth}D`);
                        this.writeEmitter.fire(`\x1b[${charWidth}X`);
                        this.renderRemainingLine(); // 重新渲染剩余内容
                    }
                }
                break;
            case 27: // 
                if (data === '\x1b') { // 退出编辑插入模式
                    this.resetTerminalState();
                } else if (data === '\x1b[A' || data === '\x1bOA') { // 上键
                    if (this.isMultiLine) {
                        // 多行模式：向上移动一行
                        this.handleCrossLineMovement('up');
                    } else {
                        // 单行模式：命令历史导航
                        const prevCmd = this.getPrevCommandFromHistory();
                        if (prevCmd !== undefined) {
                            // 如果如果第一次按下上键，先左移光标到行首
                            if (this.cmd.length > 0) {
                                this.writeEmitter.fire(`\x1b[${this.cmd.length}D`);
                            }
                            this.writeEmitter.fire('\x1b[K');
                            this.writeEmitter.fire(prevCmd);
                            this.cmd = prevCmd;
                            this.cursorPosition = this.cmd.length;
                        }
                        return;
                    }
                } else if (data === '\x1b[B' || data === '\x1bOB') { // 下键
                    if (this.isMultiLine) {
                        // 多行模式：向下移动一行
                        this.handleCrossLineMovement('down');
                    } else {
                        // 单行模式：命令历史导航
                        const nextCmd = this.getNextCommandFromHistory();
                        if (nextCmd !== undefined) {
                            // 如果如果第一次按下下键，先左移光标到行首
                            if (this.cmd.length > 0) {
                                this.writeEmitter.fire(`\x1b[${this.cmd.length}D`);
                            }
                            this.writeEmitter.fire('\x1b[K');
                            this.writeEmitter.fire(nextCmd);
                            this.cmd = nextCmd;
                            this.cursorPosition = this.cmd.length;
                        }
                        return;
                    }
                } else if (data === '\x1b[D' || data === '\x1bOD') { // 向左键
                    if (this.isMultiLine) {
                        this.handleCrossLineMovement('left');
                    } else {
                        if (this.cursorPosition > 0) {
                            // 获取前一个字符的显示宽度
                            const prevCharWidth = this.getCharDisplayWidth(this.cmd[this.cursorPosition - 1]);
                            this.cursorPosition--;
                            this.currentColumn--;
                            this.writeEmitter.fire(`\x1b[${prevCharWidth}D`);
                        }
                    }
                    return;
                } else if (data === '\x1b[C' || data === '\x1bOC') { // 向右键
                    if (this.isMultiLine) {
                        this.handleCrossLineMovement('right');
                    } else {
                        if (this.cursorPosition < this.cmd.length) {
                            // 获取当前字符的显示宽度
                            const currentCharWidth = this.getCharDisplayWidth(this.cmd[this.cursorPosition]);
                            this.cursorPosition++;
                            this.currentColumn++;
                            this.writeEmitter.fire(`\x1b[${currentCharWidth}C`);
                        }
                    }
                    return;
                } else if (data === '\x1bOF' || data === '\x1b[F' || data === '\x1b[4~') { // End 键
                    if (this.isMultiLine) {
                        // 使用moveToPosition方法移动到当前行的末尾
                        const currentLineLength = this.getCurrentLineLength();
                        this.moveToPosition(this.currentLine, currentLineLength);
                    } else {
                        // // 计算需要向右移动的光标位置
                        // const moveRight = this.cmd.length - this.cursorPosition;
                        // if (moveRight > 0) {
                        //     this.writeEmitter.fire(`\x1b[${moveRight}C`); // 向右移动光标
                        // }
                        // 计算需要向右移动的显示宽度
                        const displayWidthToMove = this.getDisplayWidthFrom(0, this.cursorPosition);
                        if (displayWidthToMove > 0) {
                            this.writeEmitter.fire(`\x1b[${displayWidthToMove}C`);
                        }
                        this.cursorPosition = this.cmd.length;
                        this.currentColumn = this.cmd.length;
                    }
                    return;
                } else if (data === '\x1bOH' || data === '\x1b[H' || data === '\x1b[1~') { // Home 键
                    if (this.isMultiLine) {
                        // 使用moveToPosition方法移动到当前行的开头（逻辑位置0）
                        this.moveToPosition(this.currentLine, 0);
                    } else {
                        // // 计算需要向左移动的光标位置
                        // const moveLeft = this.cursorPosition;
                        // if (moveLeft > 0) {
                        //     this.writeEmitter.fire(`\x1b[${moveLeft}D`); // 向左移动光标
                        // }
                        // 计算需要向左移动的显示宽度
                        const displayWidthToMove = this.getDisplayWidthTo(0, this.cursorPosition);
                        if (displayWidthToMove > 0) {
                            this.writeEmitter.fire(`\x1b[${displayWidthToMove}D`);
                        }
                        this.cursorPosition = 0;
                        this.currentColumn = 0;
                    }
                    return;
                } else if (data === '\x1b[2~') {  // INS 键
                    this.isInsertMode = !this.isInsertMode;
                    // 可以添加视觉反馈，比如改变光标形状或显示模式状态
                    this.writeEmitter.fire(this.isInsertMode ? '\x1b[4 q' : '\x1b[2 q'); // 改变光标形状
                    return;
                } else if (data === '\x1b[3~') { // Del 键
                    if (this.isMultiLine) {
                        // 多行模式：删除当前光标位置字符
                        if (this.currentColumn >= 0
                            && this.currentColumn < this.lineLengths[this.currentLine]
                            && this.lineLengths[this.currentLine] > 0
                        ) {
                            // 删除光标位置的字符的显示宽度
                            this.deleteCharWithWidthTracking(this.currentLine, this.currentColumn);
                            this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn)
                                + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn + 1);
                            this.writeEmitter.fire('\x1b[P');
                            this.lineLengths[this.currentLine]--;
                            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                                this.lineStartIndexes[i]--;
                            }
                            this.renderRemainingLine(); // 重新渲染剩余内容
                        } else if (this.currentColumn === 0
                            && this.lineLengths[this.currentLine] === 0
                            && this.currentLine + 1 <= this.lineLengths.length - 1
                        ) {
                            // 删除中间的空行
                            this.clearCurrentLineAndReturn(false);
                        } else if (this.currentColumn === this.lineLengths[this.currentLine]
                            && this.currentColumn > 0
                            && this.currentLine + 1 <= this.lineLengths.length - 1
                            && this.lineLengths[this.currentLine + 1] === 0) {
                            // 当倒数第二行的行尾删除，且最后一行是空行
                            this.moveToPosition(this.currentLine + 1, this.lineLengths[this.currentLine + 1]);
                            this.clearCurrentLineAndReturn();
                            // this.clearNextLineAndReturn();
                        } else if (this.currentColumn === 0
                            && this.currentLine === this.lineLengths.length - 1
                            && this.lineLengths[this.currentLine] === 0
                        ) {
                            this.clearCurrentLineAndReturn();
                        }
                    } else {
                        if (this.cmd.length > 0 && this.cursorPosition < this.cmd.length) {
                            // 删除光标位置的字符的显示宽度
                            this.deleteCharWithWidthTracking(0, this.cursorPosition);
                            this.cmd = this.cmd.slice(0, this.cursorPosition) + this.cmd.slice(this.cursorPosition + 1);
                            this.multiLineBuffer = this.cmd;
                            this.writeEmitter.fire('\x1b[P');
                            this.lineLengths[0]--;
                            this.renderRemainingLine(); // 重新渲染剩余内容
                        }
                    }
                    return;
                } else if (data === '\x1b[5~') { // Page Up 键
                    this.writeEmitter.fire('\x1b[5~');
                    return;
                } else if (data === '\x1b[6~') { // Page Down 键
                    this.writeEmitter.fire('\x1b[6~');
                    return;
                }
                break;
            case 9: // Tab 键
                if (this.isMultiLine) {
                    // 多行模式：自动补全
                    // 获取当前行，当前列之前的内容
                    const linePreviousContent = this.multiLineBuffer.slice(
                        this.lineStartIndexes[this.currentLine],
                        this.lineStartIndexes[this.currentLine] + this.currentColumn);

                    // 获取前面行的内容 + 当前行的内容
                    const tabContents = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn)
                    // 使用完整的多行上下文进行分析，但只补全当前行
                    const linePreviousSuggestions = await this.getTabSuggestions(linePreviousContent, tabContents);
                    if (linePreviousSuggestions.length === 1) {
                        // 如果只有一个建议，自动补全
                        const fixword = linePreviousSuggestions[0].slice(linePreviousContent.length) + ' ';
                        // 补全的内容要计算显示宽度
                        for (let i = 0; i < fixword.length; i++) {
                            const char = fixword.charAt(i);
                            this.insertCharWithWidthTracking(this.currentLine, this.currentColumn + i, char);
                        }
                        // 插入当前行，当前列之后的内容，并且不要影响后面的内容
                        this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn)
                            + fixword
                            + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);


                        // 更新当前行的长度
                        this.lineLengths[this.currentLine] += fixword.length;
                        // 更新光标位置
                        this.currentColumn += fixword.length;
                        this.cursorPosition += fixword.length;
                        // 更新光标位置
                        this.writeEmitter.fire(fixword);

                        // 更新下一行的起始索引
                        for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                            this.lineStartIndexes[i] += fixword.length;
                        }
                    } else if (linePreviousSuggestions.length > 1) {
                        // 如果有多个建议，显示建议列表
                        this.writeEmitter.fire('\r\n' + linePreviousSuggestions.join('    ') + '\r\n');
                        const tabprompt = this.getPrompt();
                        this.writeEmitter.fire(tabprompt);
                        this.lineLengths.forEach((length, index) => {
                            this.writeEmitter.fire(this.multiLineBuffer.slice(this.lineStartIndexes[index], this.lineStartIndexes[index] + length));
                            if (index < this.currentLine) {
                                this.writeEmitter.fire('\r\n');
                            }
                        });

                    }
                } else {
                    const suggestions = await this.getTabSuggestions(this.cmd);
                    if (suggestions.length === 1) {
                        const lastWord = this.cmd.split(/\s+/).pop() || '';
                        const fixword = suggestions[0].slice(lastWord.length);
                        // 补全的内容要计算显示宽度
                        for (let i = 0; i < fixword.length; i++) {
                            const char = fixword.charAt(i);
                            this.insertCharWithWidthTracking(0, this.cursorPosition + i, char);
                        }
                        this.cmd += fixword;
                        this.cursorPosition = this.cmd.length;
                        this.currentColumn = this.cmd.length;
                        this.lineLengths[0] += fixword.length;
                        this.writeEmitter.fire(fixword);
                    } else if (suggestions.length > 1) {
                        this.writeEmitter.fire('\r\n' + suggestions.join('    ') + '\r\n');
                        const tabprompt = this.getPrompt();
                        this.writeEmitter.fire(tabprompt);
                        this.writeEmitter.fire(this.cmd);
                    }
                }
                break;
            case 12: // Ctrl + L 清屏
                this.writeEmitter.fire('\x1b[2J\x1b[0;0H');
                this.resetTerminalState();
                const clearPrompt = this.getPrompt();  // 使用新的局部变量
                this.writeEmitter.fire(clearPrompt);
                return;
            default:
                if (this.cursorPosition < this.cmd.length) {

                    // 插入模式：在光标位置之前插入字符
                    this.cmd = this.cmd.slice(0, this.cursorPosition)
                        + data
                        + this.cmd.slice(this.cursorPosition);
                    this.multiLineBuffer = this.cmd;

                    // 记录每个字符的显示宽度
                    for (let i = 0; i < data.length; i++) {
                        const char = data.charAt(i);
                        this.insertCharWithWidthTracking(0, this.cursorPosition + i, char);
                    }

                    this.cursorPosition += data.length;
                    this.currentColumn += data.length;
                    this.lineLengths[this.currentLine] += data.length;
                    this.lineStartIndexes[this.currentLine] = 0;
                    this.writeEmitter.fire(data);
                    this.renderRemainingLine(); // 重新渲染剩余内容
                } else {
                    if (/\r\n|\r|\n/.test(data)) {
                        // 多行模式：插入新行
                        const tmpdatas = data.split(/\r\n|\r|\n/);
                        if (tmpdatas.length > 1) this.isMultiLine = true;
                        await this.handleMultiLinePaste(tmpdatas);
                        return;
                    }

                    this.cmd += data;
                    this.multiLineBuffer += data;

                    // 记录每个字符的显示宽度
                    for (let i = 0; i < data.length; i++) {
                        const char = data.charAt(i);
                        this.insertCharWithWidthTracking(0, this.cursorPosition + i, char);
                    }

                    this.cursorPosition += data.length;
                    this.currentColumn += data.length;
                    this.lineLengths[this.currentLine] += data.length;
                    this.lineStartIndexes[this.currentLine] = 0;
                    this.writeEmitter.fire(data);
                }
                break;
        }
    }

    private connectSsh() {
        const [username, hostPort] = this.connectionString.split('@');
        const [host, portStr] = hostPort.split(':');
        const port = portStr ? parseInt(portStr) : 22;

        this.sshClient = new Client();
        this.sshClient
            .on('ready', async () => {
                this.writeEmitter.fire(`\r\nConnection established.\r\n`);
                this.sshClient?.shell({
                    term: 'xterm-256color',
                    rows: this.terminalHeight || 24,    // 提供默认值
                    cols: this.terminalWidth || 80       // 提供默认值
                }, async (err, stream) => {
                    if (err) {
                        this.writeEmitter.fire(`Error: ${err.message}\r\n`);
                        return;
                    }
                    this.sshStream = stream;
                    stream.on('data', (data: Buffer) => {
                        const dataStr = data.toString();

                        // 进入/退出备用屏缓冲（编辑器/分页器常用）
                        if (dataStr.includes('\x1b[?1049h')) this.isEditorMode = true;
                        if (dataStr.includes('\x1b[?1049l')) this.isEditorMode = false;

                        this.writeEmitter.fire(dataStr);
                    }).on('close', () => {
                        // 会话关闭时复位，避免残留状态影响下一次会话
                        this.resetTerminalState();
                        this.writeEmitter.fire('\r\nConnection closed\r\n');
                        this.close();
                    });
                });
            })
            .on('error', (err: Error) => {
                this.writeEmitter.fire(`\r\nSSH Error: ${err.message}\r\n`);
            })
            .connect({
                host,
                port,
                username,
                privateKey: this.privateKeyPath ? fs.readFileSync(this.privateKeyPath) : undefined
            });
    }

    public async handleFileUpload(args: string[] = []) {
        try {
            let localFilePath: string;
            let remotePath: string;

            // 如果 args 包含文件路径，直接使用；否则打开文件选择对话框
            if (args.length > 0) {
                localFilePath = args[0];
                remotePath = args[1] || `./${path.basename(localFilePath)}`;
            } else {
                const fileUri = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false
                });
                if (!fileUri || fileUri.length === 0) return;
                localFilePath = fileUri[0].fsPath;
                remotePath = `./${path.basename(localFilePath)}`;
            }

            // 处理相对路径
            if (remotePath.startsWith('./') || remotePath.startsWith('../')) {
                let baseDir = this.currentWorkingDirectory;
                // 如果当前目录是 ~，获取实际的家目录路径
                if (baseDir === '~') {
                    baseDir = await this.getHomeDirectory();
                }
                // 拼接路径
                remotePath = path.posix.resolve(baseDir, remotePath);
            }

            // 获取文件大小用于显示进度条
            const fileStats = fs.statSync(localFilePath);
            const fileSize = fileStats.size;
            let transferredBytes = 0;
            let lastPercentage = -1;

            this.writeEmitter.fire(`Starting upload to ${remotePath} (${this.formatFileSize(fileSize)})\r\n`);

            const conn = new Client();
            await new Promise((resolve, reject) => {
                conn.on('ready', () => {
                    conn.sftp((err, sftp) => {
                        if (err) {
                            this.writeEmitter.fire(`SFTP Error: ${err.message}\r\n`);
                            reject(err);
                            return;
                        }

                        const readStream = fs.createReadStream(localFilePath);
                        const writeStream = sftp.createWriteStream(remotePath);

                        // 监听数据传输进度
                        readStream.on('data', (chunk: Buffer) => {
                            transferredBytes += chunk.length;
                            const percentage = Math.floor((transferredBytes / fileSize) * 100);
                            
                            // 每1%更新一次进度条，避免过于频繁的更新
                            if (percentage !== lastPercentage) {
                                lastPercentage = percentage;
                                this.writeEmitter.fire(`\r${this.createProgressBar(percentage)} ${percentage}% (${this.formatFileSize(transferredBytes)}/${this.formatFileSize(fileSize)})`);
                            }
                        });

                        // 添加完成标志，确保只执行一次完成逻辑
                        let isCompleted = false;

                        readStream.pipe(writeStream)
                            .on('finish', async () => {
                                if (!isCompleted) {
                                    isCompleted = true;
                                    this.writeEmitter.fire(`\r\nFile uploaded: ${remotePath}\r\n`);
                                    // 刷新文件资源管理器，显示新上传的文件
                                    setTimeout(() => {
                                        this.refreshFileExplorer([remotePath]);
                                    }, 500);
                                    let prompt = this.getPrompt();
                                    this.writeEmitter.fire(prompt);
                                    resolve(true);
                                }
                            })
                            .on('end', async () => {
                                if (!isCompleted) {
                                    isCompleted = true;
                                    this.writeEmitter.fire(`\r\nFile uploaded: ${remotePath}\r\n`);
                                    // 刷新文件资源管理器，显示新上传的文件
                                    setTimeout(() => {
                                        this.refreshFileExplorer([remotePath]);
                                    }, 500);
                                    let prompt = this.getPrompt();
                                    this.writeEmitter.fire(prompt);
                                    resolve(true);
                                }
                            })
                            .on('close', async () => {
                                if (!isCompleted) {
                                    isCompleted = true;
                                    this.writeEmitter.fire(`\r\nFile uploaded: ${remotePath}\r\n`);
                                    // 刷新文件资源管理器，显示新上传的文件
                                    setTimeout(() => {
                                        this.refreshFileExplorer([remotePath]);
                                    }, 500);
                                    let prompt = this.getPrompt();
                                    this.writeEmitter.fire(prompt);
                                    resolve(true);
                                }
                            })
                            .on('error', (err: Error) => {
                                if (!isCompleted) {
                                    isCompleted = true;
                                    this.writeEmitter.fire(`\r\nUpload failed: ${err.message}\r\n`);
                                    reject(err);
                                }
                            });
                    });
                }).on('error', (err) => {
                    this.writeEmitter.fire(`SSH Error: ${err.message}\r\n`);
                    reject(err);
                }).connect({
                    host: this.getHost(),
                    port: this.getPort(),
                    username: this.getUsername(),
                    privateKey: this.privateKeyPath ? fs.readFileSync(this.privateKeyPath) : undefined
                });
            });
        } catch (error) {
            this.writeEmitter.fire(`Upload failed: ${error instanceof Error ? error.message : String(error)}\r\n`);
        }
    }

    // 创建进度条
    private createProgressBar(percentage: number): string {
        const barLength = 50;
        const filledLength = Math.floor((percentage / 100) * barLength);
        const emptyLength = barLength - filledLength;
        
        // 使用 ANSI 颜色代码使进度条更加美观
        return `\x1b[32m[${'█'.repeat(filledLength)}${' '.repeat(emptyLength)}]\x1b[0m`;
    }

    // 格式化文件大小显示
    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    public async handleFileDownload(args: string[] = []) {
        try {
            let remotePath: string;
            let localPath: string;
            let fileName: string;

            // 解析远程路径（支持相对路径）
            if (args.length > 0) {
                remotePath = args[0];
                // 如果是相对路径，拼接当前工作目录
                if (!remotePath.startsWith('/')) {
                    if (this.currentWorkingDirectory === '~') {
                        remotePath = `$HOME/${remotePath}`;
                    } else {
                        remotePath = `${this.currentWorkingDirectory}/${remotePath}`;
                    }
                    // 规范化路径（移除多余的 ./ 或 ../）
                    remotePath = remotePath.replace(/\/\.\//g, '/').replace(/\/[^\/]+\/\.\.\//g, '/');
                }
            } else {
                this.writeEmitter.fire('\r\nUsage: sz <remoteFile> [localFile]\r\n');
                return;
            }

            fileName = path.basename(remotePath);

            // 解析本地路径（支持用户选择保存位置）
            if (args.length > 1) {
                localPath = args[1];
            } else {
                const saveUri = await vscode.window.showSaveDialog({
                    title: 'Save File',
                    defaultUri: vscode.Uri.file(fileName)
                });
                if (!saveUri) return;
                localPath = saveUri.fsPath;
            }

            const conn = new Client();
            await new Promise((resolve, reject) => {
                conn.on('ready', () => {
                    conn.sftp((err, sftp) => {
                        if (err) {
                            this.writeEmitter.fire(`SFTP Error: ${err.message}\r\n`);
                            reject(err);
                            return;
                        }

                        // 获取远程文件大小用于显示进度条
                        sftp.stat(remotePath, (statErr, stats) => {
                            if (statErr) {
                                this.writeEmitter.fire(`Failed to get file size: ${statErr.message}\r\n`);
                                reject(statErr);
                                return;
                            }

                            const fileSize = stats.size;
                            let transferredBytes = 0;
                            let lastPercentage = -1;

                            this.writeEmitter.fire(`Starting download from ${remotePath} (${this.formatFileSize(fileSize)})\r\n`);

                            const readStream = sftp.createReadStream(remotePath);
                            const writeStream = fs.createWriteStream(localPath);
                            // 添加完成标志，确保只执行一次完成逻辑
                            let isCompleted = false;

                            // 监听数据传输进度
                            readStream.on('data', (chunk: Buffer) => {
                                transferredBytes += chunk.length;
                                const percentage = Math.floor((transferredBytes / fileSize) * 100);
                                
                                // 每1%更新一次进度条，避免过于频繁的更新
                                if (percentage !== lastPercentage) {
                                    lastPercentage = percentage;
                                    this.writeEmitter.fire(`\r${this.createProgressBar(percentage)} ${percentage}% (${this.formatFileSize(transferredBytes)}/${this.formatFileSize(fileSize)})`);
                                }
                            });

                            readStream.pipe(writeStream)
                                .on('finish', async () => {
                                    if (!isCompleted) {
                                        isCompleted = true;
                                        this.writeEmitter.fire(`\r\nFile downloaded: ${localPath}\r\n`);
                                        let prompt = this.getPrompt();
                                        this.writeEmitter.fire(prompt);
                                        resolve(true);
                                    }
                                })
                                .on('end', async () => {
                                    if (!isCompleted) {
                                        isCompleted = true;
                                        this.writeEmitter.fire(`\r\nFile downloaded: ${remotePath}\r\n`);
                                        let prompt = this.getPrompt();
                                        this.writeEmitter.fire(prompt);
                                        resolve(true);
                                    }
                                })
                                .on('close', async () => {
                                    if (!isCompleted) {
                                        isCompleted = true;
                                        this.writeEmitter.fire(`\r\nFile downloaded: ${remotePath}\r\n`);
                                        let prompt = this.getPrompt();
                                        this.writeEmitter.fire(prompt);
                                        resolve(true);
                                    }
                                })
                                .on('error', (err) => {
                                    this.writeEmitter.fire('\r                                                                                \r');
                                    this.writeEmitter.fire(`Download failed: ${err.message}\r\n`);
                                    reject(err);
                                });
                        });
                    });
                }).on('error', (err) => {
                    this.writeEmitter.fire(`SSH Error: ${err.message}\r\n`);
                    reject(err);
                }).connect({
                    host: this.getHost(),
                    port: this.getPort(),
                    username: this.getUsername(),
                    privateKey: this.privateKeyPath ? fs.readFileSync(this.privateKeyPath) : undefined
                });
            });
        } catch (error) {
            this.writeEmitter.fire(`Download failed: ${error instanceof Error ? error.message : String(error)}\r\n`);
        }
    }

    // 新增方法
    private getHostName(): string {
        return this.hostname;
    }

    private getHost(): string {
        const [_, hostPort] = this.connectionString.split('@');
        return hostPort.split(':')[0];
    }

    private getPort(): number {
        const [_, hostPort] = this.connectionString.split('@');
        const portStr = hostPort.split(':')[1];
        return portStr ? parseInt(portStr) : 22;
    }

    private getUsername(): string {
        return this.connectionString.split('@')[0];
    }

    private isRootUser(): boolean {
        return this.getUsername() === "root";
    }

    private async getActualDirectoryAfterCd(path: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.sshClient) {
                reject(new Error('SSH client not connected'));
                return;
            }

            // 构建获取新目录的命令
            const getNewDirCommand = `cd "${path}" && pwd`;

            this.sshClient.exec(getNewDirCommand, (err, stream) => {
                if (err) {
                    reject(err);
                    return;
                }

                let output = '';
                stream.on('data', (data: Buffer) => output += data.toString());
                stream.on('close', (code: number) => {
                    if (code === 0) {
                        const newDir = output.trim();
                        // 直接返回绝对路径，不要使用 ~ 符号
                        resolve(newDir);
                    } else {
                        reject(new Error(`cd command failed with code ${code}`));
                    }
                });
            });
        });
    }

    // 添加获取家目录的方法
    private async getHomeDirectory(): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.sshClient) return resolve('/home/' + this.getUsername());

            this.sshClient.exec('echo $HOME', (err, stream) => {
                if (err) return resolve('/home/' + this.getUsername());

                let output = '';
                stream.on('data', (data: Buffer) => output += data.toString());
                stream.on('close', () => resolve(output.trim() || '/home/' + this.getUsername()));
            });
        });
    }

    // 获取各种各样系统的提示符
    private getPrompt(): string {
        const username = this.getUsername();
        const hostname = this.getHostName();
        let userSymbol = "@";
        let promptSymbol = this.isRootUser() ? "#" : "$";

        // 获取当前目录

        const currentDir = ['kali', 'parrot', 'blackarch'].includes(this.systemType)
            ? this.currentWorkingDirectory
            : (this.currentWorkingDirectory === '~' ? '~' : path.basename(this.currentWorkingDirectory));

        switch (this.systemType) {
            // Kali Linux
            case 'kali': {
                userSymbol = this.isRootUser() ? "💀" : "@";
                return `\x1b[34m┌──(\x1b[31m${username}${userSymbol}${hostname}\x1b[34m)-[\x1b[37m${currentDir}\x1b[34m]\r\n\x1b[34m└─\x1b[31m${promptSymbol}\x1b[0m `;
            }
            // Parrot Linux
            case 'parrot': {
                userSymbol = this.isRootUser() ? "💀" : "@";
                return `\x1b[34m┌──(\x1b[31m${username}${userSymbol}${hostname}\x1b[34m)-[\x1b[37m${currentDir}\x1b[34m]\r\n\x1b[34m└─\x1b[31m${promptSymbol}\x1b[0m `;
            }
            // BlackArch Linux
            case 'blackarch': {
                userSymbol = this.isRootUser() ? "💀" : "@";
                return `\x1b[34m┌──(\x1b[31m${username}${userSymbol}${hostname}\x1b[34m)-[\x1b[37m${currentDir}\x1b[34m]\r\n\x1b[34m└─\x1b[31m${promptSymbol}\x1b[0m `;
            }
            // Ubuntu
            case 'ubuntu': {
                return `${username}@${hostname}:${currentDir}${promptSymbol} `;
            }
            // CentOS
            case 'centos': {
                return `[${username}@${hostname} ${currentDir}]${promptSymbol} `;
            }
            // Debian
            case 'debian': {
                return `[${username}@${hostname} ${currentDir}]${promptSymbol} `;
            }
            // 默认情况
            default: {
                return `[${username}@${hostname} ${currentDir}]${promptSymbol} `;
            }
        }
    }

    private calculatePromptVisibleLength(): number {
        const username = this.getUsername();
        const hostname = this.getHostName();
        const isRoot = this.isRootUser();
        const promptSymbol = isRoot ? "#" : "$";

        // 获取当前目录
        const currentDir = ['kali', 'parrot', 'blackarch'].includes(this.systemType)
            ? this.currentWorkingDirectory
            : (this.currentWorkingDirectory === '~' ? '~' : path.basename(this.currentWorkingDirectory));

        // Kali 格式：└─#
        if (this.systemType === 'kali') {
            return 4;
        } else if (this.systemType === 'parrot') {
            return 7;
        } else if (this.systemType === 'blackarch') {
            return 7;
        } else if (this.systemType === 'ubuntu') {
            // Ubuntu 格式: username@hostname:directory$
            return username.length + 1 + hostname.length + 1 + currentDir.length + promptSymbol.length + 1;
        } else if (this.systemType === 'centos' || this.systemType === 'debian') {
            // CentOS/RedHat 格式: [username@hostname directory]$
            return 1 + username.length + 1 + hostname.length + 1 + currentDir.length + 1 + promptSymbol.length + 1;
        } else {
            // 默认格式: username@hostname:~$ 
            return username.length + 1 + hostname.length + 2 + promptSymbol.length + 1;
        }
    }

    private async getTabSuggestions(input: string, fullContext?: string): Promise<string[]> {
        try {
            if (!this.sshClient) {
                console.log('SSH client is not connected');
                return [];
            }

            // 如果有完整上下文，使用完整上下文进行分析
            const contextToAnalyze = fullContext || input;

            // 处理多行输入：移除换行符和反斜杠，合并成单行
            const singleLine = contextToAnalyze.replace(/\\\s*\n/g, ' ').replace(/\n/g, ' ').trim();

            const words = singleLine.split(/\s+/);
            const lastWord = words.pop() || '';
            const isCommandInput = words.length === 0;

            // 如果是命令输入，补全命令列表
            if (isCommandInput) {
                const commonCommands = [
                    'ls', 'cd', 'pwd', 'cat', 'mkdir', 'rm', 'cp', 'mv',
                    'sz', 'rz', 'vim', 'nano', 'grep', 'find', 'chmod',
                    'ssh', 'scp', 'tar', 'ps', 'top', 'kill', 'df', 'du',
                    'systemctl', 'git', 'docker', 'npm', 'yarn', 'pip'
                ];
                return commonCommands.filter(cmd => cmd.startsWith(lastWord));
            }

            // 如果是 systemctl 的子命令补全
            if (words[0] === 'systemctl' && words.length > 1) {
                const systemctlSubCommands = [
                    'start', 'stop', 'restart', 'status',
                    'enable', 'disable', 'list-units', 'reload'
                ];
                return systemctlSubCommands.filter(cmd => cmd.startsWith(lastWord));
            }

            // 否则补全路径
            let targetDir = this.currentWorkingDirectory;
            if (targetDir === '~') {
                targetDir = await this.getHomeDirectory();
            }

            // 通过 SFTP 读取远程目录
            const files: string[] = await new Promise((resolve, reject) => {
                this.sshClient?.sftp((err, sftp) => {
                    if (err) {
                        console.error('SFTP error:', err);
                        reject(err);
                        return;
                    }

                    sftp.readdir(targetDir, (err, list) => {
                        if (err) {
                            console.error('Failed to read remote directory:', err);
                            reject(err);
                            return;
                        }

                        const filenames = list.map(item => item.filename);
                        console.log('Remote files:', filenames);
                        resolve(filenames);
                    });
                });
            });

            // 过滤出匹配最后一个单词的文件和文件夹
            const suggestions = files.filter(file => file.startsWith(lastWord));
            console.log('Suggestions for input:', lastWord, suggestions);
            return suggestions;
        } catch (error) {
            console.error(`Failed to get tab suggestions: ${error}`);
            return [];
        }
    }

    /**
     * 获取指定行的长度
     * @param lineIndex 行号（0-based）
     */
    private getLineLength(lineIndex: number): number {
        if (lineIndex < 0 || lineIndex >= this.lineLengths.length) {
            return 0;
        }
        return this.lineLengths[lineIndex];
    }

    /**
     * 移动到指定行列位置（使用正确的ANSI转义序列实现跨行移动）
     * @param targetLine 目标行号
     * @param targetColumn 目标列号
     */
    private moveToPosition(targetLine: number, targetColumn: number): void {
        if (!this.isMultiLine) return;

        // 边界检查
        targetLine = Math.max(0, Math.min(targetLine, this.lineStartIndexes.length - 1));
        targetColumn = Math.max(0, Math.min(targetColumn, this.getLineLength(targetLine)));

        // 计算相对移动量
        const lineDiff = targetLine - this.currentLine;
        const columnDiff = targetColumn - this.currentColumn;
        // 计算目标列 的字符总显示宽度 与 当前列的总字符显示宽度差值
        const displayWidthDiff = this.getDisplayWidthTo(targetLine, targetColumn) - this.getDisplayWidthTo(this.currentLine, this.currentColumn);

        // 使用相对移动命令实现跨行移动
        if (lineDiff !== 0) {
            // 跨行移动
            if (lineDiff > 0) {
                // 向下移动
                this.writeEmitter.fire(`\x1b[${lineDiff}B`);
            } else {
                // 向上移动
                this.writeEmitter.fire(`\x1b[${-lineDiff}A`);
            }
        }

        if (columnDiff !== 0) {
            // 水平移动
            if (columnDiff > 0) {
                // 行首向左移动一个字符，则移动到上一行的行尾
                if (lineDiff < 0) {
                    this.writeEmitter.fire('\r');
                    if (targetLine === 0) {
                        // 向右移动到提示符结束位置（跳过提示符）
                        let promptVisibleLength = this.calculatePromptVisibleLength();
                        if (promptVisibleLength > 0) {
                            this.writeEmitter.fire(`\x1b[${promptVisibleLength}C`);
                        }
                    } else {
                        this.writeEmitter.fire(`\x1b[2C`);
                    }
                }
                // 向右移动
                this.writeEmitter.fire(`\x1b[${displayWidthDiff}C`);
                // // 向右移动
                // this.writeEmitter.fire(`\x1b[${columnDiff}C`);
            } else {
                if (lineDiff > 0) {
                    // 行尾向右移动一个字符，则移动到下一行的行首
                    this.writeEmitter.fire('\r');
                    this.writeEmitter.fire(`\x1b[2C`);
                } else {
                    // 向左移动
                    this.writeEmitter.fire(`\x1b[${-displayWidthDiff}D`);
                    // // 向左移动
                    // this.writeEmitter.fire(`\x1b[${-columnDiff}D`);
                }
            }
        } else {
            // 行号0，直接向下移动 1 次
            if (this.currentLine === 0 && lineDiff > 0) {
                this.writeEmitter.fire(`\r`);
                this.writeEmitter.fire(`\x1b[2C`);
                if (targetColumn !== 0) {
                    const displayWidthToMove = this.getDisplayWidthTo(targetLine, targetColumn);
                    this.writeEmitter.fire(`\x1b[${displayWidthToMove}C`);
                }
            } else if (lineDiff < 0 && targetLine === 0) {
                this.writeEmitter.fire('\r');
                // 向右移动到提示符结束位置（跳过提示符）
                let promptVisibleLength = this.calculatePromptVisibleLength();
                if (promptVisibleLength > 0) {
                    this.writeEmitter.fire(`\x1b[${promptVisibleLength}C`);
                }
                if (targetColumn !== 0) {
                    const displayWidthToMove = this.getDisplayWidthTo(targetLine, targetColumn);
                    this.writeEmitter.fire(`\x1b[${displayWidthToMove}C`);
                }
            } else if (lineDiff < 0 && targetLine !== 0) {
                this.writeEmitter.fire(`\r`);
                this.writeEmitter.fire(`\x1b[2C`);
                if (targetColumn !== 0) {
                    const displayWidthToMove = this.getDisplayWidthTo(targetLine, targetColumn);
                    this.writeEmitter.fire(`\x1b[${displayWidthToMove}C`);
                }
            } else {
                // 移动到指定列
                this.writeEmitter.fire(`\r`);
                this.writeEmitter.fire(`\x1b[2C`);
                if (targetColumn !== 0) {
                    const displayWidthToMove = this.getDisplayWidthTo(targetLine, targetColumn);
                    this.writeEmitter.fire(`\x1b[${displayWidthToMove}C`);
                }
            }
        }

        // 更新当前行列位置
        this.currentLine = targetLine;
        this.currentColumn = targetColumn;
        this.cursorPosition = targetColumn;
    }

    /**
     * 处理跨行光标移动的边界控制
     * @param direction 移动方向 ('left', 'right', 'up', 'down')
     */
    private handleCrossLineMovement(direction: string): void {
        if (!this.isMultiLine) return;

        switch (direction) {
            case 'left':
                if (this.currentColumn > 0) {
                    // 在当前行内向左移动（使用绝对位置移动）
                    this.moveToPosition(this.currentLine, this.currentColumn - 1);
                } else if (this.currentLine > 0) {
                    // 在一行开头按左键，移动到上一行的末尾
                    const prevLineLength = this.getLineLength(this.currentLine - 1);
                    this.moveToPosition(this.currentLine - 1, prevLineLength);
                }
                break;

            case 'right':
                const currentLineLength = this.getLineLength(this.currentLine);
                // 调试信息：输出当前行列状态
                console.log(`Right arrow: line=${this.currentLine}, col=${this.currentColumn}, lineLength=${currentLineLength}, totalLines=${this.lineStartIndexes.length}`);

                if (this.currentColumn < currentLineLength) {
                    // 在当前行内向右移动（使用绝对位置移动）
                    this.moveToPosition(this.currentLine, this.currentColumn + 1);
                } else if (this.currentLine < this.lineStartIndexes.length - 1) {
                    // 移动到下一行的行首（逻辑位置0，显示位置为2）
                    this.moveToPosition(this.currentLine + 1, 0);
                } else {
                    // 如果在最后一行行尾，保持当前位置
                    console.log('At end of last line, cannot move right');
                }
                break;

            case 'up':
                if (this.currentLine > 0) {
                    // 移动到上一行的相同列位置（不超过上一行的长度）
                    const prevLineLength = this.getLineLength(this.currentLine - 1);
                    const targetColumn = Math.min(this.currentColumn, prevLineLength);
                    this.currentColumn = targetColumn;
                    this.cursorPosition = targetColumn;
                    this.moveToPosition(this.currentLine - 1, targetColumn);
                }
                break;

            case 'down':
                if (this.currentLine < this.lineStartIndexes.length - 1) {
                    // 移动到下一行的相同列位置（不超过下一行的长度）
                    const nextLineLength = this.getLineLength(this.currentLine + 1);
                    const targetColumn = Math.min(this.currentColumn, nextLineLength);
                    this.currentColumn = targetColumn;
                    this.cursorPosition = targetColumn;
                    this.moveToPosition(this.currentLine + 1, targetColumn);
                }
                break;
        }
    }

    // 清除下一行并返回当前位置
    private clearNextLineAndReturn(): void {
        if (!this.isMultiLine) return;
        if (this.currentLine >= this.lineLengths.length) return;
        // 保存当前位置
        const savedLine = this.currentLine;
        const savedColumn = this.currentColumn;

        let deleteLine = savedLine + 1;
        this.lineLengths.splice(deleteLine, 1);
        this.lineStartIndexes.splice(deleteLine, 1);
        this.lineDisplayWidths.splice(deleteLine, 1);
        this.writeEmitter.fire('\x1b[1E\x1b[2K');
        this.currentLine++;
        this.redrawFromLine(deleteLine);
        this.writeEmitter.fire('\x1b[1E\x1b[2K');
        this.writeEmitter.fire(`\x1b[1A`);
        this.writeEmitter.fire(`\r`);
        this.writeEmitter.fire(`\x1b[2C`);
        this.writeEmitter.fire(`\x1b[${this.lineLengths[this.currentLine]}C`);
        this.currentColumn = this.lineLengths[savedLine];
        this.cursorPosition = this.lineLengths[savedLine];
        this.moveToPosition(savedLine, savedColumn);
    }

    // 清除当前行并返回上一行行尾
    private clearCurrentLineAndReturn(isRetuanLastLine: boolean = true): void {
        if (!this.isMultiLine) return;
        if (this.lineLengths.length === 1 || this.currentLine < 1) return;
        let deleteLine = this.currentLine;
        let cacheEndLine = this.lineLengths.length - 1; //缓存最后一行的行号
        this.lineLengths.splice(deleteLine, 1);
        this.lineStartIndexes.splice(deleteLine, 1);
        this.lineDisplayWidths.splice(deleteLine, 1);
        if (this.currentLine >= 1 && this.currentLine < cacheEndLine) {
            // 重新渲染删除行之后的行
            this.redrawFromLine(deleteLine);
            // 重新渲染之后最后一行会在原来的位置残留，需要清除掉
            this.writeEmitter.fire('\x1b[1E\x1b[2K');
            // 清除旧的残留需要将光标移动到最后一行的行尾
            this.writeEmitter.fire(`\x1b[1A`);
            this.writeEmitter.fire(`\r`);
            this.writeEmitter.fire(`\x1b[2C`);
            //this.writeEmitter.fire(`\x1b[${this.lineLengths[this.currentLine]}C`);
            // 先移动到最后一行
            const dispWidth = this.getDisplayWidthTo(this.currentLine, this.currentColumn);
            this.writeEmitter.fire(`\x1b[${dispWidth}C`);
            // 在移动到删除行的上一行
            // this.moveToPosition(deleteLine - 1, this.lineLengths[deleteLine - 1]);
        } else {
            // 清除最后一行
            this.writeEmitter.fire('\x1b[2K');
        }
        // 默认移动到删除行的上一行
        if (isRetuanLastLine) {
            this.currentColumn = this.lineLengths[deleteLine - 1];
            this.cursorPosition = this.lineLengths[deleteLine - 1];
            this.moveToPosition(deleteLine - 1, this.lineLengths[deleteLine - 1]);
        }
        else {
            this.currentColumn = this.lineLengths[deleteLine];
            this.cursorPosition = this.lineLengths[deleteLine];
            this.moveToPosition(deleteLine, 0);
        }
    }

    /**
     * 在当前行之后插入一个空行
     * @param currentLine 当前行号（0-based）
     */
    private insertEmptyLineAfter(): void {
        // 边界检查
        if (this.currentLine < 0 || this.currentLine >= this.lineStartIndexes.length - 1) {
            return;
        }

        // 计算当前行的结束位置
        const currentLineEnd = this.lineStartIndexes[this.currentLine] + this.lineLengths[this.currentLine];

        // 获取下一行的起始位置
        const nextLineStart = this.lineStartIndexes[this.currentLine + 1];

        // 保存下一行及之后的所有内容
        const afterContent = this.multiLineBuffer.slice(nextLineStart);

        // 在当前行末尾插入换行符
        this.multiLineBuffer = this.multiLineBuffer.slice(0, currentLineEnd) + '' + afterContent;

        // 更新行列跟踪系统
        const newLineIndex = this.currentLine + 1;
        this.lineStartIndexes.splice(newLineIndex, 0, currentLineEnd);
        this.lineLengths.splice(newLineIndex, 0, 0);

        // 修复：更新宽度跟踪系统
        this.lineDisplayWidths.splice(newLineIndex, 0, []); // 插入空行，宽度数组为空

        // 更新光标位置到新插入的空行
        this.currentLine = newLineIndex;
        this.currentColumn = 0;
        this.cursorPosition = 0;

        this.writeEmitter.fire('\n');
        // 重绘从当前行开始的所有行
        this.redrawFromLine(newLineIndex);
        // 插入空行后，当前列要重置为0
        this.currentColumn = 0;
        this.cursorPosition = 0;
        // 移动光标到正确位置
        this.moveToPosition(newLineIndex, 0);
    }

    private splitLineAtCursor(): void {
        if (this.currentLine < 0 || this.currentLine > this.lineLengths.length - 1) {
            return;
        }

        // 计算当前行的切割位置
        const currentLineStart = this.lineStartIndexes[this.currentLine];
        const splitPosition = currentLineStart + this.currentColumn;

        // 获取要移动到新行的内容
        const movedContent = this.multiLineBuffer.slice(splitPosition, currentLineStart + this.lineLengths[this.currentLine]);

        // 获取下一行及之后的内容
        const nextLineStart = this.lineStartIndexes[this.currentLine + 1];
        const afterContent = this.multiLineBuffer.slice(nextLineStart);

        // 重新构建缓冲区：在当前光标位置插入换行符 + 要移动的内容
        this.multiLineBuffer = this.multiLineBuffer.slice(0, splitPosition) + movedContent + afterContent;

        // 更新当前行长度
        this.lineLengths[this.currentLine] = this.currentColumn;

        // 修复：更新当前行的宽度跟踪
        if (this.lineDisplayWidths[this.currentLine]) {
            this.lineDisplayWidths[this.currentLine] = this.lineDisplayWidths[this.currentLine].slice(0, this.currentColumn);
        }

        // 插入新行
        const newLineIndex = this.currentLine + 1;
        this.lineStartIndexes.splice(newLineIndex, 0, splitPosition);
        this.lineLengths.splice(newLineIndex, 0, movedContent.length);

        // 修复：更新新行的宽度跟踪
        const movedWidths: number[] = [];
        for (let i = 0; i < movedContent.length; i++) {
            movedWidths.push(this.getCharDisplayWidth(movedContent[i]));
        }
        this.lineDisplayWidths.splice(newLineIndex, 0, movedWidths);

        this.renderRemainingLine();

        // 更新光标位置到新行的行尾
        this.currentLine = newLineIndex;
        this.currentColumn = 0;
        this.cursorPosition = 0;

        this.writeEmitter.fire('\n');
        // 重绘受影响的行
        this.redrawFromLine(newLineIndex); // 从下一行开始重绘

        // 移动光标到正确位置
        this.moveToPosition(newLineIndex, movedContent.length);
    }

    private async handleMultiLinePaste(lines: string[]): Promise<void> {
        if (lines.length === 0) return;

        let startLine = this.currentLine;
        let finalPasteLine = startLine + lines.length - 1;
        let finalPasteCol = lines[lines.length - 1].length - 1;
        // 缓存下一行至最后一行的内容
        for (let i = startLine + 1; i < this.lineStartIndexes.length; i++) {
            if (i < this.lineStartIndexes.length - 1) {
                lines.push(this.multiLineBuffer.slice(this.lineStartIndexes[i], this.lineStartIndexes[i + 1]));
            } else {
                lines.push(this.multiLineBuffer.slice(this.lineStartIndexes[i]));
            }
        }

        // 清除下一行之后的内容
        this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[startLine + 1]);
        const length = this.lineStartIndexes.length;
        this.lineStartIndexes.splice(startLine + 1, length - startLine - 1);
        this.lineLengths.splice(startLine + 1, length - startLine - 1);

        // 修复：同时清除对应的宽度跟踪
        this.lineDisplayWidths.splice(startLine + 1, length - startLine - 1);

        for (let i = 0; i < lines.length; i++) {
            this.currentLine = startLine + i;
            // 判断当前行的 是否NaN
            if (isNaN(this.lineLengths[this.currentLine])) {
                this.lineLengths[this.currentLine] = 0;
                if (this.currentLine > 0) {
                    this.lineStartIndexes[this.currentLine] = this.lineStartIndexes[this.currentLine - 1] + this.lineLengths[this.currentLine - 1];
                } else {
                    this.lineStartIndexes[this.currentLine] = 0;
                }
            }
            this.insertTextAtCursor(lines[i]);
            if (i < lines.length - 1) {
                this.writeEmitter.fire('\r\n> ');
                this.currentColumn = 0;
                this.cursorPosition = 0;
            }
        }
        this.moveToPosition(finalPasteLine, finalPasteCol);
    }
    // 在当前光标位置插入文本
    private insertTextAtCursor(text: string): void {
        // 判断是否开启了多行模式
        if (this.isMultiLine) {
            const currentPos = this.lineStartIndexes[this.currentLine] + this.currentColumn;
            this.multiLineBuffer = this.multiLineBuffer.slice(0, currentPos) +
                text +
                this.multiLineBuffer.slice(currentPos);

            // 记录每个字符的显示宽度
            for (let i = 0; i < text.length; i++) {
                const char = text.charAt(i);
                this.insertCharWithWidthTracking(this.currentLine, this.currentColumn + i, char);
            }

            this.lineLengths[this.currentLine] += text.length;
            this.currentColumn += text.length;
            this.cursorPosition += text.length;

            // 更新后续行的起始索引
            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                this.lineStartIndexes[i] += text.length;
            }
            this.writeEmitter.fire(text);
            // 重绘当前行
            this.renderRemainingLine();
        } else {
            this.cmd = this.cmd.slice(0, this.cursorPosition) + text + this.cmd.slice(this.cursorPosition);

            // 记录每个字符的显示宽度
            for (let i = 0; i < text.length; i++) {
                const char = text.charAt(i);
                this.insertCharWithWidthTracking(0, this.cursorPosition + i, char);
            }

            this.lineLengths[0] += text.length;
            this.currentColumn += text.length;
            this.cursorPosition += text.length;

            // 单行模式：直接插入
            this.writeEmitter.fire(text);
            // 重绘当前行
            this.renderRemainingLine();
        }
    }

    /**
     * 重绘从指定行开始的所有行
     */
    private redrawFromLine(startLine: number): void {
        // 更简单的重绘方案：只重绘受影响的行
        for (let i = startLine; i < this.lineLengths.length; i++) {
            // 移动到行首
            this.writeEmitter.fire('\r');
            // 清除当前行
            this.writeEmitter.fire('\x1b[K');
            // 显示提示符（如果是提示符行）
            if (i > 0) {
                this.writeEmitter.fire('> ');
            }
            // 显示行内容
            const lineContent = this.multiLineBuffer.slice(
                this.lineStartIndexes[i],
                this.lineStartIndexes[i] + this.lineLengths[i]
            );
            this.writeEmitter.fire(lineContent);
            this.currentColumn = this.lineLengths[i];
            this.cursorPosition = this.lineLengths[i];
            // 如果不是最后一行，换行
            if (i < this.lineLengths.length - 1) {
                this.writeEmitter.fire('\r\n');
                this.currentLine++;
            }
        }
    }

}
