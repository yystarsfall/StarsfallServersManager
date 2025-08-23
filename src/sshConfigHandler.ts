import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ServerDetails {
    name: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKeyPath?: string;
}

export async function readSSHConfig(): Promise<ServerDetails[]> {
    const sshConfigPath = getSSHConfigPath();
    if (!fs.existsSync(sshConfigPath)) return [];

    const content = fs.readFileSync(sshConfigPath, 'utf-8');
    const lines = content.split('\n');
    const servers: ServerDetails[] = [];
    let currentServer: Partial<ServerDetails> = {};

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('Host ') && trimmedLine !== 'Host *') {
            // 保存上一个服务器的信息
            if (currentServer.name) {
                servers.push(currentServer as ServerDetails);
            }
            // 开始解析新的服务器
            currentServer = {
                name: trimmedLine.substring(5).trim(),
            };
        } else if (currentServer.name) {
            // 解析服务器属性
            if (trimmedLine.startsWith('HostName ')) {
                currentServer.host = trimmedLine.substring(9).trim();
            } else if (trimmedLine.startsWith('Port ')) {
                currentServer.port = parseInt(trimmedLine.substring(5).trim(), 10);
            } else if (trimmedLine.startsWith('User ')) {
                currentServer.username = trimmedLine.substring(5).trim();
            } else if (trimmedLine.startsWith('IdentityFile ')) {
                currentServer.privateKeyPath = trimmedLine.substring(13).trim();
            }
        }
    }

    // 添加最后一个服务器
    if (currentServer.name) {
        servers.push(currentServer as ServerDetails);
    }

    return servers;
}

export async function writeSSHConfig(serverDetails: ServerDetails): Promise<void> {
    const sshConfigPath = getSSHConfigPath();
    let configLine = `\nHost ${serverDetails.name}\n  HostName ${serverDetails.host}\n  Port ${serverDetails.port}\n  User ${serverDetails.username}`;

    if (serverDetails.privateKeyPath) {
        configLine += `\n  IdentityFile ${serverDetails.privateKeyPath}`;
    }

    fs.appendFileSync(sshConfigPath, configLine, 'utf-8');
}

function getSSHConfigPath(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    return path.join(homeDir!, '.ssh', 'config');
}