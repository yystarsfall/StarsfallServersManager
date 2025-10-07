import * as vscode from 'vscode';
import { readSSHConfig, writeSSHConfig, ServerDetails } from './sshConfigHandler';
import { promptForServerDetails, showServerList } from './uiHelper';
import { TerminalProvider } from './terminalProvider';
import { FileExplorerManager } from './fileExplorerManager';
import { Client } from 'ssh2';
import * as fs from 'fs';

export class ServerManager {
  private terminals: Map<string, vscode.Terminal[]> = new Map();
  private serverDetailsMap: Map<string, ServerDetails> = new Map(); // 存储服务器详情

  constructor(private fileExplorerManager: FileExplorerManager) {
    // 使用参数属性语法，不需要额外的赋值语句
  }

  /**
   * 复制当前选中的终端
   * @returns 新创建的终端实例
   */
  public async duplicateCurrentTerminal(): Promise<vscode.Terminal | undefined> {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
      vscode.window.showErrorMessage('No active terminal found');
      return undefined;
    }

    // 查找当前终端对应的服务器连接信息
    let serverDetails: ServerDetails | undefined;
    let connectionString: string | undefined;

    // 遍历所有服务器的终端，找到匹配的终端
    for (const [connStr, terminals] of this.terminals.entries()) {
      if (terminals.some(terminal => terminal.name === activeTerminal.name)) {
        connectionString = connStr;
        serverDetails = this.serverDetailsMap.get(connStr);
        break;
      }
    }

    if (!serverDetails) {
      vscode.window.showErrorMessage('Cannot find server details for the current terminal');
      return undefined;
    }

    try {
      // 创建新终端
      const connectionString = `${serverDetails.username}@${serverDetails.host}:${serverDetails.port}`;
      const systemType = await this.detectSystemType(serverDetails);
      const newTerminal = vscode.window.createTerminal({
        name: `SSH: ${serverDetails.name}`,
        pty: new TerminalProvider(connectionString, serverDetails.privateKeyPath, serverDetails.name, systemType, this.fileExplorerManager)
      });

      // 将新终端添加到对应服务器的终端数组中
      if (connectionString) {
        if (!this.terminals.has(connectionString)) {
          this.terminals.set(connectionString, []);
        }
        this.terminals.get(connectionString)?.push(newTerminal);
      }

      newTerminal.show();
      return newTerminal;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to duplicate terminal: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
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

  public async connectAndOpenResources(serverDetails: ServerDetails) {
    const { name, host, port, username, privateKeyPath } = serverDetails;
    const connectionString = `${username}@${host}:${port}`;

    try {
      // 存储服务器详情
      this.serverDetailsMap.set(connectionString, serverDetails);

      // 1. 先检测系统类型
      const systemType = await this.detectSystemType({
        host, port, username, privateKeyPath
      });

      // 2. 创建终端
      const terminal = vscode.window.createTerminal({
        name: `SSH: ${name}`,
        pty: new TerminalProvider(connectionString, privateKeyPath, name, systemType, this.fileExplorerManager)
      });

      // 将终端添加到对应服务器的终端数组中
      if (!this.terminals.has(connectionString)) {
        this.terminals.set(connectionString, []);
      }
      this.terminals.get(connectionString)?.push(terminal);

      terminal.show();
      // 3. 先连接文件系统，检查服务器是否已存在
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
    const serverTerminals = this.terminals.get(selectedServerId);
    if (serverTerminals && serverTerminals.length > 0) {
      serverTerminals.forEach(terminal => {
        terminal.sendText('exit', true); // 发送退出命令
        setTimeout(() => {
          terminal.dispose(); // 关闭终端
        }, 100);
      });
      // 清空该服务器的所有终端
      this.terminals.delete(selectedServerId);
      this.serverDetailsMap.delete(selectedServerId);
    }
  }

  public disconnectAllTerminals(): void {
    this.fileExplorerManager.disconnectServer('');
    this.terminals.forEach((terminals, connectionString) => {
      terminals.forEach(terminal => {
        terminal.sendText('exit', true); // 发送退出命令
        terminal.dispose(); // 关闭终端
      });
    });
    this.terminals.clear(); // 清空缓存
    this.serverDetailsMap.clear(); // 清空服务器详情
  }

  /**
   * 处理终端关闭事件
   * @param terminal 关闭的终端实例
   */
  public handleTerminalClose(terminal: vscode.Terminal): void {
    // 遍历所有服务器的终端列表
    for (const [connectionString, terminals] of this.terminals.entries()) {
      const index = terminals.findIndex(t => t.name === terminal.name);
      if (index !== -1) {
        // 从数组中移除关闭的终端
        terminals.splice(index, 1);

        // 如果服务器没有终端了，清理对应的条目
        if (terminals.length === 0) {
          this.terminals.delete(connectionString);
          this.serverDetailsMap.delete(connectionString);
        }
        break;
      }
    }
  }

  public shutdownAllServers(): void {
    this.fileExplorerManager.disconnectServer('');
    this.terminals.forEach((serverTerminals, connectionString) => {
      serverTerminals.forEach(terminal => {
        terminal.sendText('sudo shutdown -h now', true); // 发送关机命令
        terminal.dispose(); // 关闭终端
      });
    });
    this.terminals.clear(); // 清空缓存 // 清空文件资源管理器中的服务器列表
  }

  // 独立的系统类型检测方法
  private async detectSystemType(server: { host: string; port: number; username: string; privateKeyPath?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      conn.on('ready', () => {
        conn.exec('cat /etc/os-release', (err, stream) => {
          if (err) {
            resolve('unknown');
            return;
          }

          let output = '';
          stream.on('data', (data: Buffer) => {
            output += data.toString();
          });

          stream.on('close', () => {
            conn.end();
            if (output.includes('kali')) resolve('kali');
            else if (output.includes('Ubuntu')) resolve('ubuntu');
            else if (output.includes('CentOS')) resolve('centos');
            else if (output.includes('Debian')) resolve('debian');
            else if (output.includes('parrot')) resolve('parrot');
            else if (output.includes('blackarch')) resolve('blackarch');
            else resolve('unknown');
          });
        });
      }).connect({
        host: server.host,
        port: server.port,
        username: server.username,
        privateKey: server.privateKeyPath ? fs.readFileSync(server.privateKeyPath) : undefined
      });
    });
  }
}
