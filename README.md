# pi-balance-gateway

**简体中文** | [English](README.en.md)

在 pi 的底部栏显示 API 中转站的钱包余额，**支持同时显示多个账号**。

只要中转站提供 `GET {base}/v1/usage` 接口就能用。不支持这个接口的站点会被自动跳过，不影响其他账号。

---

## 效果

**单个账号**，底部栏显示：

```
余额 $47.35
```

**多个账号**，一行并排：

```
主号 $47.35 · 备号 $0.09 · 小号 $24.25
```

某个账号查询失败时只影响它自己：

```
主号 $47.35 · 备号 ?
```

---

## 安装

```bash
pi install npm:pi-balance-gateway
```

想先试用一次、不写进配置：

```bash
pi -e npm:pi-balance-gateway
```

也可以从 git 安装（方便先看源码）：

```bash
pi install git:github.com/SweetDeathh/pi-balance-gateway
```

---

## 开箱即用，不用配置

扩展直接读 `~/.pi/agent/models.json` 里你已经配好的 `baseUrl` 和 `apiKey`。

**你已经为 pi 配好的东西，它直接复用，不用再填一遍 key。**

首次启动时自动完成：

1. 扫描所有带 `baseUrl` + `apiKey` 的 provider
2. 并发探测 `GET {base}/v1/usage`
3. 只保留有响应的，同域自动去重（`example.com` 与 `www.example.com` 视为同一个钱包）
4. 结果缓存到 `~/.pi/agent/balance.json`

全程无弹窗、不用改任何文件。

---

## 选择显示哪些账号

```
/balance setup
```

会先探测一遍，然后给出勾选列表，按回车切换，选「保存并关闭」生效：

```
勾选要显示余额的账号（可反复切换，不可用的会显示 ?）
> [x] 主号        $47.35
  [x] 备号        $0.09
  [x] 小号        $24.25
  [ ] 某个站点    ✗ 返回非 JSON (404)
  ── 保存并关闭 ──
```

保存后立即按新选择刷新底部栏。

---

## 命令

| 命令 | 作用 |
|---|---|
| `/balance` | 报告全部账号（含最近用量、模型 Top 3） |
| `/balance setup` | 交互式勾选要显示的账号 |
| `/balance probe` | 重新探测，保留所有可用账号 |
| `/balance list` | 查看当前选择 |
| `/balance add [名称]` | 添加账号；不给名字时弹出选择器 |
| `/balance remove <名称>` | 移除账号 |

---

## 给模型用的工具

注册 `check_balance` 工具，你问「余额还有多少」时模型可以主动调用。

返回结构化的 `details.accounts[]`，并对 `daily_usage` / `model_stats` 各裁剪到最近 5 条，避免把上下文刷爆。

---

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_BALANCE_API_KEY` | 直接用这个 key，跳过 `models.json` |
| `PI_BALANCE_BASE_URL` | 配合上面那个 key 的网关地址（两者需同时设置） |
| `PI_BALANCE_PROVIDERS` | 逗号分隔的 provider 名，覆盖 `balance.json` |
| `PI_BALANCE_LOW` | 低余额阈值，默认 `5` |

---

## 刷新策略

- 正常每 5 分钟一次
- **最低**余额低于阈值时改为每分钟一次
- 会话启动时查一次，每轮对话结束后按需刷新
- 多账号并行查询，耗时取最慢的一个，不是累加

---

## 数据与隐私

`~/.pi/agent/balance.json` 只记录要显示哪些账号，**不含任何密钥**：

```json
{
  "providers": [
    { "name": "某个 provider 名", "label": "主号" },
    { "name": "另一个 provider 名", "label": "备号" }
  ]
}
```

`name` 必须是 `models.json` 里已有的 provider 名；`label` 是底部栏短名，可省略。

密钥始终只存在于 `models.json`，本扩展**不复制、不写出、不上传**。查询只发往你自己配置的网关地址。

---

## 许可

MIT
