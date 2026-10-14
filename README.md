# VS Code Local AI

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)]()
[![VS Code Version](https://img.shields.io/badge/VS%20Code-%5E1.140.0-brightgreen.svg)]()
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)]()

**VS Code Local AI** 是一款专为本地与内网部署大模型打造的 VS Code 编程助手扩展。通过工程化、智能化的集成方案，支持**单模型一体化审查/编码**与**多模型协作（架构规划 + 代码实现）**，配合 MCP 工具协议与自定义 Skills 规则，全面提升工程开发效率与代码质量。

---

## 🛠️ 技术栈

- **核心语言**：TypeScript (Target: ES2022, Module: NodeNext)
- **编译与构建**：`tsc` + `tsc-alias`（支持源码编译与路径别名映射）
- **通信与协议**：
  - **VS Code Webview Message API**：实现 Extension Host 与 Webview 的双向异步通信
  - **MCP (Model Context Protocol) 规范**：解耦 Agent 工具调用与本地文件系统交互
- **前端架构**：原生 HTML5 + CSS Variables + Vanilla JS (模块化分离 `webview.html`, `main.css`, `main.js`)，无缝适配 VS Code 主题样式
- **服务对接**：支持 Ollama `/api/chat` 原生流式响应与 OpenAI API 兼容协议 (LM Studio, vLLM, llama.cpp 等)

---

## 🏗️ 核心架构与模块化分工

本项目采用清晰的**模块化高内聚设计**，各核心模块职责如下：

```text
resources/
├── icon.svg                # 插件图标
├── webview.html            # 插件交互界面结构
├── main.css                # 基于 VS Code 主题变量的纯净样式表
└── main.js                 # 侧边栏事件驱动与流式 DOM 渲染逻辑
src/
├── aiHelper.ts             # AI 大模型通信服务与JSON 工具提取器
├── collabHandler.ts        # 多模型协作流水线 (代码设计模型 ➔ 代码实现模型)
├── extension.ts            # 插件总入口，负责生命周期管理、WebviewProvider 与消息分发路由
├── mcpExecutor.ts          # MCP 协议标准工具执行器 (目录浏览、文件读写、路径安全防护)
├── singleAgentHandler.ts   # 单模型 Agent 处理逻辑 (支持代码审查确认机制与工具循环调用)
└── types.ts                # 全局数据结构与接口定义 (AISettings, ChatHistoryItem, CustomSkill)
```

### 🔄 执行生命周期与流程

1. **Init**：初始化插件，读取 VS Code Workspace State 与 Global State（设置、历史记录与 Skills）。
2. **Setup**：挂载 `AIChatViewProvider`，加载模块化 HTML/CSS/JS 静态资源。
3. **Dispatch**：根据用户触发的模式分发请求：
   - **单模型模式**：支持直接提问/编码，或触发**代码审查（Review）**。审查完成后生成可交互确认按钮，确认后二次调用 MCP 工具落地修改。
   - **多模型模式**：调用设计模型（如 `deepseek-r1`）输出架构与方案，自动透传至实现模型（如 `qwen3-coder`）执行 MCP 工具改写代码。
4. **Tool Execution**：`MCPExecutor` 解析大模型生成的 JSON 工具块，校验路径安全后操作本地文件系统。
5. **Render**：前端利用 `.active-streaming` 选择器精准接收流式文本并实时渲染。

---

## 🌟 核心特性

- **🤖 智能体文件读写 (Agent Loop)**：AI 能够自主感知当前工作区，执行目录浏览（`list_directory`）、文件读取（`read_file`）、创建写入（`write_file`）和删除（`delete_file`）。
- **🔍 智能代码审查与一键落地**：单模型模式自动识别代码审查指令，先生成详细的质量审计报告，弹出确认选项，用户同意后自动按建议修改项目代码。
- **🚀 架构规划与实现分工（多模型协作）**：支持将深度思考/设计模型与强编码能力模型组合，形成高效的软件工程流水线。
- **⚡ 自定义 Custom Skills**：支持为模型挂载自定义 Prompt 规则模板，精准约束编码风格与规范。
- **🧠 思考过程可视化**：原生支持带 `<think>` 标签的模型（如 DeepSeek-R1），自动格式化思考日志。
- **⚙️ 极简优雅的 UI**：完美融入 VS Code 原生设计风格，无多余重复图标，支持多标签页无缝切换。

---

## 🚀 快速开始与开发指南

### 1. 安装依赖

确保已安装 **Node.js**（推荐 22+ 或 LTS 版本），在项目根目录下执行：

```bash
npm install
```

### 2. 编译与调试

先编译代码

```bash
# 增量编译 TypeScript
npm run compile
```

再到 VS Code 左侧栏点击“运行和调试”按钮，点击运行调试会自动弹出新的窗口，在调试的新窗口中找到插件进行测试

### 3. 构建插件

构建插件需要全局安装vscode 插件打包工具@vscode/vsce，本项目中打包插件执行以下命令：

```bash
# 调用@vscode/vsce打包
npm run package
```

### 4. 配置本地 AI 服务

启动插件侧边栏后，点击右上角 ⚙️ 图标进入设置页：

服务协议：选择 Ollama 或 OpenAI 兼容协议

服务地址：例如 [http://127.0.0.1:11434](http://127.0.0.1:11434)

上下文大小：建议设置为 32K 或更高以获得更好的长上下文代码阅读体验
