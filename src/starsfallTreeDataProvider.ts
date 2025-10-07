import * as vscode from 'vscode';
import { Client } from 'ssh2';
import { readFileSync } from 'fs';

// 1. 创建TreeNode类，扩展vscode.TreeItem以支持路径和子节点管理
export class TreeNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly path: string, // 节点的路径信息
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public children?: TreeNode[] // 子节点（改为可写）
    ) {
        super(label, collapsibleState);
        this.path = path;
        this.children = children || [];
    }
}

// 2. 创建StarsfallTreeDataProvider类，实现vscode.TreeDataProvider接口
export class StarsfallTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private servers: Map<string, string | undefined> = new Map();
    private logChannel: vscode.OutputChannel;
    private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined> = new vscode.EventEmitter<TreeNode | undefined>();
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this._onDidChangeTreeData.event;
    
    // 用于存储已渲染的节点，以支持路径查找
    private renderedNodes: Map<string, TreeNode> = new Map();
    
    // 根节点映射
    private rootNodes: Map<string, TreeNode> = new Map();

    constructor() {
        this.logChannel = vscode.window.createOutputChannel('Starsfall Servers Debug');
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.contextValue === 'file') {
            element.command = {
                command: 'starsfall.openFile',
                title: 'Open File',
                arguments: [element]
            };
            this.logChannel.appendLine(`[DEBUG] 设置文件节点命令: ${element.label}`);
        }
        
        // 存储已渲染的节点，使用路径作为键
        if (element.resourceUri) {
            const nodeKey = element.resourceUri.toString();
            this.renderedNodes.set(nodeKey, element);
        }
        
        return element;
    }

    getParent(element: TreeNode): vscode.ProviderResult<TreeNode> {
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
            const parentItem = new TreeNode(
                pathParts[pathParts.length - 2],
                parentPath,
                vscode.TreeItemCollapsibleState.Collapsed
            );
            parentItem.resourceUri = parentUri;
            parentItem.contextValue = 'directory';
            return parentItem;
        }

        return null;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // 根节点：显示所有服务器
            return Array.from(this.servers.entries()).map(([connectionString, privateKeyPath]) => {
                const serverItem = new TreeNode(connectionString, '/', vscode.TreeItemCollapsibleState.Collapsed);
                serverItem.iconPath = new vscode.ThemeIcon('remote');
                serverItem.contextValue = 'server';
                serverItem.resourceUri = vscode.Uri.parse(`ssh://${connectionString}`);
                
                // 保存根节点
                this.rootNodes.set(connectionString, serverItem);
                this.renderedNodes.set(`ssh://${connectionString}`, serverItem);
                
                return serverItem;
            });
        } else if (element.contextValue === 'server') {
            // 服务器节点：加载第一层目录
            const connectionString = element.label;
            const privateKeyPath = this.servers.get(connectionString);
            const files = await this.listRemoteFiles(connectionString, privateKeyPath, '/');
            
            // 按文件夹优先、名称升序排序
            const sortedFiles = files.sort((a, b) => {
                const isDirA = a.longname.startsWith('d');
                const isDirB = b.longname.startsWith('d');
                if (isDirA && !isDirB) return -1; // 文件夹在前
                if (!isDirA && isDirB) return 1;
                return a.filename.localeCompare(b.filename); // 名称升序
            });
            
            const children = sortedFiles.map(file => {
                const isDirectory = file.longname.startsWith('d');
                const item = new TreeNode(
                    file.filename,
                    `/${file.filename}`,
                    isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.contextValue = isDirectory ? 'directory' : 'file';
                item.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
                item.resourceUri = vscode.Uri.parse(`ssh://${element.label}/${file.filename}`);
                
                // 设置父节点关系
                element.children?.push(item);
                
                return item;
            });
            
            return children;
        } else if (element.contextValue === 'directory') {
            // 目录节点：动态加载子目录
            const resourceUri = element.resourceUri;
            if (!resourceUri) {
                throw new Error('Resource URI is undefined');
            }
            const { authority, path } = resourceUri;
            const connectionString = authority;
            const privateKeyPath = this.servers.get(connectionString);
            const fullPath = path.startsWith('/') ? path : `/${path}`;
            
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
            
            const children = sortedFiles.map(file => {
                const isDirectory = file.longname.startsWith('d');
                const item = new TreeNode(
                    file.filename,
                    `${fullPath}/${file.filename}`,
                    isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.contextValue = isDirectory ? 'directory' : 'file';
                item.iconPath = isDirectory ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
                item.resourceUri = vscode.Uri.parse(`ssh://${authority}${fullPath}/${file.filename}`);
                
                // 设置父节点关系
                element.children?.push(item);
                
                return item;
            });
            
            return children;
        }
        return [];
    }

    // 按路径查找已渲染的节点 - 新增功能
    public findNodeByPath(connectionString: string, path: string): TreeNode | undefined {
        const normalizedPath = path.startsWith('/') ? path : `/${path}`;
        const nodeUri = vscode.Uri.parse(`ssh://${connectionString}${normalizedPath}`).toString();
        
        // 首先尝试从缓存中直接查找
        const cachedNode = this.renderedNodes.get(nodeUri);
        if (cachedNode) {
            return cachedNode;
        }
        
        // 如果缓存中没有，尝试从根节点递归查找
        const rootNode = this.rootNodes.get(connectionString);
        if (rootNode) {
            return this.findNodeRecursive(rootNode, normalizedPath);
        }
        
        return undefined;
    }
    
    // 递归查找节点
    private findNodeRecursive(currentNode: TreeNode, targetPath: string): TreeNode | undefined {
        if (currentNode.path === targetPath) {
            return currentNode;
        }
        
        // 检查子节点
        for (const child of currentNode.children || []) {
            if (child.path === targetPath) {
                return child;
            }
            
            if (child.children && child.children.length > 0) {
                const found = this.findNodeRecursive(child, targetPath);
                if (found) {
                    return found;
                }
            }
        }
        
        return undefined;
    }

    public getServer(connectionString: string): TreeNode | undefined {
        if (this.servers.has(connectionString)) {
            const serverItem = new TreeNode(connectionString, '/', vscode.TreeItemCollapsibleState.Collapsed);
            serverItem.iconPath = new vscode.ThemeIcon('remote');
            serverItem.contextValue = 'server';
            serverItem.resourceUri = vscode.Uri.parse(`ssh://${connectionString}`);
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
        
        // 清理相关节点缓存
        this.rootNodes.delete(connectionString);
        // 清理所有该服务器的渲染节点
        Array.from(this.renderedNodes.keys()).forEach(key => {
            if (key.startsWith(`ssh://${connectionString}`)) {
                this.renderedNodes.delete(key);
            }
        });
        
        // 强制触发全局刷新
        this._onDidChangeTreeData.fire(undefined);
    }

    public clearAllServers(): void {
        this.servers.clear();
        this.rootNodes.clear();
        this.renderedNodes.clear();
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
            readyTimeout: 200000
        }
    }
    
    public getPrivateKeyPath(connectionString: string): string | undefined {
        return this.servers.get(connectionString);
    }

    private getParentPath(element: TreeNode): string {
        const parentPath = element.resourceUri?.path as string;
        if (!parentPath) {
            throw new Error('Parent path is undefined');
        }
        return parentPath;
    }

    private getConnectionString(element: TreeNode): string {
        return element.resourceUri?.authority as string;
    }

    public async openFile(element: TreeNode): Promise<void> {
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
        // 解析 connectionString
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

        this.logChannel.appendLine(`[DEBUG] 开始连接服务器: ${connectionString}`);
        this.logChannel.appendLine(`[DEBUG] 解析结果: username=${username}, host=${host}, port=${port}, path=${parentPath || '.'}`);

        // 实现 SSH 连接并列出文件
        const conn = new Client();

        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                this.logChannel.appendLine(`[DEBUG] SSH 连接成功: ${host}:${port}`);
                const fullRemotePath = parentPath || '.';
                conn.sftp((err, sftp) => {
                    if (err) {
                        this.logChannel.appendLine(`[ERROR] SFTP 连接失败: ${err.message}`);
                        reject(err);
                        return;
                    }

                    sftp.readdir(fullRemotePath, (err, files) => {
                        if (err) {
                            this.logChannel.appendLine(`[ERROR] 读取目录失败: ${fullRemotePath}, ${err.message}`);
                            if (err.message.includes('Permission denied')) {
                                this.logChannel.appendLine(`[WARN] 权限不足，请确保 SSH 用户有访问 ${fullRemotePath} 的权限`);
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
    
    // 刷新指定节点
    public refreshItem(item?: TreeNode): void {
        // 清除该节点及其子节点的缓存
        if (item) {
            if (item.resourceUri) {
                this.renderedNodes.delete(item.resourceUri.toString());
            }
            // 递归清除子节点缓存
            this.clearNodeCache(item);
        }
        
        // 触发数据变化事件
        this._onDidChangeTreeData.fire(item);
    }
    
    // 递归清除节点缓存
    private clearNodeCache(node: TreeNode): void {
        for (const child of node.children || []) {
            if (child.resourceUri) {
                this.renderedNodes.delete(child.resourceUri.toString());
            }
            this.clearNodeCache(child);
        }
        // 清空子节点列表
        node.children = [];
    }
}