# VS Code Local AI

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)]()
[![VS Code Version](https://img.shields.io/badge/VS%20Code-%5E1.140.0-brightgreen.svg)]()
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)]()

**VS Code Local AI** 是一款专为本地部署与内网部署大模型打造的 VS Code 编程助手扩展。它不仅支持基础的问答交互，更具备类似 **Cline** 的 **Agent 智能体文件读写与代码编写能力**，让你的本地大模型（如 Qwen-Coder、DeepSeek 等）真正参与到项目的开发与维护中。

---

## 🌟 核心特性

- **🤖 智能体文件读写 (Agent Loop)**：AI 能够自主感知当前工作区，执行目录浏览、文件读取和代码修改，实现全自动的编码辅助。
- **🔌 多协议深度兼容**：
  - **Ollama 原生协议**：完美支持 Ollama 部署的模型及 `/api/chat` 流式响应。
  - **OpenAI 兼容协议**：支持通过 **LM Studio**、**vLLM**、**llama.cpp** 等运行的本地或内网大模型。
- **🛡️ 安全的代码修改机制**：内置严格的文件保护规范，修改代码前必先读取文件全貌，防止局部更新导致代码误覆盖。
- **🧠 深度思考过程可视化**：原生支持带有 `<think>` 标签的模型（如 DeepSeek-R1），自动将思考过程折叠展示，保持界面整洁。
- **⚙️ 灵活的参数配置**：支持自定义服务地址、API Key 鉴权以及大模型上下文窗口大小（支持 8K 至 256K）。

---

## 📦 安装与开发指南

### 1. 克隆与安装依赖

在项目根目录下打开终端，执行以下命令安装依赖：

```bash
npm install
```
