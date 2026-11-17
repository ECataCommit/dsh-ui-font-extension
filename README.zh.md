# 本地字体文件（dsh-ui-font-extension）

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件包：把本地目录里的字体文件变成 Web 字体，提供给所有打开 Harness 的浏览器。

排版从此跟随**字体文件**，而不是你浏览器所在的主机。字体只需在 Harness 运行的机器上放一次，另一台电脑、平板、同一 Tailscale 网络里的手机打开同一个页面，看到的字形、字重、字距完全一致。

## 为什么需要它

浏览器把 CSS 里的 `font-family` 名称解析成**客户端**已安装的字体。远程浏览器通常没有同名字体，于是 `"Georgia", "Songti SC"` 这类字体列表会静默回退到系统默认字体。

这个插件把字体字节从 Harness 服务端发出去，并把 `@font-face` 规则注入页面外壳，于是族名指向服务端拥有的文件。

## 安装

纯 JS 包，无构建步骤、无依赖。

- 在 Harness 界面打开 **Plugins → Add plugin**，填入本目录的绝对路径，启用该 bundle。
- Host 侧也可以通过插件管理器安装同一目录（`install_bundle`，target 为包的绝对路径）。
- 覆盖已安装的副本后需要重启一次才会加载新的 JavaScript。

## 使用

1. 把字体文件放进插件读取的目录，默认 `~/.dsh/fonts`：

   ```sh
   mkdir -p ~/.dsh/fonts
   cp ~/Downloads/YourFont-*.woff2 ~/.dsh/fonts/
   ```

2. 刷新 Harness 页面。插件会为每个检测到的字面（face）注入一条 `@font-face`，族名取自字体自身。

3. 在 **Settings → Appearance → Fonts** 里选中该族名，或沿用任何已经写了这个族名的配置。族名来自字体内部，所以 `"Songti SC"`、`"Iosevka"` 原样即可。

支持格式：`.woff2`、`.woff`、`.ttf`、`.otf`，以及集合格式 `.ttc` / `.otc`。集合会在内存中按字面拆成独立 sfnt（浏览器不直接加载集合文件），只有页面真正用到的字面才构建，最近几个会缓存。

## 配置

全部可选：

```yaml
- id: ui-font-extension
  name: dsh-ui-font-extension
  config:
    dirs:
      - ~/.dsh/fonts
      - /Volumes/Sync/Fonts
    routePath: /dsh-fonts      # 提供字体文件的 URL 前缀
    fontDisplay: swap          # auto | block | swap | fallback | optional
    maxFileBytes: 67108864     # 单文件上限
```

同样的值也可以写在 `$DSH_HOME/font-extension.json`（默认 `~/.dsh/font-extension.json`），Loader 行内配置优先。目录在每次页面渲染时重新扫描，添加文件无需重启。目录里可以放软链接，例如指向 `/System/Library/Fonts/Supplemental/Songti.ttc`。

## 服务方式

- URL 形状：`/dsh-fonts/<内容版本>/<文件名>[/<字面序号>]`。文件大小或修改时间变化时版本号变化，因此 immutable 缓存不会拿到旧字节。
- 响应：`200` 带字体的 media type 和 `cache-control: public, max-age=31536000, immutable`；支持 `if-none-match` 返回 `304`；除 `GET`/`HEAD` 外返回 `405`。
- 请求从不携带文件系统路径：路由只查一张由目录列表生成的键表，`..` 无法越出配置目录。
- 该路由允许匿名访问：字体是普通静态资源，且字体请求不携带页面状态。若你的部署不接受，移除插件即可。

## 取舍

- **字重与斜体来自字体文件。** 单文件家族在 `700` 时由浏览器合成粗体；放入真正的粗体字面才有清晰笔画。
- **`.ttc` 字面以未压缩 sfnt 提供**，比 `.woff2` 大；在意外体积时可用 `scripts/convert-to-woff2.py` 预先转换。
- **不会自动裁剪 CJK 字形。** 完整 Songti SC 转成 `.woff2` 约 9.5 MB；辅助脚本支持先裁剪到常用汉字。
- 仅 **Web** 版 Harness 以这种方式提供页面；Electron 桌面版装载外壳的方式不同，本插件面向 Web UI。

## 许可

插件为 MIT。插件不含任何字体：你放入目录的每个字体文件适用该字体自身的许可。
