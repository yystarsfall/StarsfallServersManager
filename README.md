# Starsfall Servers Manager

## 功能概述
Starsfall Servers Manager 是一个 VS Code 扩展，用于在单个 VS Code 窗口中管理多个 Linux 服务器。支持以下功能：
- 连接、移除、编辑、一键断开多个 Linux 服务器
- 执行连接命令的时候，自动读取 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件，展示出可用的服务器列表供用户选择，并支持用户新增服务器配置
- 如果用户选择已存在的服务器，读取相应的服务器配置，自动连接服务器
- 如果用户选择了新增服务器配置，新增完服务器的配置，自动添加到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中，并自动连接服务器
- 服务器连接成功后，自动打开服务器的终端，支持 SFTP 协议和 SSH 协议
- 服务器连接成功后，自动打开服务器的文件资源管理器，支持 SFTP 协议和 SSH 协议
- 连接多台服务器时，保留每个已连接的终端、以及相应的文件系统根目录树状图展示，VSCode Explorer 根据已连接的服务器，动态添加相应的根目录树状图挂载到 Explorer 中，支持 SFTP 协议和 SSH 协议
- 用户执行连接命令，弹出服务器列表，选择新增服务器的时候，要求用户输入服务器的名称、地址、端口、用户名、密码、私钥路径，支持 SFTP 协议和 SSH 协议，用户名默认root，端口默认22，私钥路径弹出文件选择框，支持 SFTP 协议和 SSH 协议，用户填完服务器的名称、地址、端口、用户名、密码、私钥路径后，自动添加到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中
- 用户执行编辑命令，弹出服务器列表，选择编辑服务器的时候，要求用户输入服务器的名称、地址、端口、用户名、密码、私钥路径，支持 SFTP 协议和 SSH 协议，用户名默认root，端口默认22，私钥路径弹出文件选择框，支持 SFTP 协议和 SSH 协议，用户填完服务器的名称、地址、端口、用户名、密码、私钥路径后，自动保存到 `~/.ssh/config`或者 `c:\Users\username\.ssh\config` 文件中
- 用户执行移除命令，弹出已连接的服务器列表，选择移除服务器的时候，要求用户确认是否移除，移除后，自动关闭相应的终端和文件系统，支持 SFTP 协议和 SSH 协议
- 一键断开所有服务器连接，断开连接后，自动关闭相应的终端和文件系统，支持 SFTP 协议和 SSH 协议

## 安装指南
1. 在 VS Code 扩展市场中搜索 "Starsfall Servers Manager"。
2. 点击 "安装" 按钮。
3. 安装完成后，重新加载 VS Code。

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