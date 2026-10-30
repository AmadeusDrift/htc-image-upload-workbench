# HTC Image Upload Workbench

**htc传图工具台 / HTC 图片上传工作台**

公司内部图片上传工具，包含 Windows Electron 客户端、React 网页界面与 Cloudflare Workers 服务端。源码版本 **1.0.8**。

## 功能

- 员工登录、管理员账号管理、业务组隔离和权限分配。
- 选择或拖入图片/文件夹，保留相对目录；支持 JPG、PNG、WebP，单图最大 50 MB。
- 公司共用 20 路上传，每员工及每设备最多 5 路；同一员工在不同设备共享员工上限。
- 暂停、恢复、仅重试失败及本地任务检查点。
- 大批次最多 20,000 张；内部每 100 张登记并开始上传，保留每人 5 路并发；分页恢复、详情和导出，临时网络错误自动退避重试。
- 上一批全部成功后重新选图，开始独立批次；未上传前连续选图仍追加到同批。
- Excel/CSV 导出：逐张明细或每产品一行的套图表，按数字场景名排列，缺图留空。
- 图片保留 7 天，公开地址支持 GET/HEAD。

上传前压缩的底层模块已有测试，但“手动压缩对比、整批选择版本”的完整交互尚未接入，不属于当前可用功能。

## 结构

| 路径 | 用途 |
| --- | --- |
| `src/` | React 界面、上传队列、导出和前端测试 |
| `electron/` | 窗口、受限 IPC、原生传输和本地持久化 |
| `server/` | Worker API、鉴权、D1 数据表、R2 签名和后端测试 |
| `scripts/` | 图标生成、资源打包和内部发布校验 |
| `assets/`、`public/` | 图标和静态素材 |
| `docs/` | 部署说明与历史实施方案 |

D1 保存用户、权限、任务、元数据和上传租约，R2 保存图片。客户端获得短期预签名 URL 后直传 R2，服务端确认对象后生成公开图片地址。

## 开发与验证

建议使用 Node.js 24 和 npm；Windows 客户端在 Windows 上打包。

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npx wrangler types
npm run build:web
npm run build:server
npm run typecheck
npx tsc --noEmit -p tsconfig.server.json
npm test
```

前端开发：`npm run dev`。Electron 启动前先构建网页，再运行 `npm run desktop`。

本地联调可运行 `npx wrangler dev` 并访问其网页/API。Electron 的默认连接地址在 `server.json`，仍指向现有部署，注意区分本地和生产数据。

最近一次完整回归 **189 项通过**，包括账号密码、表单弹窗、会话切换、并发、上传中断、恢复、独立批次和导出。

## Windows 打包

```powershell
npm run build:web
npm run pack:win -- --config.directories.output=release
```

EXE 可直接分发，员工电脑无需安装 Node.js；使用时需要联网并登录。

`scripts/verify-release.cjs` 依赖当前内部的同级“云图工作台安装包”目录，常规打包不需要执行它。

## 部署与凭据

见 [部署维护](docs/部署维护.md)。仓库保留当前资源绑定标识和公开地址；部署到其他账号前需更新 `wrangler.jsonc`、`server.json` 与构建脚本中的对应域名。

仓库不包含生产 Token、R2 密钥、员工密码、会话令牌、业务图片或安装包。测试里的密码与密钥是测试夹具，不是生产账号配置。

务必保留生产 `CONFIG_KEY`；R2 连接凭据由其加密，不能用示例值覆盖。员工只需 EXE 与本人账号，无需长期 R2 凭据。

本项目按私有公司仓库维护，当前未声明开源许可证。
