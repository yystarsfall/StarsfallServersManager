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

    // 实现 Pseudoterminal 接口
    onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    onDidClose: vscode.Event<void> = this.closeEmitter.event;

    constructor(
        private connectionString: string,
        private privateKeyPath?: string,
        hostname?: string // 新增参数
    ) {
        this.hostname = hostname || this.getHost(); // 如果未提供，则从 connectionString 中提取
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

    private isMultiLine = false;
    private multiLineBuffer = '';
    //private lastCmd = '';
    //private dataBuffer = '';
    private cursorPosition = 0;

    private processCommand(fullCommand: string): void {
        const lines = fullCommand.split('\n');
        const baseCommand = lines[0].trim();
        const args = lines.slice(1).filter(line => line.trim() !== '');

        if (baseCommand.startsWith('rz')) {
            this.handleFileUpload(args);
        } else if (baseCommand.startsWith('sz')) {
            this.handleFileDownload(args);
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
        // 输出剩余字符
        if (this.cursorPosition < this.cmd.length) {
            this.writeEmitter.fire(this.cmd.slice(this.cursorPosition));
        }
        // 将光标移回原始位置
        if (this.cursorPosition < this.cmd.length) {
            this.writeEmitter.fire(`\x1b[${this.cmd.length - this.cursorPosition}D`);
        }
    }

    async handleInput(data: string): Promise<void> {
        const hexValue = Array.from(data).map(c => c.charCodeAt(0).toString(16)).join(', ');
        console.log(`Received input (hex): ${hexValue}`);

        // 检测上下键（ANSI 转义序列）
        if (data.startsWith('\x1b')) {
            if (data === '\x1b[A' || data === '\x1bOA') { // 上键
                const prevCmd = this.getPrevCommandFromHistory();
                if (prevCmd !== undefined) {
                    const clearLength = Math.max(this.cmd.length, 20);
                    this.writeEmitter.fire('\r' + ' '.repeat(clearLength) + '\r');
                    this.cmd = prevCmd;
                    this.cursorPosition = this.cmd.length;
                    this.writeEmitter.fire('\x1b[34m└─\x1b[31m#\x1b[0m ' + prevCmd);
                }
                return;
            } else if (data === '\x1b[B' || data === '\x1bOB') { // 下键
                const nextCmd = this.getNextCommandFromHistory();
                if (nextCmd !== undefined) {
                    const clearLength = Math.max(this.cmd.length, 20);
                    this.writeEmitter.fire('\r' + ' '.repeat(clearLength) + '\r');
                    this.cmd = nextCmd;
                    this.cursorPosition = this.cmd.length;
                    this.writeEmitter.fire('\x1b[34m└─\x1b[31m#\x1b[0m ' + nextCmd);
                }
                return;
            } else if (data === '\x1b[D' || data === '\x1bOD') { // 向左键
                if (this.cursorPosition > 0) {
                    this.cursorPosition--;
                    this.writeEmitter.fire('\x1b[D');
                }
                return;
            } else if (data === '\x1b[C' || data === '\x1bOC') { // 向右键
                if (this.cursorPosition < this.cmd.length) {
                    this.cursorPosition++;
                    this.writeEmitter.fire('\x1b[C');
                }
                return;
            } else if (data === '\x1b[3~') { // Del 键
                if (this.cmd.length > 0 && this.cursorPosition < this.cmd.length) {
                    this.cmd = this.cmd.slice(0, this.cursorPosition) + this.cmd.slice(this.cursorPosition + 1);
                    this.writeEmitter.fire('\x1b[P');
                    this.renderRemainingLine(); // 重新渲染剩余内容
                }
                return;
            }
        }

        // 处理 Ctrl + L（清屏）
        if (data.charCodeAt(0) === 12) { // \x0C
            this.writeEmitter.fire('\x1b[2J\x1b[0;0H');
            this.updatePrompt();
            return;
        }

        // 处理 Tab 补全
        if (data.charCodeAt(0) === 9) { // \t
            const lastSpaceIndex = this.cmd.lastIndexOf(' ');
            const prefix = lastSpaceIndex >= 0 ? this.cmd.substring(0, lastSpaceIndex + 1) : '';
            const lastWord = lastSpaceIndex >= 0 ? this.cmd.substring(lastSpaceIndex + 1) : this.cmd;

            const suggestions = await this.getTabSuggestions(lastWord);
            if (suggestions.length === 1) {
                this.cmd = prefix + suggestions[0];
                this.cursorPosition = this.cmd.length;
                this.writeEmitter.fire('\r' + ' '.repeat(this.cmd.length) + '\r');
                this.writeEmitter.fire('\x1b[34m└─\x1b[31m#\x1b[0m ' + this.cmd);
            } else if (suggestions.length > 1) {
                this.writeEmitter.fire('\r\n' + suggestions.join('    ') + '\r\n');
                this.updatePrompt();
            }
            return;
        }

        // 处理退格键
        if (data.charCodeAt(0) === 8 || hexValue === '7f') {
            if (this.isMultiLine) {
                if (this.multiLineBuffer.length > 0) {
                    this.multiLineBuffer = this.multiLineBuffer.slice(0, -1);
                    this.writeEmitter.fire('\b \b');
                }
            } else if (this.cmd.length > 0 && this.cursorPosition > 0) {
                this.cmd = this.cmd.slice(0, this.cursorPosition - 1) + this.cmd.slice(this.cursorPosition);
                this.cursorPosition--;
                this.writeEmitter.fire('\b \b');
                this.renderRemainingLine(); // 重新渲染剩余内容
            }
            return;
        }

        // 实时回显输入字符（过滤控制字符）
        let filteredData = data.replace(/[\x00-\x1F]/g, '');
        if (filteredData.startsWith('[200~') && filteredData.endsWith('[201~')) {
            filteredData = filteredData.slice(5, -5);
        }

        // 插入字符到当前光标位置
        if (filteredData && !data.includes('\r') && !data.includes('\n')) {
            this.cmd = this.cmd.slice(0, this.cursorPosition) + filteredData + this.cmd.slice(this.cursorPosition);
            this.cursorPosition += filteredData.length;
            this.writeEmitter.fire(filteredData);
            this.renderRemainingLine(); // 重新渲染剩余内容
        }

        // 多行模式逻辑
        if (this.isMultiLine) {
            if (data.endsWith('\\')) {
                this.multiLineBuffer += filteredData.slice(0, -1);
            } else {
                this.multiLineBuffer += filteredData;
                if (data.includes('\r') || data.includes('\n')) {
                    this.processCommand(this.multiLineBuffer.trim());
                    this.isMultiLine = false;
                    this.multiLineBuffer = '';
                }
            }
            return;
        }

        // 检测续行符
        if (data.endsWith('\\')) {
            this.isMultiLine = true;
            this.multiLineBuffer = this.cmd + filteredData.slice(0, -1);
            this.cmd = '';
            return;
        }

        // 处理回车（支持 \r 和 \n）
        if (data.includes('\r') || data.includes('\n')) {
            const trimmedCmd = this.cmd.trim();
            this.addToHistory(trimmedCmd);
            const isRzCommand = /^rz(?: -e)?(?:\s+|$)/.test(trimmedCmd);
            const isSzCommand = /^sz(?: -e)?(?:\s+|$)/.test(trimmedCmd);

            if (isRzCommand) {
                const args = trimmedCmd.slice(2).trim().split(/\s+/).filter(arg => arg.length > 0);
                this.handleFileUpload(args);
            } else if (isSzCommand) {
                const args = trimmedCmd.slice(2).trim().split(/\s+/).filter(arg => arg.length > 0);
                this.handleFileDownload(args);
            } else {
                if (this.sshStream) {
                    this.sshStream.write(this.cmd + '\n');
                    this.writeEmitter.fire('\r\n');
                } else {
                    this.writeEmitter.fire('\r\nSSH connection is not established.\r\n');
                }
            }
            this.cmd = '';
            this.cursorPosition = 0;
        }
    }

    private connectSsh() {
        const [username, hostPort] = this.connectionString.split('@');
        const [host, portStr] = hostPort.split(':');
        const port = portStr ? parseInt(portStr) : 22;

        this.sshClient = new Client();
        this.sshClient
            .on('ready', () => {
                this.writeEmitter.fire(`\r\nConnection established.\r\n`);
                this.sshClient?.shell({ term: 'xterm' }, (err, stream) => {
                    if (err) {
                        this.writeEmitter.fire(`Error: ${err.message}\r\n`);
                        return;
                    }
                    this.sshStream = stream;
                    stream
                        .on('data', (data: Buffer) => {
                            const dataStr = data.toString();
                            this.writeEmitter.fire(dataStr);
                        })
                        .on('close', () => {
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
                            .on('finish', () => {
                                this.writeEmitter.fire(`File uploaded: ${remotePath}\r\n`);
                                this.updatePrompt(); // 完整命令提示符
                                resolve(true);
                            })
                            .on('end', () => {
                                this.writeEmitter.fire(`File uploaded: ${remotePath}\r\n`);
                                this.updatePrompt(); // 完整命令提示符
                                resolve(true);
                            })
                            .on('close', () => {
                                this.writeEmitter.fire(`File uploaded: ${remotePath}\r\n`);
                                this.updatePrompt(); // 完整命令提示符
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
                            .on('finish', () => {
                                this.writeEmitter.fire(`File downloaded: ${localPath}\r\n`);
                                this.updatePrompt(); // 完整命令提示符
                                resolve(true);
                            })
                            .on('end', () => {
                                this.writeEmitter.fire(`File downloaded: ${remotePath}\r\n`);
                                this.updatePrompt(); // 完整命令提示符
                                resolve(true);
                            })
                            .on('close', () => {
                                this.writeEmitter.fire(`File downloaded: ${remotePath}\r\n`);
                                this.updatePrompt(); // 完整命令提示符
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

    // 更新终端提示符中的调用
    private updatePrompt(): void {
        const username = this.getUsername();
        const hostname = this.getHostName();
        const userSymbol = this.isRootUser() ? "💀" : "@";
        this.writeEmitter.fire(`\r\n\x1b[34m┌──(\x1b[31m${username}${userSymbol}${hostname}\x1b[34m)-[\x1b[37m~\x1b[34m]\r\n\x1b[34m└─\x1b[31m#\x1b[0m `);
    }

    private async getTabSuggestions(input: string): Promise<string[]> {
        try {
            if (!this.sshClient) {
                console.log('SSH client is not connected');
                return [];
            }

            // 提取最后一个单词作为补全输入（如从 "ls -lh he" 中提取 "he"）
            const lastWord = input.split(/\s+/).pop() || '';

            // 通过 SFTP 读取远程目录
            const files: string[] = await new Promise((resolve, reject) => {
                this.sshClient?.sftp((err, sftp) => {
                    if (err) {
                        console.error('SFTP error:', err);
                        reject(err);
                        return;
                    }

                    sftp.readdir('.', (err, list) => {
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
}
