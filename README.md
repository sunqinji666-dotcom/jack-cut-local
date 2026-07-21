<div align="center">

# Jack Cut Local

![Project visual](docs/assets/hero-system-v1.png)

### 视频留在你的电脑上，粗剪不必把素材交给服务器。

**Privacy-first local video rough-cutting in the browser.**

Built by **Jacksun**

</div>

## 为什么做它

Jack Cut Local 是一个纯前端的视频粗剪工具：选择视频、切分片段、调整画幅、预览并导出，全部在浏览器本地完成。静态站点只负责把应用页面发到你的电脑，**不会接收、上传、保存或分析你的原始素材**。

适合需要快速整理机位、做竖版裁切、拼接片段或在正式进剪辑软件前先完成结构验证的创作者。

## 功能

- 本地导入常见视频格式
- 浏览器本地项目与最近项目记录
- 多片段简易时间线与顺序调整
- 16:9、9:16、1:1、4:5 等画幅裁切
- 缩放与画面位置调整
- 基于 `ffmpeg.wasm` 的本地 MP4 导出
- 持久化存储提示与导出历史

## 隐私边界

| 本地处理 | 不会发生 |
| --- | --- |
| 视频导入、预览、裁切、导出 | 上传素材到服务端 |
| 项目与导出记录 | 服务端保存项目数据 |
| `ffmpeg.wasm` 编码 | 通过 CDN 发送视频内容 |

请注意：浏览器本地存储受浏览器的清理策略影响；重要项目仍应保留原始素材和导出文件。

## 本地运行

无需 Node 依赖。需要 Python 3：

```bash
git clone https://github.com/sunqinji666-dotcom/jack-cut-local.git
cd jack-cut-local
npm run dev
```

打开 <http://localhost:4173>。

也可以将整个目录部署为静态网站；发布时请保留 `vendor/ffmpeg/`。

## 检查

```bash
npm test
```

该检查验证隐私文案、作者署名与导出入口仍存在。实际视频编解码兼容性取决于浏览器和本地 `ffmpeg.wasm` 运行时。

## 贡献

欢迎提交界面、可访问性、浏览器兼容性和本地剪辑体验的改进。请不要提交真实客户素材、视频文件、浏览器项目库或任何 API Key。

## 许可

本项目采用 [MIT License](LICENSE) 开源。你可以自由使用、修改、商业使用和再次发布，但须保留版权和许可声明。

Contact: Jacksun · qinji@jack-sun.com

Copyright © 2026 Jacksun
