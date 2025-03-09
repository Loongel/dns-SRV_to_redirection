# Cloudflare Worker - SRV 跳转 + 资源汇总门户

## 功能概述

本项目是一个基于Cloudflare Worker的SRV记录跳转和资源汇总门户系统，主要功能包括：

1. **SRV记录自动跳转**
   - 支持HTTP/HTTPS服务自动跳转
   - 支持非Web服务（SSH/SFTP/RDP等）信息展示
   - 自定义跳转状态码（301/302/307/308）

2. **资源汇总门户**
   - 密码保护的管理界面
   - 实时展示所有SRV记录
   - 动态修改跳转方式

3. **泛域名支持**
   - 支持通配符域名配置（如 *.example.com）
   - 自动处理子域名跳转

## 使用说明

### 环境变量配置

| 变量名 | 说明 | 示例 |
|--------|------|------|
| DOMAINS | 逗号分隔的域名列表，支持通配符 | "*.nat.example.com,d1.example.com" |
| PORTAL_DOMAIN | 门户域名 | "portal.example.com" |
| CF_API_TOKEN | Cloudflare API Token | "your_api_token" |
| CF_ZONE_ID | Cloudflare Zone ID | "your_zone_id" |
| PORTAL_PASSWD | 门户页面密码 | "your_password" |
| DEBUG_MODE | 调试模式 | "true" |
| DEFAULT_REDIRECT_STATUS | 默认跳转状态码 | "302" |

### 功能缺陷说明

* 没有使用KV缓存，所以跳转方式、跳转地址数据均未保存，修改无效，效率低下：

* 当访问的域名没有显式地在Cloudflare Worker自定义域名中添加时，Cloudflare不会正确提供证书，导致HTTPS访问出错。解决方案：

   1. (推荐) 使用HTTP访问
      - 跳转后的服务可以是HTTPS
      - 无安全风险
      - 示例：`http://xxx.example.com`

   2. (推荐) 通过浏览器F12 在Cloudflare Worker自定义域名中添加泛域名* 
      1. 在调试工具中，切换到“网络”，然后再Cloudflare Worker自定义域名中添加任意域名
      2. 过滤url中搜索`workers/domains/records` 找到POST的记录，右键点击编辑并重发，再最下的“消息体”中，找到hostname,改为目标域名即可

   3. 在Cloudflare Worker自定义域名中添加
      - 解决HTTPS证书问题
      - 适用于必须使用HTTPS的场景




## 使用案例

### 场景1：Web服务跳转
访问 `http://web.example.com` 将跳转到 `http://backend-server:8080`

### 场景2：非Web服务展示
访问 `ssh.example.com` 将展示SSH连接信息：
```
ssh://backend-server:port
```

### 场景3：门户管理
访问 `portal.example.com` 输入密码后：
- 查看所有服务状态（无效）
- 修改跳转方式（无效）

## 注意事项

1. 确保所有目标服务已正确配置
2. 门户密码应定期更换
3. 调试模式仅用于开发环境
4. 跳转状态码选择：
   - 301：永久跳转
   - 302：临时跳转（默认）
   - 307/308：保持请求方法

## 部署步骤

1. 部署到Cloudflare
   1. 复制到网页worker.js
   2. wrangler
   ```bash
   wrangler publish
   ```

2. 测试功能
```bash
curl http://your-worker-domain
```

## 维护指南

1. 定期检查SRV记录缓存
2. 监控Worker执行日志
3. 及时更新依赖包