import * as vscode from 'vscode';
import { ServerManager } from './serverManager';
import { FileExplorerManager } from './fileExplorerManager';
import { SshFileSystemProvider } from './sshFileSystemProvider';

// 全局单例
const fileExplorerManager = FileExplorerManager.getInstance();
const serverManager = new ServerManager(fileExplorerManager);

export function activate(context: vscode.ExtensionContext) {
  console.log('Starsfall Servers Manager is now active!');

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
  const editServerCommand = vscode.commands.registerCommand('starsfall.editServer', () => {
    vscode.window.showInformationMessage('Edit Server command executed.');
  });

  const removeServerCommand = vscode.commands.registerCommand('starsfall.removeServer', () => {
    vscode.window.showInformationMessage('Remove Server command executed.');
  });

  const disconnectAllCommand = vscode.commands.registerCommand('starsfall.disconnectAll', () => {
    vscode.window.showInformationMessage('Disconnect All command executed.');
  });

  const focusServersExplorerCommand = vscode.commands.registerCommand('starsfall.focusServersExplorer', () => {
    vscode.commands.executeCommand('workbench.view.extension.serversExplorer');
  });

  const downloadFileCommand = vscode.commands.registerCommand('starsfall.downloadFile', (fileItem) => {
    const fileExplorerManager = FileExplorerManager.getInstance();
    const treeDataProvider = fileExplorerManager.getTreeDataProvider();
    treeDataProvider.downloadFile(fileItem);
  });

  const openFileCommand = vscode.commands.registerCommand('starsfall.openFile', (fileItem) => {
    const fileExplorerManager = FileExplorerManager.getInstance();
    const treeDataProvider = fileExplorerManager.getTreeDataProvider();
    treeDataProvider.openFile(fileItem);
  });

  context.subscriptions.push(
    connectServerCommand,
    editServerCommand,
    removeServerCommand,
    disconnectAllCommand,
    focusServersExplorerCommand,
    downloadFileCommand
  );
}

export function deactivate() {}