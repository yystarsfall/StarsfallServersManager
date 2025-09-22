# Starsfall Servers Manager

[![GitHub Actions CI](https://github.com/yystarsfall/StarsfallServersManager/workflows/CI/badge.svg)](https://github.com/yystarsfall/StarsfallServersManager/actions)

## 功能概述

Starsfall Servers Manager 是一个强大的 VS Code 扩展，专为简化多个 Linux 服务器的管理操作而设计。通过直观的界面和强大的功能，让您像操作本地文件一样轻松管理远程服务器。

## ✨ 核心功能

- **多服务器管理**: 同时连接和管理多个 Linux 服务器
- **智能 SSH 配置**: 自动读取和编辑 `~/.ssh/config` 文件
- **集成终端**: 内置 SSH 终端支持，支持多行命令处理
- **可视化文件管理**: 树状文件浏览器，支持实时文件编辑和同步
- **一键操作**: 快速连接、断开、编辑和移除服务器
- **跨平台支持**: 完美支持 Windows、macOS 和 Linux

## 安装指南

### 从 VSIX 文件安装

1. **获取 VSIX 文件**:
``` bash
# 克隆项目
git clone https://github.com/yystarsfall/StarsfallServersManager.git
cd StarsfallServersManager
# 依赖说明
# 项目使用 `webpack` 进行打包，确保已安装 `webpack` 和 `webpack-cli`：
npm install webpack webpack-cli --save-dev
# 安装依赖并打包
npm install
npm run build
npm install -g @vscode/vsce  # 如果尚未安装vsce
vsce package
```

2. **安装扩展**:

在 VS Code 中按下 Ctrl+Shift+P (或 Cmd+Shift+P)

搜索并选择 Extensions: Install from VSIX...

选择生成的 .vsix 文件进行安装

3. **重新加载 VS Code 完成安装**


## 📖 使用指南

### 连接服务器
打开命令面板 (`Ctrl+Shift+P` / `Cmd+Shift+P`)

输入 `Starsfall: Connect Linux Server` 并执行

选择现有服务器或添加新服务器

连接成功后自动打开终端和文件浏览器

### 文件操作
实时编辑: 直接在编辑器中修改远程文件

上传下载: 支持 rz/sz 命令进行文件传输

树状浏览: 直观的文件系统树状视图

### 服务器管理
命令 | 功能描述 |	使用场景
`Starsfall: Connect Linux Server` |	连接新服务器 |	首次连接或新增服务器
`Starsfall: Edit Linux Server` |	编辑服务器配置 | 修改连接参数
`Starsfall: Remove Linux Server`	移除服务器 | 清理不再需要的服务器
`Starsfall: Disconnect All` |	断开所有连接 |	快速清理所有连接

## 命令解析

### 连接服务器
1. 打开命令面板（`Ctrl+Shift+P` 或 `Cmd+Shift+P`）。
2. 输入 `Starsfall: Connect Linux Server` 并执行。
3. 从弹出的服务器列表中选择要连接的服务器。如果用户的ssh配置文件中存在服务器配置，会自动读取出来，如果不存在，会提示用户输入服务器的名称、地址、端口、用户名、密码、私钥路径。
4. 如果用户选择了新增服务器配置，新增完服务器的配置，自动添加到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中，并自动连接服务器。
5. 连接成功后，自动打开服务器的终端和文件资源管理器。

### 编辑服务器
1. 打开命令面板。
2. 输入 `Starsfall: Edit Linux Server` 并执行。
3. 弹出服务器列表，选择要编辑的服务器。
4. 从弹出的服务器列表中选择要编辑的服务器。如果用户的ssh配置文件中存在服务器配置，会自动读取出来，如果不存在，会提示用户输入服务器的名称、地址、端口、用户名、密码、私钥路径。
5. 编辑完成后，自动保存到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中。

### 移除服务器
1. 打开命令面板。
2. 输入 `Starsfall: Remove Linux Server` 并执行。
3. 弹出已连接的服务器列表，选择要移除的服务器。
4. 确认移除后，自动关闭相应的终端和文件系统。

### 一键断开所有服务器连接
1. 打开命令面板。
2. 输入 `Starsfall: Disconnect All` 并执行。
3. 断开连接后，自动关闭相应的终端和文件系统。

## 文件上传和下载
### 上传文件
```bash
┌──(root💀kali_xuegod53)-[~]  
└─# rz  
```

### 下载文件 
```bash
┌──(root💀kali_xuegod53)-[~]  
└─# sz test.txt 
```


## 开发指南
### 构建项目
1. 安装依赖：
```bash
npm install
```
2. 构建项目（使用 webpack）：
```bash
npm run build
```
3. 开发模式（实时编译）：
```bash
npm run watch
```
4. 打包为 VSIX：
```bash
npm install -g @vscode/vsce  # 如果尚未安装vsce
vsce package
```
5. F5 启动调试 再弹出的新窗口中进行功能测试


### 依赖说明
- 项目使用 `webpack` 进行打包，确保已安装 `webpack` 和 `webpack-cli`：
```bash
npm install webpack webpack-cli --save-dev
```

## 注意事项
1. 确保服务器地址和端口正确，且网络连接正常。
2. 编辑或移除服务器时，关联的终端和文件系统会被自动关闭。
3. 扩展需要 VS Code 版本 1.75.0 或更高。

❓ 常见问题
Q: 扩展支持哪些操作系统？
A: 支持 Windows、macOS 和 Linux 系统。

Q: 是否需要预先配置 SSH？
A: 不需要，扩展会自动读取现有 SSH 配置并支持添加新配置。

Q: 支持哪些认证方式？
A: 支持密码认证和 SSH 密钥认证。

Q: 如何报告问题或请求功能？
A: 请访问 GitHub Issues 提交问题或功能请求。

🤝 支持与反馈
问题报告: 遇到问题时提交详细报告

功能请求: 建议新功能或改进

讨论区: 与其他用户交流使用经验

👥 贡献
我们欢迎所有形式的贡献！请参阅 CONTRIBUTING.md 了解如何参与项目开发。

📄 许可证
本项目采用 MIT 许可证 - 详见 LICENSE 文件。

注意: 本扩展目前处于活跃开发阶段，功能可能会不断更新和改进。建议定期检查更新以获取最新功能。