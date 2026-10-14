# 个人 Fork 维护说明

## 来源与范围

- 维护仓库：<https://github.com/ppyang010/dsh-reference-anything>
- 分支：`fix/session-display-double-at`
- 维护版：`0.4.4-ppyang.1`。
- 上游：<https://github.com/Chael-Chael/dsh-reference-anything>，基线 `5e737356862302694a754b0dc97cb3c7c53003ef`，上游版本 `0.4.4`。
- 不修改 DSH 官方安装文件，不按标题合并或删除会话，不发布 npm 包，不向上游提交 PR。

## 使用与语义

1. 输入 `@@` 打开本插件菜单；`@@关键词` 全局搜索，`@@快捷词:关键词` 按设置限定来源。单 `@` 不打开本插件，也不会调用本插件的底层候选搜索。
2. 标题和引用标签优先使用官方 `displayTitle`，缺失时回退到 `label`。不同会话 ID 即使同名也保留。
3. 会话右侧显示「文件夹末级名称 · 更新于时间 · 主会话／分叉会话／子智能体」。兼容 POSIX、Windows 和 UNC 路径，不显示完整路径；元数据缺失时明确显示未知。
4. 更新时间来自 DSH 客户端列表的 `updatedAt`（当前 DSH 投影为创建时间与最近直接用户提示时间的较大者），**不等于最后一个助手／工具事件的时间**。不以候选创建时间、磁盘修改时间冒充；冷缓存的完整性仍受 DSH 列表投影限制。
5. 已开菜单可按列表事件重投影类型和时间，不额外触发搜索 RPC；排序在插件返回候选中生效。官方 Resolver 自身的候选上限仍保留，不宣称全库最近排序。
6. 文件夹 `Tab`、云盘导航继续使用 `@@`；最终插入的文本、引用地址、历史引用 pill 和编解码保持官方单 `@` 格式。代码内 source 名称不改。普通 `/` 命令和官方命令按钮不改。
7. 空格路径使用 `@@"path with space`。兼容层只等长转换检测入参，保留真实编辑器草稿、UTF-16 坐标与版本检查；不访问控制器私有字段。光标位于中间时仍按原生「光标前跨度」语义处理。
8. 双 `@@` 菜单投影会隐藏其它来源；核心仍可能调度其它 `@` 来源，**不承诺阻止核心其它插件的 RPC**。
9. 更新条显示「个人维护版」，禁止 npm 上游更新覆盖定制版。要升级必须在个人 Fork 合并上游并重新验证、固定新提交。

## 构建与测试

在源码根目录执行：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run
# build.mjs 会清理本仓库 lib；先核对当前目录和 lib 的真实路径再执行。
node build.mjs
```

新增持久回归覆盖会话展示、未知元数据、引用 ID 保留、异步快照、活动时间重投影、真实官方输入控制器、单双 @ 门控、引号转换、引用跨度和版本、目录 drill、云盘路径、Esc／IME、原生命令按钮、pending 按键仲裁、同 ID 作用域重建、冻结／恢复跨代竞争、旧后台刷新取消、连续重开 SWR、真实 Cordis 追踪服务卸载与第三方包装 CAS，以及维护版更新保护。

> 注意：基线原有两个 OpenList 权限测试在 POSIX 上失败：`preserves existing config and jwt secret while securing it` 和 `fails closed if the credential ACL seam fails`。原测试只观测 Windows ACL seam，而 macOS/Linux 实现使用 `chmod`；第二例还遗漏虚拟 `rename` seam。已在干净上游提交复现相同失败。此维护版不放宽凭证权限逻辑、不全局伪装平台、不添加 skip；应如实记录全量结果。已有依赖缺 source map 的警告不影响类型或构建。

## 安装、更新与回滚

- 安装前备份目标 Desktop Profile 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`settings.yaml` 和原插件目录。配置可能含密钥，仅本机私有备份，不提交或贴入笔记。
- **固定确切提交**，不要依赖浮动分支。将维护版打成包含已构建 `lib` 的本地归档，使用受管 Desktop 插件入口安装。这样不必让在线 Git prepare 临时获取全套开发依赖，也不必修改其它插件的构建许可。
- macOS Desktop 正式入口为安装包内 `lib/desktop-cli.js`，不是普通独立 CLI 的保留 `desktop` Profile。以下是占位模板，实际提交、归档位置与安装证据应从本机维护笔记查到：

```bash
node "/Applications/DSH Desktop.app/Contents/Resources/app/lib/desktop-cli.js" \
  plugin --profile desktop add /绝对路径/dsh-reference-anything-固定提交.tgz
```

- GitHub 源也可使用 `github:ppyang010/dsh-reference-anything#完整提交`，但 `prepare` 的精确允许构建键必须按 pnpm 当次提示批准并记录；不可使用全局允许所有构建。必须在目标机器验证安装链路，不能把源码已编译当成目标安装成功。
- 当前进程已载入客户端 bundle 时，仅写入磁盘并不保证现有页面更新：必须验证实际服务的 bundle，按官方插件重新加载入口使运行时载入新代，并刷新现有 GUI。不要启动替代 Web 服务，也不要重启正在工作的会话。
- 回滚到修改前的原版 `0.4.4`：通过同一个 Desktop 入口安装 `dsh-reference-anything@0.4.4`，核对 manifest／lockfile；复原仅为当前热安装添加的临时配置，再通过插件重新加载入口恢复。完整 Profile 备份只在需要时恢复，避免覆盖后来其它插件或设置更改。
- GUI 检查必须使用 Desktop 正式「在浏览器中打开」入口；如临时允许普通浏览器，仅 `127.0.0.1`，结束恢复原访问开关。不得提取 Cookie／认证令牌，也不得把带认证参数的地址提交或记入笔记。
