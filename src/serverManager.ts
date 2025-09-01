import * as vscode from 'vscode';
import { readSSHConfig, writeSSHConfig } from './sshConfigHandler';
import { promptForServerDetails, showServerList } from './uiHelper';
import { TerminalProvider } from './terminalProvider';
import { FileExplorerManager } from './fileExplorerManager';

export class ServerManager {
    private fileExplorerManager: FileExplorerManager;
    private terminals: Map<string, vscode.Terminal> = new Map();

    constructor(fileExplorerManager: FileExplorerManager) {
        this.fileExplorerManager = fileExplorerManager;
    }

    public async connectServer() {
        try {
            // 读取 SSH 配置文件
            const sshConfig = await readSSHConfig();

            // 弹出服务器列表供用户选择或新增
            const selectedServer = await showServerList(sshConfig);
            if (!selectedServer) return;

            // 处理用户输入
            const serverDetails = selectedServer.isNew
                ? await promptForServerDetails()
                : selectedServer;

            // 更新 SSH 配置文件
            if (selectedServer.isNew) {
                await writeSSHConfig(serverDetails);
            }

            // 连接服务器并打开终端和文件资源管理器
            await this.connectAndOpenResources(serverDetails);
        } catch (error) {
            vscode.window.showErrorMessage(`连接服务器失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    //修改 用户的.ssh/config 文件
    public async editServer() {
        try {
            const sshConfig = await readSSHConfig();
            const selectedServer = await showServerList(sshConfig);
            if (!selectedServer || selectedServer.isNew) return;
            const updatedDetails = await promptForServerDetails();
            if (!updatedDetails) return;
            await writeSSHConfig(updatedDetails);
            vscode.window.showInformationMessage(`服务器 ${selectedServer.name} 已更新`);
        } catch (error) {
            vscode.window.showErrorMessage(`编辑服务器失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public async connectAndOpenResources(serverDetails: any) {
        const { name, host, port, username, privateKeyPath } = serverDetails;
        const connectionString = `${username}@${host}:${port}`;

        try {
            // 创建自定义终端
            const terminal = vscode.window.createTerminal({
                name: `SSH: ${name}`,
                pty: new TerminalProvider(connectionString, privateKeyPath, name)
            });
            terminal.show();
            this.terminals.set(connectionString, terminal);
            // 检查服务器是否已存在
            const treeView = this.fileExplorerManager.getTreeDataProvider().getServer(connectionString);
            if (!treeView) {
                await this.fileExplorerManager.openFileExplorer(connectionString, privateKeyPath);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`SSH连接失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public async disconnectServer() {
        // 将 terminals 的键转换为 QuickPickItem 数组
        const serverOptions = Array.from(this.terminals.keys()).map(label => ({
            label,
            description: `SSH 终端: ${label}`
        }));

        // 弹出已连接的选择框
        const selectedServer = await vscode.window.showQuickPick(serverOptions, {
            placeHolder: '选择要断开的服务器'
        });
        if (!selectedServer) return;

        // 获取用户选择的服务器 ID
        const selectedServerId = selectedServer.label;

        // 断开服务器
        this.fileExplorerManager.disconnectServer(selectedServerId);

        // 关闭终端
        const terminal = this.terminals.get(selectedServerId);
        if (terminal) {
            terminal.sendText('exit'); // 发送退出命令
            terminal.dispose(); // 关闭终端
        }
        this.terminals.delete(selectedServerId);
    }

    public disconnectAllTerminals(): void {
        this.fileExplorerManager.disconnectServer('');
        this.terminals.forEach(terminal => {
            terminal.sendText('exit'); // 发送退出命令
            terminal.dispose(); // 关闭终端
        });
        this.terminals.clear(); // 清空缓存 // 清空文件资源管理器中的服务器列表
    }



}
