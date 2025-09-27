
# CONTRIBUTING.md

```markdown
# 贡献指南

感谢您考虑为 Starsfall Servers Manager 做出贡献！本指南将帮助您快速上手项目开发。

## 🏁 开始之前

### 先决条件
- **Node.js** 16.0.0 或更高版本
- **VS Code** 最新版本
- **Git** 版本控制系统
- **npm** 或 **yarn** 包管理器

### 开发环境设置

1. **克隆仓库**
```bash
git clone https://github.com/yystarsfall/StarsfallServersManager.git
cd StarsfallServersManager
```

2. **安装依赖**
```bash
npm install
```

3. **构建项目**
```bash
npm run build
```

4. **开发模式 (可选，实时编译)**
```bash
npm run watch
```

# 🧪 测试
## 测试策略
由于本扩展的核心功能涉及 GUI 交互，我们采用分层测试策略：

1. 单元测试
bash
### 运行所有单元测试
```bash
npm test -- --testNamePattern="unit"
```

### 运行特定测试文件
```bash
npm test -- --testPathPattern="command-parser.test.ts"
```
2. 集成测试
bash
### 运行集成测试
```bash
npm test -- --testNamePattern="integration"
```
3. 手动测试清单
对于 GUI 相关功能，请进行以下手动测试：

多行命令处理正常

文件同步功能正常

UI 交互流畅无卡顿

跨平台兼容性验证

错误处理机制健全

# 测试文件结构
text
test/
├── unit/          # 单元测试
├── integration/   # 集成测试
├── ci/            # CI 环境测试
└── manual/        # 手动测试指南
# 🔧 开发工作流
1. 创建功能分支
```bash
git checkout -b feat/your-feature-name
```
2. 实现功能
遵循现有的代码风格

添加适当的注释

编写相应的测试用例

3. 提交更改
```bash
git add .
git commit -m "feat: 添加新功能描述"
```
4. 推送并创建 PR
```bash
git push origin feat/your-feature-name
```
# 📝 Pull Request 流程
## PR 描述模板
请使用以下模板填写 PR 描述：

```markdown
## 变更类型
- [ ] ✨ 新功能
- [ ] 🐛 错误修复
- [ ] 📚 文档更新
- [ ] ⚡ 性能优化
- [ ] ♻️ 代码重构
- [ ] ✅ 测试相关

## 变更描述
详细描述本次 PR 的变更内容、解决的问题或添加的功能...

## 测试验证

### 自动化测试
- [ ] 单元测试已添加/更新
- [ ] 所有现有测试通过
- [ ] 代码覆盖率保持或提高

### 手动测试清单
- [ ] 多行命令处理正常
- [ ] 文件同步功能正常
- [ ] UI 交互流畅
- [ ] 跨平台兼容性验证

### 测试证据
- 截图/GIF: [链接或附件]
- 测试视频: [链接或说明]
- 性能数据: [如有]

## 相关 Issue
 closes #123, fixes #456

## 备注
任何额外说明或需要评审者特别注意的事项...
```

## PR 审查标准
✅ 代码符合项目风格指南

✅ 所有测试通过

✅ 文档相应更新

✅ 功能正常工作

✅ 没有引入破坏性变更

# 🎨 代码风格
## TypeScript 规范
使用严格模式 (strict: true)

优先使用接口而非类型别名

使用有意义的变量和函数名

## 提交消息规范
使用约定式提交：

feat: 新功能

fix: 修复 bug

docs: 文档更新

style: 代码格式调整

refactor: 代码重构

test: 测试相关

chore: 构建过程或辅助工具变动

## 文件命名
使用小写字母和连字符：file-explorer.ts

测试文件：原文件名.test.ts

# 🚀 发布流程
## 版本管理
更新 CHANGELOG.md

更新 package.json 中的版本号

```bash
npm version patch|minor|major
```
创建 Git tag

生成发布版本

```bash
npm run package
```
## 发布检查清单
所有测试通过

文档更新完成

CHANGELOG 更新

版本号正确更新

生成 VSIX 文件测试通过

# 🆘 获取帮助
如果您在开发过程中遇到问题：

查看现有 文档 和 问题

在 讨论区 提问

创建新的 Issue

# 🙏 致谢
感谢所有为项目做出贡献的开发者！您的每一份贡献都让这个项目变得更好。

# Happy Coding! 🎉