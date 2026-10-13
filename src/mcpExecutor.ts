import * as fs from 'fs';
import * as path from 'path';

export class MCPExecutor {
  constructor(private getWorkspaceRoot: () => string | undefined) {}

  public async executeMCPTool(name: string, args: any): Promise<string> {
    const root = this.getWorkspaceRoot();
    if (!root) return '错误：当前未打开任何工作区文件夹 (Workspace)。';

    if (['read_file', 'write_file', 'delete_file'].includes(name)) {
      if (!args || !args.path || typeof args.path !== 'string' || args.path.trim() === '') {
        return `错误：工具 [${name}] 必须提供有效的 path 参数（文件相对路径）。`;
      }
    }

    const resolvePath = (targetPath: string) => {
      return path.isAbsolute(targetPath) ? targetPath : path.join(root, targetPath);
    };

    try {
      if (name === 'list_directory') {
        const targetPath = resolvePath(args.path || '');
        const entries = await fs.promises.readdir(targetPath, {withFileTypes: true});
        const list = entries.map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`);
        return JSON.stringify(list, null, 2);
      } else if (name === 'read_file') {
        const filePath = resolvePath(args.path);
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
          return `错误：路径 "${args.path}" 是一个目录而不是文件。`;
        }
        return await fs.promises.readFile(filePath, 'utf8');
      } else if (name === 'write_file') {
        const filePath = resolvePath(args.path);
        try {
          const stats = await fs.promises.stat(filePath);
          if (stats.isDirectory()) {
            return `错误：路径 "${args.path}" 是一个已存在的目录，无法直接覆盖写入。`;
          }
        } catch (e) {}
        const dir = path.dirname(filePath);
        await fs.promises.mkdir(dir, {recursive: true});
        await fs.promises.writeFile(filePath, args.content || '', 'utf8');
        return `成功：文件 ${args.path} 已写入。`;
      } else if (name === 'delete_file') {
        const filePath = resolvePath(args.path);
        await fs.promises.unlink(filePath);
        return `成功：文件 ${args.path} 已删除。`;
      }
      return `未知工具: ${name}`;
    } catch (err: any) {
      return `执行 MCP 工具 ${name} 失败: ${err.message}`;
    }
  }
}
