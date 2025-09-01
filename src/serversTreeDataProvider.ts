import * as vscode from 'vscode';
import { Client } from 'ssh2';
import { readFileSync } from 'fs';

export class ServerTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private servers: Map<string, string | undefined> = new Map();
    private logChannel: vscode.OutputChannel;
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

    constructor() {
        this.logChannel = vscode.window.createOutputChannel('Starsfall Servers Debug');
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        if (element.contextValue === 'file') {
            element.command = {
                command: 'starsfall.openFile',
                title: 'Open File',
                arguments: [element]
            };
            this.logChannel.appendLine(`[DEBUG] 设置文件节点命令: ${element.label}`);
        }
        return element;
    }

    getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
        if (!element) return null;
        if (element.contextValue === 'server') return null;

        if (element.resourceUri) {
            const uri = element.resourceUri;
            const pathParts = uri.path.split('/').filter(p => p);

            if (pathParts.length === 1) {
                return this.getServer(uri.authority);
            }

            const parentPath = pathParts.slice(0, -1).join('/');
            const parentUri = vscode.Uri.parse(`ssh://${uri.authority}/${parentPath}`);
            const parentItem = new vscode.TreeItem(
                pathParts[pathParts.length - 2],
                vscode.TreeItemCollapsibleState.Collapsed
            );
            parentItem.resourceUri = parentUri;
            parentItem.contextValue = 'directory';
            return parentItem;
        }

        return null;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            // 根节点：显示所有服务器
            return Array.from(this.servers.entries()).map(([connectionString, privateKeyPath]) => {
                const serverItem = new vscode.TreeItem(connectionString, vscode.TreeItemCollapsibleState.Collapsed);
                serverItem.iconPath = new vscode.ThemeIcon('remote');
                serverItem.contextValue = 'server';
                return serverItem;
            });
        } else if (element.contextValue === 'server') {
            // 服务器节点：加载第一层目录
            const connectionString = element.label as string;
            const privateKeyPath = this.servers.get(connectionString);
            const files = await this.listRemoteFiles(connectionString, privateKeyPath, '/'); // 仅加载直接子项
            // 按文件夹优先、名称升序排序
            const sortedFiles = files.sort((a, b) => {
                const isDirA = a.longname.startsWith('d');
                const isDirB = b.longname.startsWith('d');
                if (isDirA && !isDirB) return -1; // 文件夹在前
                if (!isDirA && isDirB) return 1;
                return a.filename.localeCompare(b.filename); // 名称升序
            });
            return sortedFiles.map(file => {
                const isDirectory = file.longname.startsWith('d');
                const item = new vscode.TreeItem(
                    file.filename,
                    isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.contextValue = isDirectory ? 'directory' : 'file';
                item.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
                // 设置 resourceUri 为服务器路径 + 文件名
                if (element.contextValue === 'server') {
                    item.resourceUri = vscode.Uri.parse(`ssh://${element.label}/${file.filename}`);
                } else if (element.contextValue === 'directory') {
                    const parentUri = element.resourceUri;
                    if (!parentUri) {
                        throw new Error('Parent resource URI is undefined');
                    }
                    item.resourceUri = vscode.Uri.parse(`ssh://${parentUri.authority}${parentUri.path}/${file.filename}`);
                    this.logChannel.appendLine(`[DEBUG] 设置子文件夹 resourceUri: ${item.resourceUri.toString()}`);
                }
                return item;
            });
        } else if (element.contextValue === 'directory') {
            // 目录节点：动态加载子目录
            // 从 resourceUri 解析路径信息
            const resourceUri = element.resourceUri;
            if (!resourceUri) {
                throw new Error('Resource URI is undefined');
            }
            const { authority, path } = resourceUri;
            const [username, hostPort] = authority.split('@');
            const [host, port] = hostPort.split(':');
            const connectionString = `${username}@${host}${port ? `:${port}` : ''}`;
            const privateKeyPath = this.servers.get(connectionString);
            const fullPath = path.startsWith('/') ? path : `/${path}`; // 确保路径以 / 开头
            this.logChannel.appendLine(`[DEBUG] 正在加载目录: ${fullPath}`);
            const files = await this.listRemoteFiles(connectionString, privateKeyPath, fullPath);
            // 按文件夹优先、名称升序排序
            const sortedFiles = files.sort((a, b) => {
                const isDirA = a.longname.startsWith('d');
                const isDirB = b.longname.startsWith('d');
                if (isDirA && !isDirB) return -1; // 文件夹在前
                if (!isDirA && isDirB) return 1;
                return a.filename.localeCompare(b.filename); // 名称升序
            });
            return sortedFiles.map(file => {
                const isDirectory = file.longname.startsWith('d');
                const item = new vscode.TreeItem(
                    file.filename,
                    isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.contextValue = isDirectory ? 'directory' : 'file';
                item.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
                // 设置 resourceUri 为服务器路径 + 文件名
                if (element.contextValue === 'server') {
                    item.resourceUri = vscode.Uri.parse(`ssh://${element.label}/${file.filename}`);
                } else if (element.contextValue === 'directory') {
                    const parentUri = element.resourceUri;
                    if (!parentUri) {
                        throw new Error('Parent resource URI is undefined');
                    }
                    item.resourceUri = vscode.Uri.parse(`ssh://${parentUri.authority}${parentUri.path}/${file.filename}`);
                    this.logChannel.appendLine(`[DEBUG] 设置子文件夹 resourceUri: ${item.resourceUri.toString()}`);
                }
                return item;
            });
        }
        return [];
    }

    public getServer(connectionString: string): vscode.TreeItem | undefined {
        if (this.servers.has(connectionString)) {
            const serverItem = new vscode.TreeItem(connectionString, vscode.TreeItemCollapsibleState.Collapsed);
            serverItem.iconPath = new vscode.ThemeIcon('remote');
            serverItem.contextValue = 'server';
            return serverItem;
        }
        return undefined;
    }
    public addServer(connectionString: string, privateKeyPath?: string): void {
        this.servers.set(connectionString, privateKeyPath);
        this._onDidChangeTreeData.fire(undefined);
    }

    public removeServer(connectionString: string): void {
        // 从 Map 中移除服务器
        this.servers.delete(connectionString);
        
        // 强制触发全局刷新，确保节点被完全移除
        this._onDidChangeTreeData.fire(undefined);
    }

    public clearAllServers(): void {
        this.servers.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    public getSshConfig(connectionString: string): any {
        const [username, hostPort] = connectionString.split('@');
        const [host, port] = hostPort.split(':');
        return {
            host: host,
            port: port ? parseInt(port) : 22,
            username: username,
            privateKey: this.getPrivateKeyPath(connectionString),
            //passphrase: '你的密钥密码（如果有）',
            readyTimeout: 200000,
            //tryKeyboard: true
        }
    }
    public getPrivateKeyPath(connectionString: string): string | undefined {
        return this.servers.get(connectionString);
    }

    private getParentPath(element: vscode.TreeItem): string {
        const parentPath = element.resourceUri?.path as string;
        if (!parentPath) {
            throw new Error('Parent path is undefined');
        }
        return parentPath;
    }

    private getConnectionString(element: vscode.TreeItem): string {
        return element.resourceUri?.authority as string;
    }

    public async openFile(element: vscode.TreeItem): Promise<void> {
        const filePath = this.getParentPath(element);
        const connectionString = this.getConnectionString(element);
        const privateKeyPath = this.servers.get(connectionString);
        this.logChannel.appendLine(`[DEBUG] 尝试打开文件: ${filePath}`);
        // 常见可执行文件扩展名列表
        const executableExtensions = [
            '.exe', '.dll', '.bat', '.cmd', '.msi', // Windows
            '.jar', '.war', '.ear', // Java
            '.bin', '.run', '.app', // Linux/macOS
            '.so', '.dylib', // 动态库
            '.pyc', '.pyo', '.pyd' // Python
        ];

        const lowerCasePath = filePath.toLowerCase();

        // 检查是否为可执行文件
        if (executableExtensions.some(ext => lowerCasePath.endsWith(ext))) {
            vscode.window.showWarningMessage('无法在编辑器中打开可执行文件，但支持下载。');
            return;
        }

        // 检查文件是否为二进制类型
        const isBinary = await this.isBinaryFile(connectionString, privateKeyPath, filePath);
        if (isBinary) {
            vscode.window.showWarningMessage('无法在编辑器中打开二进制文件，但支持下载。');
            return;
        }

        try {
            const uri = vscode.Uri.parse(`ssh://${connectionString}${filePath}`);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        } catch (err) {
            if (err instanceof Error && err.message.includes('Permission denied')) {
                if (!privateKeyPath) {
                    vscode.window.showErrorMessage('打开文件失败: 需要私钥进行身份验证，但未提供私钥路径。请检查服务器配置。');
                } else {
                    vscode.window.showErrorMessage('打开文件失败: 私钥验证失败。请检查私钥路径是否正确。');
                }
            } else {
                vscode.window.showErrorMessage(`打开文件失败: ${err instanceof Error ? err.message : '未知错误'}`);
            }
        }
    }

    private async isBinaryFile(connectionString: string, privateKeyPath?: string, filePath?: string): Promise<boolean> {
        // 实现 SFTP 读取文件内容并检测是否为二进制
        const content = await this.readRemoteFile(connectionString, privateKeyPath, filePath);
        if (!content) return false;

        // 检测二进制文件的常见特征
        const binaryThreshold = 0.3; // 30% 的非文本字符
        let nonTextChars = 0;
        for (let i = 0; i < Math.min(content.length, 4096); i++) {
            if (content.charCodeAt(i) === 0 || content.charCodeAt(i) > 127) {
                nonTextChars++;
            }
        }
        return nonTextChars / Math.min(content.length, 4096) > binaryThreshold;
    }

    private async readRemoteFile(connectionString: string, privateKeyPath?: string, filePath?: string): Promise<string> {
        // 解析 connectionString
        const parts = connectionString.split(':');
        const [username, host] = parts[0].split('@');
        const port = parts.length >= 2 ? parseInt(parts[1]) : 22;

        const conn = new Client();

        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        this.logChannel.appendLine(`[ERROR] SFTP 连接失败: ${err.message}`);
                        reject(err);
                        return;
                    }
                    sftp.readFile(filePath || '.', (err, data) => {
                        if (err) {
                            this.logChannel.appendLine(`[ERROR] 读取文件失败: ${filePath}, ${err.message}`);
                            reject(err);
                            return;
                        }                        
                        resolve(data.toString());
                    });
                });
            }).on('error', (err) => {
                this.logChannel.appendLine(`[ERROR] SSH 连接失败: ${err.message}`);
                reject(err);
            }).connect({
                host,
                port,
                username,
                privateKey: privateKeyPath ? readFileSync(privateKeyPath) : undefined,
                readyTimeout: 20000
            });
        });
    }

    private getLanguageForFile(filePath: string): string {
        const extension = filePath.split('.').pop()?.toLowerCase();
        switch (extension) {
            case 'js': return 'javascript';
            case 'ts': return 'typescript';
            case 'json': return 'json';
            case 'html': return 'html';
            case 'css': return 'css';
            case 'md': return 'markdown';
            case 'py': return 'python';
            case 'java': return 'java';
            case 'xml': return 'xml';
            case 'sh': return 'shellscript';
            default: return 'plaintext';
        }
    }

    private async listRemoteFiles(
        connectionString: string,
        privateKeyPath?: string,
        parentPath?: string
    ): Promise<Array<{ filename: string; longname: string }>> {
        // 解析 connectionString（格式：username@host:port/path 或 username@host）
        const parts = connectionString.split(':');
        if (parts.length < 1) {
            throw new Error(`Invalid connection string: ${connectionString}. Expected format: username@host[:port][/path]`);
        }

        const [username, host] = parts[0].split('@');
        if (!username || !host) {
            throw new Error(`Invalid connection string: ${connectionString}. Missing username or host.`);
        }

        // 默认端口为 22
        const port = parts.length >= 2 ? parseInt(parts[1]) : 22;
        const path = parts.length >= 3 ? parts[2] : '.';

        // 如果路径是父级目录的子路径，确保路径正确拼接
        const remotePath = parentPath ? `${parentPath}/${path}` : path;

        this.logChannel.appendLine(`[DEBUG] 开始连接服务器: ${connectionString}`);
        this.logChannel.appendLine(`[DEBUG] 解析结果: username=${username}, host=${host}, port=${port}, path=${path}`);

        // 实现 SSH 连接并列出文件（需依赖私钥）
        const conn = new Client();

        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                this.logChannel.appendLine(`[DEBUG] SSH 连接成功: ${host}:${port}`);
                const remotePath = path || '.';
                // 如果路径是父级目录的子路径，确保路径正确拼接
                const fullRemotePath = parentPath ? `${parentPath}/${remotePath}` : remotePath;
                conn.sftp((err, sftp) => {
                    if (err) {
                        this.logChannel.appendLine(`[ERROR] SFTP 连接失败: ${err.message}`);
                        reject(err);
                        return;
                    }

                    sftp.readdir(fullRemotePath, (err, files) => {
                        if (err) {
                            this.logChannel.appendLine(`[ERROR] 读取目录失败: ${remotePath}, ${err.message}`);
                            if (err.message.includes('Permission denied')) {
                                this.logChannel.appendLine(`[WARN] 权限不足，请确保 SSH 用户有访问 ${remotePath} 的权限`);
                            }
                            reject(err);
                            return;
                        }

                        this.logChannel.appendLine(`[DEBUG] 解析后的文件列表: ${JSON.stringify(files)}`);
                        resolve(files);
                    });
                });
            }).on('error', (err) => {
                this.logChannel.appendLine(`[ERROR] SSH 连接失败: ${err.message}`);
                reject(err);
            }).connect({
                host,
                port,
                username,
                privateKey: privateKeyPath ? readFileSync(privateKeyPath) : undefined,
                readyTimeout: 20000
            });
        });
    }
}