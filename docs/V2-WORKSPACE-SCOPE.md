# 只在 CareerOS 工作区出现

## 为什么之前是全局的

插件装在这个 profile 的 `bundles` 里，而 bundles 是 profile 级配置；`career_*` 工具注册时也没有激活条件，所以每个会话都会看到 85 个工具和侧边栏入口。

## 现在的做法

### 工具：按会话工作目录激活

`ctx.tools.register(definition, { when })` 支持“每步激活条件”。插件用会话的 `header.cwd` 判断：

- `cwd` 等于或位于 `workspaceRoots` 之下 → 工具可见
- `cwd` 是别的工作区（如 `D:\finance_ds`）→ 工具不可见，模型看不到也调不到
- `cwd` 未知（新建会话还没落目录、或恢复的会话没有 header.cwd）→ **保持可见**，避免因为读不到路径而永久藏掉功能

根目录默认是插件自身（`D:\career_os`），可用配置覆盖：

```yaml
onlyInCareerWorkspace: true      # false = 回到全局（旧行为）
workspaceRoots: []               # 例：["D:\\career_os", "D:\\career_os_work"]
```

判断放在 `host/workspace-scope.js`：路径分隔符归一、Windows 下忽略大小写、`D:\career_os_old` 这种“前缀相同的兄弟目录”不会误判。

### 侧边栏入口：按所在工作区显示

`sidebar.footer.action` 是根级 slot，拿不到工作区参数；入口组件从 slot 标准 props 的 `useWorkspaces` 取当前工作区路径，向 `GET /api/career/scope?path=…` 询问是否在 CareerOS 工作区：

- 是 → 正常显示按钮
- 否 → 渲染空，并把 `careeros:open` 置回关闭，避免面板继续盖着
- 取不到路径（hook 形状变化）→ 保持显示（fail-open）

### 自检接口

`GET /api/career/scope?sessionId=<id>` 返回该会话真实的 `cwd` 与判定结果，用来确认某个会话到底被算进了哪个工作区。

## 已验证

- 单元测试 7 项：root 自身/子目录匹配、兄弟目录不误判、大小写与结尾斜杠、默认根、cwd 未知时放行、跨工作区隐藏、服务缺失或抛错时放行、配置可关闭。
- 插件重载后日志确认生效：`career workspace scope {"mode":"scoped","roots":["D:\\career_os"]}`。
- 全量回归 471 项通过。

## 没验证到的

- 客户端按钮的隐藏需要刷新页面后才生效；`useWorkspaces` 快照的真实字段名没有在运行中核对过，所以按“拿不到就保持显示”处理。如果你在别的工作区仍看到按钮，说明字段名不同，把 `/api/career/scope` 的日志发我，我按实际形状收紧。
- 子智能体继承父会话的工作目录，因此父在 CareerOS 工作区时子智能体也能用这些工具；这是刻意的（否则子智能体无法完成求职任务）。
