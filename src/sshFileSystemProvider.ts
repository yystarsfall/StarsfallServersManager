import * as vscode from 'vscode';
import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { ServerTreeDataProvider } from './serversTreeDataProvider';

export class SshFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private _bufferedEvents: vscode.FileChangeEvent[] = [];
    private _fireSoonHandle?: NodeJS.Timer;
    private logChannel: vscode.OutputChannel;

    readonly onDidChangeFile = this._emitter.event;

    private _watchers = new Map<string, NodeJS.Timer>();
    private treeDataProvider: ServerTreeDataProvider;

    constructor(treeDataProvider: ServerTreeDataProvider) {
        this.treeDataProvider = treeDataProvider;
        this.logChannel = vscode.window.createOutputChannel('SSH FS');
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        const { connectionString, filePath } = this.parseUri(uri);
        const watcherKey = `${connectionString}:${filePath}`;

        // 如果已经存在监视器，先清除
        if (this._watchers.has(watcherKey)) {
            clearInterval(this._watchers.get(watcherKey));
            this._watchers.delete(watcherKey);
        }

        // 初始化文件状态
        let lastStats: vscode.FileStat | null = null;

        // 创建轮询定时器
        const intervalId = setInterval(async () => {
            try {
                const currentStats = await this.stat(uri);

                if (lastStats) {
                    // 检查文件是否变化
                    if (currentStats.mtime !== lastStats.mtime || currentStats.size !== lastStats.size) {
                        this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
                    }
                }
                lastStats = currentStats;
            } catch (err) {
                console.error(`Failed to poll file stats: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
        }, 5000); // 每5秒检查一次

        this._watchers.set(watcherKey, intervalId);

        return new vscode.Disposable(() => {
            clearInterval(intervalId);
            this._watchers.delete(watcherKey);
        });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const { connectionString, filePath } = this.parseUri(uri);
        const conn = new Client();

        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) return reject(err);

                    sftp.stat(filePath, (err, stats) => {
                        conn.end();
                        if (err) return reject(err);

                        resolve({
                            type: stats.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
                            ctime: stats.atime,
                            mtime: stats.mtime,
                            size: stats.size
                        });
                    });
                });
            }).connect(this.getSshConfig(connectionString));
        });
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const { connectionString, filePath } = this.parseUri(uri);
        const files = await this.listRemoteFiles(connectionString, filePath);
        return files.map(file => [
            file.filename,
            file.longname.startsWith('d') ? vscode.FileType.Directory : vscode.FileType.File
        ]);
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const { connectionString, filePath } = this.parseUri(uri);
        const privateKeyPath = this.getPrivateKeyPath(connectionString);
        const content = await this.readRemoteFile(connectionString, filePath, privateKeyPath);
        return Buffer.from(content);
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const { connectionString, filePath } = this.parseUri(uri);
        await this.writeRemoteFile(connectionString, filePath, Buffer.from(content));
        this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const { connectionString, filePath } = this.parseUri(uri);
        const conn = new Client();

        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) return reject(err);
                    sftp.mkdir(filePath, err => {
                        conn.end();
                        err ? reject(err || new Error('Unknown error')) : resolve(undefined);
                    });
                });
            }).connect(this.getSshConfig(connectionString));
        });
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const { connectionString, filePath } = this.parseUri(uri);
        const conn = new Client();

        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) return reject(err);

                    const deleteFn = options.recursive ?
                        (path: string, cb: (err?: Error) => void) => this.deleteRecursive(sftp, path, cb) :
                        (path: string, cb: (err?: Error | null) => void) => sftp.unlink(path, cb);

                    deleteFn(filePath, err => {
                        conn.end();
                        err ? reject(err || new Error('Unknown error')) : resolve(undefined);
                    });
                });
            }).connect(this.getSshConfig(connectionString));
        });
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const { connectionString: oldConn, filePath: oldPath } = this.parseUri(oldUri);
        const { connectionString: newConn, filePath: newPath } = this.parseUri(newUri);

        if (oldConn !== newConn) {
            throw new Error('Cannot rename across different SSH connections');
        }

        const conn = new Client();
        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) return reject(err);
                    sftp.rename(oldPath, newPath, err => {
                        conn.end();
                        err ? reject(err || new Error('Unknown error')) : resolve(undefined);
                    });
                });
            }).connect(this.getSshConfig(oldConn));
        });
    }

    private deleteRecursive(sftp: any, path: string, callback: (err?: Error) => void): void {
        sftp.readdir(path, (err: Error, files: any[]) => {
            if (err) return callback(err);

            if (files.length === 0) {
                return sftp.rmdir(path, callback);
            }

            let pending = files.length;
            files.forEach(file => {
                const fullPath = `${path}/${file.filename}`;
                if (file.longname.startsWith('d')) {
                    this.deleteRecursive(sftp, fullPath, (err) => {
                        if (err) return callback(err);
                        if (--pending === 0) {
                            sftp.rmdir(path, callback);
                        }
                    });
                } else {
                    sftp.unlink(fullPath, (err: Error) => {
                        if (err) return callback(err);
                        if (--pending === 0) {
                            sftp.rmdir(path, callback);
                        }
                    });
                }
            });
        });
    }

    private _fireSoon(event: vscode.FileChangeEvent): void {
        this._bufferedEvents.push(event);
        if (this._fireSoonHandle) clearTimeout(this._fireSoonHandle);
        this._fireSoonHandle = setTimeout(() => {
            this._emitter.fire(this._bufferedEvents);
            this._bufferedEvents = [];
        }, 5);
    }

    private parseUri(uri: vscode.Uri): { connectionString: string; filePath: string } {
        return {
            connectionString: uri.authority,
            filePath: uri.path
        };
    }

    private getSshConfig(connectionString: string): any {
        const [username, hostPort] = connectionString.split('@');
        const [host, port] = hostPort.split(':');
        const privateKeyPath = this.getPrivateKeyPath(connectionString);
        return {
            host,
            port: port ? parseInt(port) : 22,
            username,
            privateKey: privateKeyPath ? readFileSync(privateKeyPath) : undefined,
            //passphrase: '你的密钥密码（如果有）',
            readyTimeout: 200000,
            //tryKeyboard: true
        };
    }

    private getPrivateKeyPath(connectionString: string): string | undefined {
        return this.treeDataProvider.getPrivateKeyPath(connectionString);
    }

    private async readRemoteFile(connectionString: string, filePath: string, privateKeyPath?: string): Promise<string> {
        // const [username, hostPort] = connectionString.split('@');
        // const [host, portStr] = hostPort.split(':');
        // const port = portStr ? parseInt(portStr) : 22;
        const conn = new Client();
        return new Promise((resolve, reject) => {
            // 统一处理连接关闭
            const cleanup = () => {
                if (conn) {
                    conn.end();
                    conn.removeAllListeners();
                }
            };
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) {
                        this.logChannel.appendLine(`[ERROR] SFTP 连接失败: ${err.message}`);
                        cleanup();
                        return reject(err);
                    }

                    sftp.readFile(filePath, (err, data) => {
                        cleanup(); // 确保连接关闭
                        if (err) {
                            this.logChannel.appendLine(`[ERROR] 读取文件失败: ${filePath}, ${err.message}`);
                            reject(err);
                        } else {
                            this.logChannel.appendLine(`[INFO] 读取文件成功: ${filePath}, 大小: ${data.length} bytes`);
                            // 仅对文本文件调用 toString()
                            resolve(
                                this.isTextFile(data) ? data.toString() : data.toString('binary')
                            );
                        }
                    });
                });
            }).on('error', (err) => {
                this.logChannel.appendLine(`[ERROR] SSH 连接失败详情: ${JSON.stringify({
                    host: this.getSshConfig(connectionString).host,
                    error: err.message,
                    stack: err.stack // 打印调用栈
                })}`);
                cleanup();
                reject(err);
            }).connect(this.getSshConfig(connectionString));
        });
    }


    // 辅助方法：检测是否为文本文件
    private isTextFile(buffer: Buffer): boolean {
        const binaryThreshold = 0.3;
        let nonTextChars = 0;
        for (let i = 0; i < Math.min(buffer.length, 4096); i++) {
            if (buffer[i] === 0 || buffer[i] > 127) nonTextChars++;
        }
        return nonTextChars / Math.min(buffer.length, 4096) < binaryThreshold;
    }
    private async writeRemoteFile(connectionString: string, filePath: string, content: Buffer): Promise<void> {
        const conn = new Client();
        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) return reject(err);
                    sftp.writeFile(filePath, content, err => {
                        conn.end();
                        err ? reject(err || new Error('Unknown error')) : resolve(undefined);
                    });
                });
            }).on('error', (err) => {
                this.logChannel.appendLine(`[ERROR] SSH 连接失败: ${err.message}`);
                reject(err);
            }).connect(this.getSshConfig(connectionString));
        });
    }

    private async listRemoteFiles(connectionString: string, path: string): Promise<Array<{ filename: string; longname: string }>> {
        const conn = new Client();
        return new Promise((resolve, reject) => {
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err) return reject(err);
                    sftp.readdir(path, (err, files) => {
                        conn.end();
                        err ? reject(err) : resolve(files);
                    });
                });
            }).on('error', (err) => {
                this.logChannel.appendLine(`[ERROR] SSH 连接失败: ${err.message}`);
                reject(err);
            }).connect(this.getSshConfig(connectionString));
        });
    }
}