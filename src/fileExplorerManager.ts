import * as vscode from 'vscode';
import { ServerTreeDataProvider } from './serversTreeDataProvider';

export class FileExplorerManager {
    private static instance: FileExplorerManager;
    private treeDataProvider!: ServerTreeDataProvider;
    private treeView!: vscode.TreeView<vscode.TreeItem>;
    
    private constructor() {
        if (!FileExplorerManager.instance) {
            this.treeDataProvider = new ServerTreeDataProvider();
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
        this.treeDataProvider.removeServer(serverId);
    }

    public getTreeDataProvider(): ServerTreeDataProvider {
        return this.treeDataProvider;
    }
}