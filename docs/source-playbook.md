# 取数手册：哪儿能拿到岗位，怎么拿

> 调研时间：2026-11-16。所有标「已实测」的接口都是本机真实发起请求验证过的，不是凭印象写的。
> 拿不到的字段一律留空并标注，系统不会编造岗位。

## 一、可用的公开接口（无需登录、无需 API Key）

这几家招聘系统把岗位列表做成了**对外的只读接口**，属于「官方接口」档，优先级最高。

| 平台 | 接口 | 实测结果 |
| --- | --- | --- |
| **Lever** | `GET https://api.lever.co/v0/postings/{company}?mode=json` | 已实测：200，`application/json`，83KB 真实岗位数组。字段 `text`（岗位名）、`categories.location`、`categories.team`、`hostedUrl`、`createdAt`、`descriptionPlain` |
| **SmartRecruiters** | `GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100` | 已实测：200，`application/json`。字段 `content[].name`、`location.city`、`refNumber`、`releasedDate`、`jobAd.sections` |
| **Greenhouse** | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | 官方文档确认（developers.greenhouse.io/job-board.html）。`{token}` 就是看板地址里那段；`content=true` 才会带完整 JD。写申请需要 Basic Auth，**读不需要** |
| **Ashby** | `GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true` | 官方文档确认（developers.ashbyhq.com/docs/public-job-posting-api） |
| **Workday** | `POST https://{tenant}.wd{n}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs`，body `{"appliedFacets":{},"limit":100,"offset":0,"searchText":""}` | 结构为公开可观察的 CXS 接口；**未在本机用真实 tenant 验证**，适配器已写但标注为待验证 |

**怎么用**：直接把上面这样的地址填进 `career_jobs_crawl` 的 `urls`。系统会先识别是不是这几个平台（`detectAts`），是的话直接走专用适配器，字段映射比通用 JSON 解析更准；不是就走通用解析。

**怎么判断一个站是不是这几家**：看域名。
- `jobs.lever.co/acme` → Lever，token = `acme`
- `jobs.ashbyhq.com/acme` → Ashby，token = `acme`
- `jobs.smartrecruiters.com/acme` → SmartRecruiters，token = `acme`
- `boards.greenhouse.io/acme` → Greenhouse，token = `acme`
- `acme.wd5.myworkdayjobs.com/External` → Workday，token = `acme/wd5/External`

## 二、不能自动采集的平台（以及为什么）

| 平台 | 结论 | 原因 |
| --- | --- | --- |
| 实习僧 / BOSS 直聘 / 牛客 / 智联 / 前程无忧 / 猎聘 | 不接入 | 未提供面向第三方的公开岗位接口；自动抓取违反平台条款与反爬规则 |
| 小红书 / 脉脉 / 知乎 / 贴吧 / 一亩三分地 | 不接入 | 需要登录，明确禁止自动化采集 |
| LinkedIn | 不接入 | 无公开岗位 API，条款禁止抓取 |

对这类平台，系统提供的是**检索链接 + 手动粘贴**：`career_social_queries` 生成关键词与各平台公开搜索链接，你打开看到的内容复制回来即可入库。

## 三、大厂校招官网（纯前端渲染）怎么取

字节、阿里、腾讯这类校招官网基本都是 **SPA**：HTML 里没有岗位数据，只有一段 JS 加载器。实测 `jobs.bytedance.com/campus` 抓取结果为 `strategy: "none"`，系统会如实报告并给出指引，不会编造。

标准解法是抓它背后的 JSON 接口，四步：

1. 打开那个**列表页**（能看到一屏岗位卡片、有筛选条件的页面，通常 `/campus`、`/campus/home`、`/jobs/list`）。
2. 按 **F12** → **Network / 网络** 面板 → 切到 **Fetch/XHR** → **Ctrl+R** 刷新。
3. 在请求列表里找名字带 `job` / `position` / `list` / `search` / `campus` 的请求，点开看 **Response** 是不是一坨 JSON、里面有没有岗位名。
4. 右键该请求 → **Copy → Copy link address**，把地址粘进 `career_jobs_crawl` 的 `urls`，`company` 填公司名。

如果接口需要签名/加密（部分站点会），就在列表页 **Ctrl+A 全选复制**，或复制单个岗位页的 JD，粘到面板「岗位雷达 → 新增岗位」的 JD 原文里——解析器会把它结构化。

## 四、取不到时系统给你的东西

`career_source_guide`（面板「岗位雷达」抓取失败时也会自动带上）：

- 识别到 ATS → 直接给**可粘贴的接口地址**
- 没识别到 → 给**精确步骤**（打开哪个 URL、F12 怎么点、复制哪一项）
- 常见雇主的**候选招聘入口**（字节/腾讯/阿里/美团/百度/京东/快手/网易/小米/华为/拼多多/小红书/B站/滴滴/联想/平安/招行/中金/德勤/普华永道…），按归一化公司名匹配，`北京字节跳动科技有限公司` 也能命中
- 一个**填空模板**，你复制后补上地址发回来即可

## 五、边界（不会做假的地方）

- 只走公开、免登录、robots 允许的页面与官方只读接口。
- 不绕过登录、验证码、访问控制、反爬；不带 Cookie；不伪装用户身份。
- 接口返回 JSON 但认不出岗位结构时，如实报「结构可能变了」，不猜。
- 拿不到的字段（地点/截止/薪酬/转正）留空并在结果里标注，不填推测值。

## 六、待验证 / 后续

1. Workday CXS 接口需要用真实 tenant 跑一次，确认 body 与返回字段。
2. 国内部分公司校招站是否有未公开但可稳定访问的 JSON 接口，需要逐个实测（不做批量探测，尊重站点）。
3. 若能拿到 `web` 搜索服务（当前会话因 `dsh-finance` 激活失败导致搜索提供方缺失），可加「搜索发现」通道自动找公司招聘入口。
