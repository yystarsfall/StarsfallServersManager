import * as vscode from 'vscode';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';

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
    private isInsertMode = false;
    private systemType = ''; // 系统类型
    private terminalHeight: number = 24; //终端高度
    private terminalWidth: number = 80;  //终端宽度
    private currentWorkingDirectory: string = '~';

    // 实现 Pseudoterminal 接口
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    constructor(
        private connectionString: string,
        private privateKeyPath?: string,
        hostname?: string,
        systemType?: string// 新增参数
    ) {
        this.hostname = hostname || this.getHost(); // 如果未提供，则从 connectionString 中提取
        this.systemType = systemType || ''; // 如果未提供，则默认为空字符串
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
        const lines = fullCommand.split('\n');
        const baseCommand = lines[0].trim();
        const args = lines.slice(1).filter(line => line.trim() !== '');

        // 检测 cd 命令并更新缓存目录
        if (baseCommand.startsWith('cd ')) {
            const args = baseCommand.split(' ').slice(1);
            this.handleCdCommand(args[0]);
            return;
        }

        if (baseCommand.startsWith('rz')) {
            this.handleFileUpload(args);
        } else if (baseCommand.startsWith('sz')) {
            this.handleFileDownload(args);
        } else if (baseCommand.startsWith('Ctrl-C')) {
            // 这里应该发送真正的终止信号
            if (this.sshStream) {
                this.sshStream.write('\x03'); // 发送Ctrl-C字符
            }
        } else if (this.isEditorCommand(baseCommand)) {
            // vim/vi 等编辑器命令：开启实时模式并直接发送命令
            this.isEditorMode = true;
            this.editorBuffer = '';
            if (this.sshStream) {
                this.sshStream.write(fullCommand + '\n');
            }
        } else {
            // 对于其他命令，通过SSH连接发送
            if (this.sshStream) {
                this.sshStream.write(fullCommand + '\n');
            } else {
                this.writeEmitter.fire('\r\nSSH connection is not established.\r\n');
            }
        }
    }

    // 添加处理 cd 命令的方法
    private async handleCdCommand(path: string): Promise<void> {
        try {
            // 通过 SSH 执行 cd 命令并获取新的当前目录
            const newDir = await this.getActualDirectoryAfterCd(path);
            this.currentWorkingDirectory = newDir;

            // 发送 cd 命令到远程 shell
            if (this.sshStream) {
                this.sshStream.write(`cd "${path}"\n`);
            }
        } catch (error) {
            console.error('Failed to change directory:', error);
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
                // 将光标移回原始位置
                this.writeEmitter.fire(`\x1b[${this.lineLengths[this.currentLine] - this.currentColumn}D`);
            }
        } else {
            // 输出剩余字符
            if (this.cursorPosition < this.cmd.length) {
                this.writeEmitter.fire(this.cmd.slice(this.cursorPosition));
            }
            // 将光标移回原始位置
            if (this.cursorPosition < this.cmd.length) {
                this.writeEmitter.fire(`\x1b[${this.cmd.length - this.cursorPosition}D`);
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
            /ZQ$/                  // ZQ 结尾
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

    async handleInput(data: string): Promise<void> {
        // 如果处于编辑器模式，累积输入以检测退出命令
        if (this.isEditorMode) {
            this.editorBuffer += data;

            // 检测 vim/vi 退出命令
            if (this.detectEditorExitCommand()) {
                this.isEditorMode = false;
                this.editorBuffer = '';
                // 可选：清空命令行缓冲区
                this.cmd = '';
                this.multiLineBuffer = '';
            }

            // 实时转发所有输入到 SSH
            if (this.sshStream) {
                this.sshStream.write(data);
            }
            return;
        }

        console.log(`Received input: ${data}`);

        const code = data.charCodeAt(0);
        console.log(`Received input (code): ${code}`);

        const hexValue = Array.from(data).map(c => c.charCodeAt(0).toString(16)).join(', ');
        console.log(`Received input (hex): ${hexValue}`);

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
                this.lineStartIndexes[this.currentLine] = this.multiLineBuffer.length;
                this.lineLengths[this.currentLine] = 0;
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
                    this.lineStartIndexes[this.currentLine] = this.multiLineBuffer.length;

                    this.lineLengths[this.currentLine] = 0;
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
                    this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn) + data + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                    this.lineLengths[this.currentLine] += data.length;
                    this.currentColumn += data.length;
                    // 后续的每一行的起始位置都要加1
                    for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                        this.lineStartIndexes[i]++;
                    }
                    this.renderRemainingLine();
                    return;
                } else {
                    if (this.currentColumn === this.getCurrentLineLength()) {
                        this.writeEmitter.fire(data);
                        this.multiLineBuffer += data;
                        this.currentColumn += data.length;
                        this.lineLengths[this.currentLine] = this.multiLineBuffer.length - this.lineStartIndexes[this.currentLine];
                        return;
                    } else {
                        // 将data 添加到当前行的当前列，且不影响当前列后面的内容
                        this.writeEmitter.fire(data);
                        this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn) + data + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                        this.lineLengths[this.currentLine] += data.length;
                        this.currentColumn += data.length;
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
                this.cmd = '';
                this.multiLineBuffer = '';
                this.editorBuffer = '';
                this.isMultiLine = false;
                this.currentLine = 0;
                this.currentColumn = 0;
                this.cursorPosition = 0;
                this.lineLengths = [0];
                this.lineStartIndexes = [0];
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
                    this.isMultiLine = false;
                    this.multiLineBuffer = '';
                    this.editorBuffer = '';
                    // 重置行列位置
                    this.currentLine = 0;
                    this.currentColumn = 0;
                    this.lineStartIndexes = [0];
                    this.lineLengths = [0];
                    this.cmd = '';
                    this.cursorPosition = 0;
                    //prompt = this.getPrompt();
                    //this.writeEmitter.fire('\r\n' + prompt);
                    //break;
                } else {
                    this.writeEmitter.fire('\r\n');
                    this.processCommand(this.cmd);
                    this.addToHistory(this.cmd);
                    this.cmd = '';
                    this.multiLineBuffer = '';
                    this.editorBuffer = '';
                    this.isMultiLine = false;
                    this.currentLine = 0;
                    this.currentColumn = 0;
                    this.cursorPosition = 0;
                    //prompt = this.getPrompt();
                    //this.writeEmitter.fire(prompt);
                    //break;
                }
                break;
            case 127: // Backspace 键
                if (this.isMultiLine) {
                    if (this.multiLineBuffer.length > 0) {
                        // 判断是否在行中
                        if (this.currentColumn > 0 && this.currentColumn < this.getCurrentLineLength()) {
                            // 如果在行中，删除字符
                            this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn - 1) + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                            this.currentColumn--;
                            this.lineLengths[this.currentLine]--;
                            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                                this.lineStartIndexes[i]--;
                            }
                            this.writeEmitter.fire('\b \b');
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
                            // 将当前行当前列的前一个字符 删除
                            this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn - 1) + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                            this.currentColumn--;
                            this.lineLengths[this.currentLine]--;
                            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                                this.lineStartIndexes[i]--;
                            }
                            this.writeEmitter.fire('\b \b');
                            this.renderRemainingLine();
                        }

                    }
                } else {
                    if (this.cmd.length > 0 && this.cursorPosition > 0) {
                        this.cmd = this.cmd.slice(0, this.cursorPosition - 1) + this.cmd.slice(this.cursorPosition);
                        this.multiLineBuffer = this.cmd;
                        this.cursorPosition--;
                        this.currentColumn--;
                        this.writeEmitter.fire('\b \b');
                        this.renderRemainingLine(); // 重新渲染剩余内容
                    }
                }
                break;
            case 27: // 
                if (data === '\x1b') { // 退出编辑插入模式
                    this.isMultiLine = false;
                    this.multiLineBuffer = '';
                    this.currentLine = 0;
                    this.currentColumn = 0;
                    this.lineStartIndexes = [0];
                    this.lineLengths = [0];
                    this.cmd = '';
                    this.cursorPosition = 0;
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
                            this.cursorPosition--;
                            this.currentColumn--;
                            this.writeEmitter.fire('\x1b[D');
                        }
                    }
                    return;
                } else if (data === '\x1b[C' || data === '\x1bOC') { // 向右键
                    if (this.isMultiLine) {
                        this.handleCrossLineMovement('right');
                    } else {
                        if (this.cursorPosition < this.cmd.length) {
                            this.cursorPosition++;
                            this.currentColumn++;
                            this.writeEmitter.fire('\x1b[C');
                        }
                    }
                    return;
                } else if (data === '\x1bOF' || data === '\x1b[F' || data === '\x1b[4~') { // End 键
                    if (this.isMultiLine) {
                        // 使用moveToPosition方法移动到当前行的末尾
                        const currentLineLength = this.getCurrentLineLength();
                        this.moveToPosition(this.currentLine, currentLineLength);
                    } else {
                        // 计算需要向右移动的光标位置
                        const moveRight = this.cmd.length - this.cursorPosition;
                        if (moveRight > 0) {
                            this.writeEmitter.fire(`\x1b[${moveRight}C`); // 向右移动光标
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
                        // 计算需要向左移动的光标位置
                        const moveLeft = this.cursorPosition;
                        if (moveLeft > 0) {
                            this.writeEmitter.fire(`\x1b[${moveLeft}D`); // 向左移动光标
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
                        if (this.currentColumn > 0 && this.currentColumn < this.lineLengths[this.currentLine]) {
                            this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn - 1) + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);
                            //this.writeEmitter.fire('\x1b[D \x1b[D');
                            this.writeEmitter.fire('\x1b[P');
                            this.lineLengths[this.currentLine]--;
                            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                                this.lineStartIndexes[i]--;
                            }
                            this.renderRemainingLine(); // 重新渲染剩余内容
                        } else if (this.currentColumn === this.lineLengths[this.currentLine] && this.lineLengths[this.currentLine + 1] === 0) {
                            // 如果下一行是空行，删除下一行
                            this.clearNextLineAndReturn();
                        }
                    } else {
                        if (this.cmd.length > 0 && this.cursorPosition < this.cmd.length) {
                            this.cmd = this.cmd.slice(0, this.cursorPosition) + this.cmd.slice(this.cursorPosition + 1);
                            this.multiLineBuffer = this.cmd;
                            this.writeEmitter.fire('\x1b[P');
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
                    const linePreviousContent = this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine], this.lineStartIndexes[this.currentLine] + this.currentColumn);
                    // 获取当前行，当前列的代码补全建议
                    const linePreviousSuggestions = await this.getTabSuggestions(linePreviousContent);
                    if (linePreviousSuggestions.length === 1) {
                        // 如果只有一个建议，自动补全
                        const fixword = linePreviousSuggestions[0].slice(linePreviousContent.length);
                        // 插入当前行，当前列之后的内容，并且不要影响后面的内容
                        this.multiLineBuffer = this.multiLineBuffer.slice(0, this.lineStartIndexes[this.currentLine] + this.currentColumn) + fixword + this.multiLineBuffer.slice(this.lineStartIndexes[this.currentLine] + this.currentColumn);

                        // 更新当前行的长度
                        this.lineLengths[this.currentLine] += fixword.length;
                        // 更新光标位置
                        this.currentColumn += fixword.length;
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
                        this.cmd += fixword;
                        this.cursorPosition = this.cmd.length;
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
                this.cmd = '';
                this.cursorPosition = 0;
                this.currentColumn = 0;
                this.currentLine = 0;
                this.lineStartIndexes = [0];
                this.lineLengths = [0];
                this.multiLineBuffer = '';
                const clearPrompt = this.getPrompt();  // 使用新的局部变量
                this.writeEmitter.fire(clearPrompt);
                return;
            default:
                if (this.cursorPosition < this.cmd.length) {

                    // 插入模式：在光标位置之前插入字符
                    this.cmd = this.cmd.slice(0, this.cursorPosition) + data + this.cmd.slice(this.cursorPosition);
                    this.multiLineBuffer = this.cmd;
                    this.cursorPosition += data.length;
                    this.currentColumn += data.length;
                    this.lineLengths[this.currentLine] += data.length;
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
                        this.writeEmitter.fire(dataStr);
                    }).on('close', () => {
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

                        readStream.pipe(writeStream);

                        writeStream
                            .on('finish', async () => {
                                this.writeEmitter.fire(`File uploaded: ${remotePath}\r\n`);
                                let prompt = this.getPrompt();
                                this.writeEmitter.fire(prompt);
                                resolve(true);
                            })
                            .on('end', async () => {
                                this.writeEmitter.fire(`File uploaded: ${remotePath}\r\n`);
                                let prompt = this.getPrompt();
                                this.writeEmitter.fire(prompt);
                                resolve(true);
                            })
                            .on('close', async () => {
                                this.writeEmitter.fire(`File uploaded: ${remotePath}\r\n`);
                                let prompt = this.getPrompt();
                                this.writeEmitter.fire(prompt);
                                resolve(true);
                            })
                            .on('error', (err: Error) => {
                                this.writeEmitter.fire(`Upload failed: ${err.message}\r\n`);
                                reject(err);
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

    public async handleFileDownload(args: string[] = []) {
        try {
            let remotePath: string;
            let localPath: string;
            let fileName: string;
            // 如果 args 包含远程路径，直接使用；否则使用默认路径
            remotePath = args[0] || './file-to-download';
            fileName = path.basename(remotePath);
            // 如果 args 包含本地路径，直接使用；否则打开保存对话框
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

                        const readStream = sftp.createReadStream(remotePath);
                        const writeStream = fs.createWriteStream(localPath);

                        readStream.pipe(writeStream)
                            .on('finish', async () => {
                                this.writeEmitter.fire(`File downloaded: ${localPath}\r\n`);
                                let prompt = this.getPrompt();
                                this.writeEmitter.fire(prompt);
                                resolve(true);
                            })
                            .on('end', async () => {
                                this.writeEmitter.fire(`File downloaded: ${remotePath}\r\n`);
                                let prompt = this.getPrompt();
                                this.writeEmitter.fire(prompt);
                                resolve(true);
                            })
                            .on('close', async () => {
                                this.writeEmitter.fire(`File downloaded: ${remotePath}\r\n`);
                                let prompt = this.getPrompt();
                                this.writeEmitter.fire(prompt);
                                resolve(true);
                            })
                            .on('error', (err) => {
                                this.writeEmitter.fire(`Download failed: ${err.message}\r\n`);
                                reject(err);
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
    private  getPrompt(): string {
        const username = this.getUsername();
        const hostname = this.getHostName();
        let userSymbol = "@";
        let promptSymbol = this.isRootUser() ? "#" : "$";

        switch (this.systemType) {
            //kali linux 
            case 'kali': {
                userSymbol = this.isRootUser() ? "💀" : "@";
                return `\x1b[34m┌──(\x1b[31m${username}${userSymbol}${hostname}\x1b[34m)-[\x1b[37m${this.currentWorkingDirectory}\x1b[34m]\r\n\x1b[34m└─\x1b[31m${promptSymbol}\x1b[0m `;
            }
            //parrot linux
            case 'parrot': {
                userSymbol = this.isRootUser() ? "💀" : "@";
                return `\x1b[34m┌──(\x1b[31m${username}${userSymbol}${hostname}\x1b[34m)-[\x1b[37m${this.currentWorkingDirectory}\x1b[34m]\r\n\x1b[34m└─\x1b[31m${promptSymbol}\x1b[0m `;
            }
            //blackarch linux
            case 'blackarch': {
                userSymbol = this.isRootUser() ? "💀" : "@";
                return `\x1b[34m┌──(\x1b[31m${username}${userSymbol}${hostname}\x1b[34m)-[\x1b[37m${this.currentWorkingDirectory}\x1b[34m]\r\n\x1b[34m└─\x1b[31m${promptSymbol}\x1b[0m `;
            }
            //ubuntu
            case 'ubuntu': {
                return `${username}@${hostname}:${this.currentWorkingDirectory}${promptSymbol} `;
            }
            //centos
            case 'centos': {
                return `[${username}@${hostname} ${this.currentWorkingDirectory}]${promptSymbol} `;
            }
            //debian
            case 'debian': {
                return `[${username}@${hostname} ${this.currentWorkingDirectory}]${promptSymbol} `;
            }
            default: {
                return `[${username}@${hostname} ${this.currentWorkingDirectory}]${promptSymbol} `;
            }
        }

    }

    private calculatePromptVisibleLength(): number {
        const username = this.getUsername();
        const hostname = this.getHostName();
        const isRoot = this.isRootUser();
        const promptSymbol = isRoot ? "#" : "$";

        // kali格式：└─#
        if (this.systemType === 'kali') {
            return 4;
        } else if (this.systemType === 'parrot') {
            return 7;
        } else if (this.systemType === 'blackarch') {
            return 7;
        } else if (this.systemType === 'ubuntu') {
            // Ubuntu格式: username@hostname:directory$
            return username.length + 1 + hostname.length + 1 + this.currentWorkingDirectory.length + promptSymbol.length + 1;
        } else if (this.systemType === 'centos' || this.systemType === 'debian') {
            // CentOS/RedHat格式: [username@hostname directory]$
            return 1 + username.length + 1 + hostname.length + 1 + this.currentWorkingDirectory.length + 1 + promptSymbol.length + 1;
        } else {
            // 默认格式: username@hostname:~$ 
            return username.length + 1 + hostname.length + 2 + promptSymbol.length + 1;
        }
    }

    private async getTabSuggestions(input: string): Promise<string[]> {
        try {
            if (!this.sshClient) {
                console.log('SSH client is not connected');
                return [];
            }

            // 提取最后一个单词作为补全输入（如从 "ls -lh he" 中提取 "he"）
            const lastWord = input.split(/\s+/).pop() || '';
            // 将 ~ 符号转换为实际的家目录路径
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
            console.error(`Failed to read remote directory: ${error}`);
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
                this.writeEmitter.fire(`\x1b[${columnDiff}C`);
            } else {
                if (lineDiff > 0) {
                    // 行尾向右移动一个字符，则移动到下一行的行首
                    this.writeEmitter.fire('\r');
                    this.writeEmitter.fire(`\x1b[2C`);
                } else {
                    // 向左移动
                    this.writeEmitter.fire(`\x1b[${-columnDiff}D`);
                }
            }
        } else {
            // 行号0，直接向下移动 1 次
            if (this.currentLine === 0 && lineDiff > 0) {
                this.writeEmitter.fire(`\r`);
                this.writeEmitter.fire(`\x1b[2C`);
                //this.writeEmitter.fire(`\x1b[${2 + targetColumn}C`);
                if (targetColumn !== 0) {
                    this.writeEmitter.fire(`\x1b[${targetColumn}C`);
                }
            } else if (lineDiff < 0 && targetLine === 0) {
                this.writeEmitter.fire('\r');
                // 向右移动到提示符结束位置（跳过提示符）
                let promptVisibleLength = this.calculatePromptVisibleLength();
                if (promptVisibleLength > 0) {
                    this.writeEmitter.fire(`\x1b[${promptVisibleLength}C`);
                }
                if (targetColumn !== 0) {
                    this.writeEmitter.fire(`\x1b[${targetColumn}C`);
                }
            } else if (lineDiff < 0 && targetLine !== 0) {
                this.writeEmitter.fire(`\r`);
                this.writeEmitter.fire(`\x1b[2C`);
                if (targetColumn !== 0) {
                    this.writeEmitter.fire(`\x1b[${targetColumn}C`);
                }
            } else {
                // 移动到指定列
                this.writeEmitter.fire(`\r`);
                this.writeEmitter.fire(`\x1b[2C`);
                if (targetColumn !== 0) {
                    this.writeEmitter.fire(`\x1b[${targetColumn}C`);
                }
            }
        }

        // 更新当前行列位置
        this.currentLine = targetLine;
        this.currentColumn = targetColumn;
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
                    this.moveToPosition(this.currentLine - 1, targetColumn);
                }
                break;

            case 'down':
                if (this.currentLine < this.lineStartIndexes.length - 1) {
                    // 移动到下一行的相同列位置（不超过下一行的长度）
                    const nextLineLength = this.getLineLength(this.currentLine + 1);
                    const targetColumn = Math.min(this.currentColumn, nextLineLength);
                    this.currentColumn = targetColumn;
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
        this.writeEmitter.fire('\x1b[1E\x1b[2K');
        this.currentLine++;
        this.redrawFromLine(deleteLine);
        this.writeEmitter.fire('\x1b[1E\x1b[2K');
        this.writeEmitter.fire(`\x1b[1A`);
        this.writeEmitter.fire(`\r`);
        this.writeEmitter.fire(`\x1b[2C`);
        this.writeEmitter.fire(`\x1b[${this.lineLengths[this.currentLine]}C`);
        this.currentColumn = this.lineLengths[savedLine];
        this.moveToPosition(savedLine, savedColumn);
    }

    // 清除当前行并返回上一行行尾
    private clearCurrentLineAndReturn(): void {
        if (!this.isMultiLine) return;
        if (this.currentLine < 1 || this.currentLine >= this.lineStartIndexes.length) return;
        let deleteLine = this.currentLine;
        this.lineLengths.splice(deleteLine, 1);
        this.lineStartIndexes.splice(deleteLine, 1);
        this.redrawFromLine(deleteLine);
        this.writeEmitter.fire('\x1b[1E\x1b[2K');
        this.writeEmitter.fire(`\x1b[1A`);
        this.writeEmitter.fire(`\r`);
        this.writeEmitter.fire(`\x1b[2C`);
        this.writeEmitter.fire(`\x1b[${this.lineLengths[this.currentLine]}C`);
        this.currentColumn = this.lineLengths[deleteLine - 1];
        this.moveToPosition(deleteLine - 1, this.currentColumn);
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

        // 调整后续所有行的起始索引（因为插入了一个换行符）
        // for (let i = newLineIndex + 1; i < this.lineStartIndexes.length; i++) {
        //     this.lineStartIndexes[i] += 1;
        // }

        // 更新光标位置到新插入的空行
        this.currentLine = newLineIndex;
        this.currentColumn = 0;

        this.writeEmitter.fire('\n');
        // 重绘从当前行开始的所有行
        this.redrawFromLine(newLineIndex);

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

        // 插入新行
        const newLineIndex = this.currentLine + 1;
        this.lineStartIndexes.splice(newLineIndex, 0, splitPosition);
        this.lineLengths.splice(newLineIndex, 0, movedContent.length);

        this.renderRemainingLine();
        // 调整后续行索引（因为插入了一个换行符）
        // for (let i = newLineIndex + 1; i < this.lineStartIndexes.length; i++) {
        //     this.lineStartIndexes[i] += 1;
        // }

        // 更新光标位置到新行的行尾
        this.currentLine = newLineIndex;
        this.currentColumn = 0;

        this.writeEmitter.fire('\n');
        // 重绘受影响的行
        this.redrawFromLine(newLineIndex); // 从下一行开始重绘

        // 移动光标到正确位置
        this.moveToPosition(newLineIndex, movedContent.length);
    }

    private async handleMultiLinePaste(lines: string[]): Promise<void> {
        if (lines.length === 0) return;

        let startLine = this.currentLine;

        // 缓存下一行至最后一行的内容
        //let afterLines: string[] = [];
        for (let i = startLine + 1; i < this.lineStartIndexes.length; i++) {
            // afterLines.push(this.multiLineBuffer.slice(this.lineStartIndexes[i]));
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
            }
        }
    }
    // 在当前光标位置插入文本
    private insertTextAtCursor(text: string): void {
        // 判断是否开启了多行模式
        if (this.isMultiLine) {
            const currentPos = this.lineStartIndexes[this.currentLine] + this.currentColumn;
            this.multiLineBuffer = this.multiLineBuffer.slice(0, currentPos) +
                text +
                this.multiLineBuffer.slice(currentPos);

            // 更新当前行长度
            this.lineLengths[this.currentLine] += text.length;
            this.currentColumn += text.length;

            // 更新后续行的起始索引
            for (let i = this.currentLine + 1; i < this.lineStartIndexes.length; i++) {
                this.lineStartIndexes[i] += text.length;
            }
            this.writeEmitter.fire(text);
            // 重绘当前行
            this.renderRemainingLine();
        } else {
            this.cmd = this.cmd.slice(0, this.cursorPosition) + text + this.cmd.slice(this.cursorPosition);
            // 更新当前行的长度
            this.lineLengths[this.currentLine] += text.length;
            this.cursorPosition += text.length;
            this.currentColumn += text.length;

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
            // 如果不是最后一行，换行
            if (i < this.lineLengths.length - 1) {
                this.writeEmitter.fire('\r\n');
                this.currentLine++;
            }
        }
    }

}
