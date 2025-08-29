# Starsfall Servers Manager

## 功能概述
Starsfall Servers Manager 是一个 TypeScript 语言写的 VS Code 扩展，用于简化多个 Linux 服务器的管理操作。支持以下功能：
- 连接、移除、编辑、一键断开多个 Linux 服务器，支持 SFTP 协议和 SSH 协议
- 安装好插件之后，可以看到VSCode 左侧会多一个 Servers Explorer 图标，点击图标，可以看到已连接的服务器列表，点击列表中的服务器，会自动打开服务器的终端和文件资源管理器
- 连接服务器时，自动读取 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件，展示出可用的服务器列表供用户选择，并支持用户新增服务器配置
- 如果用户选择已存在的服务器，读取相应的服务器配置，自动连接服务器
- 连接成功后，自动打开服务器的终端和文件资源管理器
- 一键断开所有服务器连接，断开连接后，自动关闭相应的终端和文件系统
- 可实时编辑和保存远程服务器上的文本文件，或者代码文件

- 连接服务器时，弹出服务器列表，选择新增服务器的时候，要求用户输入服务器的名称、地址、端口、用户名、密码、私钥路径，支持 SFTP 协议和 SSH 协议，用户名默认root，端口默认22，私钥路径弹出文件选择框，用户填写完整上述服务器ssh 连接配置，自动添加到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中，并自动连接服务器

- 用户执行移除命令，弹出已连接的服务器列表，选择移除服务器的时候，要求用户确认是否移除，移除后，自动关闭相应的终端和文件系统
- 一键断开所有服务器连接，断开连接后，自动关闭相应的终端和文件系统

## 安装指南

### 扩展市场安装
1. 打开 VS Code 扩展市场。
2. 搜索 "Starsfall Servers Manager"。
3. 点击 "安装" 按钮。

### 手动源码安装
1. 下载源码。
2. 解压源码。
3. 进入解压后的目录。
4. 执行 `npm install` 安装依赖。
5. 执行 `npm run build` 打包项目。
6. 执行 `code --install-extension starsfall-servers-manager-0.0.1.vsix` 安装扩展。
7. 重新加载 VS Code。

## 使用说明
### 连接服务器
1. 打开命令面板（Ctrl+Shift+P 或 Cmd+Shift+P）。
2. 输入 "Starsfall: Connect Linux Server" 并执行。
3. 从弹出的服务器列表中选择要连接的服务器。如果用户的ssh配置文件中存在服务器配置，会自动读取出来，如果不存在，会提示用户输入服务器的名称、地址、端口、用户名、密码、私钥路径。
4. 如果用户选择了新增服务器配置，新增完服务器的配置，自动添加到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中，并自动连接服务器。
5. 连接成功后，自动打开服务器的终端和文件资源管理器。

### 编辑服务器
1. 打开命令面板。
2. 输入 "Starsfall: Edit Linux Server" 并执行。
3. 弹出服务器列表，选择要编辑的服务器。
4. 从弹出的服务器列表中选择要编辑的服务器。如果用户的ssh配置文件中存在服务器配置，会自动读取出来，如果不存在，会提示用户输入服务器的名称、地址、端口、用户名、密码、私钥路径。
5. 编辑完成后，自动保存到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中。

### 移除服务器
1. 打开命令面板。
2. 输入 "Starsfall: Remove Linux Server" 并执行。
3. 弹出已连接的服务器列表，选择要移除的服务器。
4. 确认移除后，自动关闭相应的终端和文件系统。

### 一键断开所有服务器连接
1. 打开命令面板。
2. 输入 "Starsfall: Disconnect All" 并执行。
3. 断开连接后，自动关闭相应的终端和文件系统。

## 命令列表
| 命令 | 功能 |
|------|------|
| `starsfall.connectServer` | 连接新的 Linux 服务器 |
| `starsfall.editServer` | 编辑现有的 Linux 服务器配置 |
| `starsfall.removeServer` | 移除现有的 Linux 服务器配置 |
| `starsfall.disconnectAll` | 一键断开所有服务器连接 |

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

### 依赖说明
- 项目使用 `webpack` 进行打包，确保已安装 `webpack` 和 `webpack-cli`：
  ```bash
  npm install webpack webpack-cli --save-dev
  ```

## 注意事项
1. 确保服务器地址和端口正确，且网络连接正常。
2. 编辑或移除服务器时，关联的终端和文件系统会被自动关闭。
3. 扩展需要 VS Code 版本 1.75.0 或更高。