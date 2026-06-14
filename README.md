# zigbee_web

Zigbee 射频指纹识别监控面板 (Zigbee RF Fingerprint Recognition Dashboard)。

基于 React + TypeScript + Vite 构建的单页应用，用于实时监控 Zigbee 网络中的设备入网过程，通过分析 IQ 信号数据和 GAF 指纹热力图来识别和追踪 IoT 设备。

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | React 19 |
| 语言 | TypeScript |
| 构建工具 | Vite |
| 图表 | ECharts + 自定义 Canvas 热力图渲染 |
| 色图 | colormap |
| 图标 | lucide-react |

## 功能

### 实时监控面板 (Realtime Dashboard)

- **设备统计卡片** — 设备总数、待审批请求、入网许可剩余时间、网络决策模式
- **网络设备列表** — 展示已入网设备的 IEEE 地址、短地址、角色、状态、信号评分等
- **入网设备面板** — 实时显示正在尝试入网的设备及其决策状态、置信度、入网阶段
- **IQ 信号分析** — 8 种可视化图表：波形图、星座图、包络图、频谱图、自相关图、直方图、相位云图、雷达图
- **历史记录** — 最近 10 条入网记录，含 IEEE 地址、决策结果、匹配标签、时间戳、延迟
- **指纹对比** — 设备指纹与参考指纹的 GAF 热力图对比

### 离线设备库 (Offline Device Library)

- **设备列表** — 浏览已知离线设备，查看标签、IEEE 地址、设备类型、相似度评分
- **指纹查看** — 查看选中设备的双通道 GAF 指纹热力图
- **多设备对比** — 选择两个设备进行指纹对比，展示相似度评分

### 指纹详情弹窗

- 点击任意设备卡片或历史记录可打开详情弹窗
- 展示设备指标、IQ 采样曲线、主/参考指纹热力图
- 支持导出指纹快照 (JSON 格式)

## 项目结构

```
zigbee_web/
├── index.html                     # HTML 入口
├── package.json
├── vite.config.ts                 # Vite 配置
├── tsconfig.json
├── eslint.config.js
├── public/
│   ├── favicon.svg
│   └── icons.svg
└── src/
    ├── main.tsx                   # 应用入口
    ├── App.tsx                    # 主组件 (所有 UI 逻辑)
    ├── App.css                    # 主样式 (深色主题)
    ├── index.css                  # 全局样式重置
    ├── types.ts                   # TypeScript 类型定义
    ├── mockData.ts                # Mock 数据生成器
    ├── useDashboardData.ts        # 数据获取/轮询 Hook
    ├── colormap.d.ts              # colormap 类型声明
    ├── assets/
    └── components/
        └── EChartView.tsx         # ECharts 封装 + Canvas 热力图渲染组件
```

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 生产构建
npm run build

# 预览生产构建
npm run preview
```

## 连接后端

默认情况下，应用使用内置的 Mock 数据运行，无需后端。要连接到真实后端服务，设置以下环境变量：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `VITE_ENABLE_LIVE` | `'false'` | 设为 `'true'` 以启用真实后端连接 |
| `VITE_COORDINATOR_HTTP_BASE` | `'http://127.0.0.1:8787'` | 协调器 HTTP API 地址 |
| `VITE_FINGERPRINT_HTTP_BASE` | `'http://127.0.0.1:8788'` | 指纹推理服务地址 |
| `VITE_COORDINATOR_POLL_INTERVAL_MS` | `3000` | 轮询间隔 (毫秒，范围 1000-30000) |

在项目根目录创建 `.env` 文件来配置：

```env
VITE_ENABLE_LIVE=true
VITE_COORDINATOR_HTTP_BASE=http://192.168.1.100:8787
VITE_FINGERPRINT_HTTP_BASE=http://192.168.1.100:8788
```

## 后端 API

实时模式下需要以下 API 端点：

- `GET /api/v2/status` — 协调器状态
- `GET /api/v2/devices` — 设备列表
- `GET /api/v2/admissions?limit=10` — 最近入网记录
- `GET /api/v2/admissions/{admission_id}` — 入网详情 (含 IQ/GAF 数据)
- `POST /api/v1/fingerprint/reference` — 参考指纹数据
