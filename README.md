# Mock Header

一个本地使用的 Chrome Manifest V3 扩展。它根据当前 Profile 的页面域名和请求 URL 范围，为请求设置或覆盖 Header。

## 功能

- 全局启停，任意时刻仅一个 Profile 生效
- 支持按页面域名、请求 URL，或两者同时匹配
- 每个 Profile 可配置多个 Header 候选值
- 同名 Header 可以保存多个候选值，但最多启用一个
- 所有 Profile、匹配范围和 Header 配置都直接在 Popup 中完成
- Popup 中展示并编辑每个候选值的名称、Value 和可选注释，支持逐行切换
- Popup 左侧纵向展示 Profile，简称取名称前三个字母或汉字，并支持拖拽排序
- Popup 支持 Profile 管理和 versioned JSON 导入、导出
- 编辑内容会自动保存；尚未通过校验的瞬时草稿会暂存到当前浏览器会话，重新打开后可继续编辑
- 工具栏图标在停用时置灰，启用时通过角标展示当前 Profile 的三字符简称
- 固定暗黑主题，正式配置保存在 `chrome.storage.local`

## 本地安装

```bash
npm install
npm run build
```

然后打开 `chrome://extensions`：

1. 开启“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择本项目生成的 `dist` 目录。

扩展使用 Chrome 145+ 提供的顶层页面域名匹配能力。

## 匹配规则

页面范围只填写域名，例如：

```text
example.com
```

该配置同时覆盖 `example.com` 的子域名。请求 URL 使用简化的 Chrome Pattern，例如：

```text
*://api.example.com/*
https://example.com/api/*
http://localhost:3000/*
```

“两者同时匹配”模式使用 AND 语义：顶层页面域名和实际请求 URL 都命中时才设置 Header。

## 开发命令

```bash
npm run dev       # 监听源码并持续构建到 dist
npm run typecheck # TypeScript 静态检查
npm run build     # 类型检查并生成完整扩展
npm run verify    # 校验 Manifest 和构建产物引用
npm run icons     # 重新生成 PNG 图标
```

修改源码并重新构建后，需要在 `chrome://extensions` 中重新加载扩展。`<all_urls>` 主机权限用于支持用户配置任意域名；真正生效的请求仍受当前 Profile 的匹配范围约束。
