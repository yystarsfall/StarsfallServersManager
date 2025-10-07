import * as vscode from 'vscode';
import { ServerManager } from './serverManager';
import { TerminalProvider } from './terminalProvider';
import { FileExplorerManager } from './fileExplorerManager';
import { SshFileSystemProvider } from './sshFileSystemProvider';

// 全局单例
const fileExplorerManager = FileExplorerManager.getInstance();
const serverManager = new ServerManager(fileExplorerManager);

export function activate(context: vscode.ExtensionContext) {
  console.log('Starsfall Servers Manager is now active!');

  // 监听终端关闭事件，清理缓存
  const terminalCloseSubscription = vscode.window.onDidCloseTerminal(terminal => {
    serverManager.handleTerminalClose(terminal);
  });
  context.subscriptions.push(terminalCloseSubscription);

  // 全局异常监听
  process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED REJECTION]', err);
  });

  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
  });

  // 注册文件系统提供者
  const sshFsProvider = new SshFileSystemProvider(fileExplorerManager.getTreeDataProvider());
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('ssh', sshFsProvider, {
      isCaseSensitive: false, // 根据需求调整
      isReadonly: false       // 允许写入
    })
  );

  // 注册 TreeDataProvider
  vscode.window.registerTreeDataProvider('serversList', fileExplorerManager.getTreeDataProvider());

  // Register commands
  const connectServerCommand = vscode.commands.registerCommand('starsfall.connectServer', () => serverManager.connectServer());
  const editServerCommand = vscode.commands.registerCommand('starsfall.editServer', () => serverManager.editServer());

  const removeServerCommand = vscode.commands.registerCommand('starsfall.removeServer', () => serverManager.disconnectServer());
  const disconnectAllCommand = vscode.commands.registerCommand('starsfall.disconnectAll', () => serverManager.disconnectAllTerminals());
  const shutdownAllCommand = vscode.commands.registerCommand('starsfall.shutdownAll', () => serverManager.shutdownAllServers());

  const focusServersExplorerCommand = vscode.commands.registerCommand('starsfall.focusServersExplorer', () => {
    vscode.commands.executeCommand('workbench.view.extension.serversExplorer');
  });

  const uploadFileCommand = vscode.commands.registerCommand('starsfall.uploadFile', async (args) => {
    const terminal = vscode.window.activeTerminal;
    if (terminal && terminal.name.startsWith('SSH:')) {
      const provider = (terminal as any).creationOptions.pty as TerminalProvider;
      await provider.handleFileUpload();
    }
  });
  const downloadFileCommand = vscode.commands.registerCommand('starsfall.downloadFile', async (args) => {
    const terminal = vscode.window.activeTerminal;
    if (terminal && terminal.name.startsWith('SSH:')) {
      const provider = (terminal as any).creationOptions.pty as TerminalProvider;
      await provider.handleFileDownload();
    }
  });
  const openFileCommand = vscode.commands.registerCommand('starsfall.openFile', (fileItem) => {
    const fileExplorerManager = FileExplorerManager.getInstance();
    const treeDataProvider = fileExplorerManager.getTreeDataProvider();
    treeDataProvider.openFile(fileItem);
  });

  // 注册复制终端命令
  const duplicateTerminalCommand = vscode.commands.registerCommand('starsfall.duplicateTerminal', async () => {
    await serverManager.duplicateCurrentTerminal();
  });

  context.subscriptions.push(
    connectServerCommand,
    editServerCommand,
    removeServerCommand,
    disconnectAllCommand,
    shutdownAllCommand,
    focusServersExplorerCommand,
    uploadFileCommand,
    downloadFileCommand,
    openFileCommand,
    duplicateTerminalCommand
  );
}

export function deactivate() { }