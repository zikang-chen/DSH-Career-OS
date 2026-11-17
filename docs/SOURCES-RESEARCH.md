# 站点采集路线与真实验收

> 更新：2026-11-17，Asia/Shanghai。单元测试、公开项目研究、真实站点实测分别记录，互不代替。

## 1. 路线选择与证据边界

采用独立 Edge/Chrome profile + CDP：用户在站点正常登录，CareerOS 读取该页面自行发出的响应及可见 JD 正文。默认遵循系统代理；不生成站点签名、不处理验证码、不绕过会员限制、不自动投递或联系招聘者。

相关源码研究入口：
- [boss-zhipin-scraper](https://github.com/eatmoreduck/boss-zhipin-scraper)：README 与 CDP 核心文件支持真实浏览器会话路线；项目自述不等于本机已经跑通。
- [xhs_one_spider](https://github.com/mashukui/xhs_one_spider)：README 明确完整源码未公开。公开 GUI/方法名不能证明其内部如何签名；此前文档“确认 requests 调接口”的说法证据不足，现更正。
- [redbooks](https://github.com/xiaofuqing13/redbooks)、[xiaohongshuCrawler](https://github.com/mcxiaoxiao/xiaohongshuCrawler)：作为浏览器自动化/导出路线的参考，不声称已逐项复现。
- [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)：仅作为替代方案入口，未在 CareerOS 中安装或运行其签名实现。

浏览器登录与用户授权不是对平台条款的概括性法律判断；仍应遵守各站点规则与授权范围。

## 2. 2026-11-17 真实浏览器实测

以下为当时当前返回页的观察，不是全站总量或长期可用性保证。原始校准日志只保存在本地 `data/verification`，不提交登录资料。

| 站点 | 关键词 / 条件 | 实际结果 |
| --- | --- | --- |
| BOSS | AI产品经理 | 返回 15 条岗位；登录态在浏览器重启后保留 |
| BOSS | 产品经理＋实习 | 返回 15 条，8 条可确认实习；“产品实习生”详情取回职责 103 字、要求 95 字 |
| BOSS | 数据分析＋校招 | 返回 15 条，6 条可确认校招；包含站点推荐的非同名岗位，须继续做关键词/相关性复核 |
| 51job | 数据分析＋社招 | 通过真实搜索框提交后返回 20 条；详情职责 152 字、要求 228 字 |
| 51job | 软件开发＋校招 | 返回 20 条，4 条可确认校招；一条详情职责 210 字、要求 245 字 |
| 51job | 产品经理＋实习 | 有一次输入框/渲染超时，不能标为稳定通过；失败保留而非冒充空结果 |
| 小红书 | 腾讯 产品 面经 | 返回 20 条；一篇笔记可见文字正文 879 字（用户自述，非官方面试题） |
| 小红书 | 字节 AI产品 面经 | 返回 20 条；一篇详情只有 45 字标签，不计为已取得可用面经正文，图片/视频未OCR |
| OfferShow | 腾讯 | 操作页面“搜索公司”框后返回 24 条相关校招计划；只加 URL keyword 不生效 |
| OfferShow | 字节跳动 | 同样通过搜索框返回 14 条相关计划 |
| OfferShow | 首页薪资热榜 | 页面可见公开摘要；只保留“78”“40*16+10”等原始字符串，不猜单位、年份、岗位级别；不是完整薪资库检索 |

## 3. 关键实现

- 在 `Network.loadingFinished` 时立即取回、缓存响应，降低 requestId 被回收的概率。
- 必须经站点解析器确认，配置、SEO、推荐热榜不能冒充目标搜索响应；小红书搜索只接受 `search/notes`。
- 51job/OfferShow 通过已核实的搜索输入框提交关键词；同接口多次返回时选择最新合格响应。
- 招聘类型只接受 `campus/social/intern`。无证据为 `unknown`，不默认社招。
- 关键词补“校招/实习”是降级检索，不是已实现平台原生招聘类型过滤；返回后再逐条严格筛选，不保证遍历所有页。
- 51job/BOSS 读明确的正文 DOM 容器，拒绝登录墙、验证码、错误页与无正文标题。
- 工具和 HTTP 面板调用共用 `captureSite`，预览也可取 JD，但不写岗位/笔记/时间线；正式写入才计新增与去重。
- 6 张源卡片按组展示；BOSS、51job 等作为组内独立登录入口，不重复登记源行。最近抓取成功不等于登录永不过期。

## 4. 用法

在 CareerOS 设置→数据源中，双击卡片选择具体平台，或点击组内平台的“打开登录页”。资料保存在本机浏览器 profile，站点失效时仍需续期。

```json
{"site":"boss","keyword":"产品经理","recruitType":"intern","dryRun":true,"fillJd":true,"fillJdLimit":2}
```

```json
{"site":"xhs","keyword":"腾讯 产品 面经","dryRun":true,"bodyLimit":2}
```

```json
{"site":"offershow","keyword":"字节跳动","dryRun":true}
```

`career_job_research` 组合库内/库外 JD 候选、小红书正文与 OfferShow 计划/公开薪资摘要。岗位不唯一时返回候选，不擅自绑定。

## 5. 仍未完成或不能承诺

- 51job 每次渲染的稳定性、所有城市与全分页覆盖尚未全面验证。
- OfferShow 按指定公司/岗位检索完整薪资库未验证，会员内容不绕过；校招计划不能当薪资。
- 小红书图片/视频未做 OCR，标签或标题不当成完整面经。
- 本轮客户端完成构建和渲染回归；是否在用户当前 GUI 刷新后呈现正确，需另行验证，不能由 boot graph 或单元测试推断。
