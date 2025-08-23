import * as vscode from 'vscode';
import { ServerDetails } from './sshConfigHandler';

export async function showServerList(servers: ServerDetails[]): Promise<ServerDetails & { isNew: boolean } | undefined> {
    const items = servers.map(server => ({
        label: server.name,
        description: `${server.host}:${server.port}`,
        detail: `User: ${server.username}`,
        server
    }));

    items.push({
        label: '新增服务器',
        description: '添加新的服务器配置',
        detail: '',
        server: { isNew: true } as any
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要连接的服务器'
    });

    return selected ? { ...selected.server, isNew: selected.label === '新增服务器' } : undefined;
}

export async function promptForServerDetails(): Promise<ServerDetails> {
    const name = await vscode.window.showInputBox({
        prompt: '输入服务器名称',
        placeHolder: '例如: my-server'
    });
    if (!name) throw new Error('服务器名称不能为空');

    const host = await vscode.window.showInputBox({
        prompt: '输入服务器地址',
        placeHolder: '例如: 192.168.1.1'
    });
    if (!host) throw new Error('服务器地址不能为空');

    const port = await vscode.window.showInputBox({
        prompt: '输入服务器端口',
        placeHolder: '默认: 22',
        value: '22'
    });

    const username = await vscode.window.showInputBox({
        prompt: '输入用户名',
        placeHolder: '默认: root',
        value: 'root'
    });

    const password = await vscode.window.showInputBox({
        prompt: '输入密码 (可选)',
        placeHolder: '留空则使用私钥',
        password: true
    });

    const privateKeyPath = password
        ? undefined
        : await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: false,
              openLabel: '选择私钥文件'
          }).then(uri => uri?.[0]?.fsPath);

    return {
        name,
        host,
        port: port ? parseInt(port, 10) : 22,
        username: username || 'root',
        password,
        privateKeyPath
    };
}