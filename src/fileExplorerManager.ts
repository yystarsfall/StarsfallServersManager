import * as vscode from 'vscode';
import { StarsfallTreeDataProvider, TreeNode } from './starsfallTreeDataProvider';

export class FileExplorerManager {
    private static instance: FileExplorerManager;
    private treeDataProvider!: StarsfallTreeDataProvider;
    private treeView!: vscode.TreeView<TreeNode>;

    private constructor() {
        if (!FileExplorerManager.instance) {
            this.treeDataProvider = new StarsfallTreeDataProvider();
            this.treeView = vscode.window.createTreeView('serversList', {
                treeDataProvider: this.treeDataProvider
            });
            FileExplorerManager.instance = this;
        }
        return FileExplorerManager.instance;
    }

    public static getInstance(): FileExplorerManager {
        if (!FileExplorerManager.instance) {
            FileExplorerManager.instance = new FileExplorerManager();
        }
        return FileExplorerManager.instance;
    }

    public async openFileExplorer(serverId: string, privateKeyPath?: string): Promise<void> {
        try {
            // 添加服务器并强制刷新TreeView
            this.treeDataProvider.addServer(serverId, privateKeyPath);

            // 确保TreeView已刷新
            await new Promise(resolve => setTimeout(resolve, 100));

            // 获取服务器节点并尝试reveal
            const serverItem = this.treeDataProvider.getServer(serverId);
            if (serverItem) {
                await this.treeView.reveal(serverItem, {
                    focus: true,
                    select: true
                });
            }

            // 聚焦到Servers Explorer
            await vscode.commands.executeCommand('starsfall.focusServersExplorer');
        } catch (error) {
            vscode.window.showErrorMessage(`打开远程文件夹失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public disconnectServer(serverId: string): void {
        if (!serverId) {
            // 如果没有提供 serverId，则断开所有服务器连接
            this.treeDataProvider.clearAllServers();
            return;
        }
        // 移除指定服务器
        this.treeDataProvider.removeServer(serverId);
        // 强制刷新 TreeView
        this.treeView.title = this.treeView.title;
    }

    public getTreeDataProvider(): StarsfallTreeDataProvider {
        return this.treeDataProvider;
    }
}