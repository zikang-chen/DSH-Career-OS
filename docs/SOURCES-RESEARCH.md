# 数据采集调研结论：小红书 / BOSS直聘 / 前程无忧 / OfferShow

> 调研时点：2026-11-17。方法：读各项目 README 与源码文件结构（GitHub API），
> 不照搬任何破解签名的实现。结论用于决定 CareerOS 采用哪条技术路线。

## 一、市面上大致三类实现

| 类型 | 代表项目 | 做法 | 主要问题 |
| --- | --- | --- | --- |
| **A. 浏览器自动化 / CDP** | `eatmoreduck/boss-zhipin-scraper`（★，MIT）、`xiaofuqing13/redbooks`（DrissionPage）、`creatorhub`（Playwright）、`mcxiaoxiao/xiaohongshuCrawler`（油猴+Python） | 打开真实浏览器，复用用户登录态，读页面/DOM/接口 | 慢、量小；但最贴近“用户自己看”的合规边界 |
| **B. 私有 API + 签名逆向** | `mashukui/xhs_one_spider`（GUI，cookie 调接口）、`NanmiCoder/MediaCrawler`（Playwright + JS 逆向 x-s/x-t）、`lixi5338619/lxSpider` | 逆向 `seccore_signv2`/`x-s` 签名，本地补环境生成签名后直接打接口 | 违反平台访问控制、易失效、法律风险高 |
| **C. 第三方托管 API** | `TikHub-API-Python-SDK` 等付费服务 | 买别人封装好的接口 | 付费、数据合规责任转嫁、不可控 |

**关键事实**：`boss-zhipin-scraper` 的 README 明确写「不用 Selenium/Playwright，直接通过 Chrome DevTools Protocol
连接本地已登录的 Chrome，复用真实登录态调搜索 API，绕过前端字体反爬」，核心文件是 `scripts/boss_cdp_raw.py`（125KB），
接口为 `/wapi/zpgeek/search/joblist.json`，并有 `MAX_PAGES=20 / MAX_API_REQUESTS=500` 的频控。

`xhs_one_spider` 是闭源 GUI（完整源码不公开），README 说「通过接口协议采集，不依赖模拟浏览器」，
源码里 `self.cookie = self.get_cookie()` 后用 requests 调 web 接口——签名部分未开源，属于 B 类。

## 二、CareerOS 的选择：A 类（CDP 复用登录态）

理由：

1. 我们**不破解签名**、不绕过登录，只用用户自己已登录的浏览器发页面自身的请求；
2. 与已有 `career_browser_capture`（腾讯校招已验证 10 条）同一套代码，零新增依赖；
3. 求职场景要的是“少量、高价值、需人工判断”的信息，不需要百万级爬取，慢不是问题；
4. 出问题时可解释：失败就返回登录指引或候选响应，不假装成功。

## 三、落地：`career_site_capture`

| site | 站点 | 抓什么 | 落库到 |
| --- | --- | --- | --- |
| `xhs` | 小红书 | 笔记标题/正文/作者/点赞/链接 | 资料库（forum_post，面经线索） |
| `boss` | BOSS直聘 | 岗位名/公司/城市/薪资/链接 | 岗位库（UNVERIFIED） |
| `51job` | 前程无忧 | 岗位名/公司/地区/薪资/链接 | 岗位库（UNVERIFIED） |
| `offershow` | OfferShow | 公司/岗位/薪资/城市/学历/年份 | 预览为主（C 级证据） |

使用：先 `career_browser_login` 登录 → 在页面搜一次让列表出现 → `career_site_capture {site, keyword, useOpenTab:true}`。
默认 `dryRun=true` 只预览，确认后 `dryRun=false` 才写入。

## 四、已知限制（诚实记录）

- 各站点前端结构会变，解析器按常见字段名做容错；抓错会回显 `responseShape`，方便换请求。
- 小红书 `x-s` 签名由页面自身生成，我们**不实现**本地签名；因此必须在真实浏览器里操作。
- OfferShow 主入口是小程序，Web 端存在但可能需登录；抓不到时用 `useOpenTab` 或手动粘贴。
- 批量/高频抓取不做（违反平台条款且易封号）；单页低频、串行。
- 所有采集内容属用户生成/第三方爆料，证据等级 C，不能当官方事实。
