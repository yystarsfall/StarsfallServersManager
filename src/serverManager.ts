import * as vscode from 'vscode';
import { readSSHConfig, writeSSHConfig } from './sshConfigHandler';
import { promptForServerDetails, showServerList } from './uiHelper';
import { FileExplorerManager } from './fileExplorerManager';

export class ServerManager {
    private fileExplorerManager: FileExplorerManager;

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

    public async connectAndOpenResources(serverDetails: any) {
        const { name, host, port, username, password, privateKeyPath } = serverDetails;
        //const fileExplorerManager = new FileExplorerManager();
        const connectionString = `${username}@${host}:${port}`;

        try {
            const terminal = vscode.window.createTerminal({
                name: `SSH: ${name}`,
                shellPath: 'ssh',
                // 拆分参数为数组形式
                shellArgs: [
                    `${username}@${host}`,
                    `-p`, `${port}`,
                    privateKeyPath ? `-i` : ``,
                    privateKeyPath ? `${privateKeyPath}` : ``,
                    `-t`, `bash`
                ],
                cwd: require('os').homedir()
            });
            terminal.show();

            // 检查服务器是否已存在
            const treeView = this.fileExplorerManager.getTreeDataProvider().getServer(connectionString);
            if (!treeView) {
                // 如果服务器不存在，则追加到视图中
                const homeDir = username === 'root' ? '/root' : `/home/${username}`;
                //const fullConnectionString = `${connectionString}${homeDir}`;
                await this.fileExplorerManager.openFileExplorer(connectionString, privateKeyPath);
            }
        } catch (error) {
            const msg = `SSH连接失败: ${error instanceof Error ? error.message : String(error)}\n`
                + `请检查:\n`
                + `1. 私钥路径: ${privateKeyPath}\n`
                + `2. 服务器状态: ${host}:${port}\n`
                + `3. 网络连通性\n`
                + `4. 私钥权限和格式\n`
                + `5. 确保 VSCode 以管理员权限运行`;
            vscode.window.showErrorMessage(msg);
        }
    }

}
